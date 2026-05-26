import 'server-only';
import { z } from 'zod';
import { sql } from 'drizzle-orm';

import { db } from '@/lib/db/client';
import { outboundAudit } from '@/lib/db/schema';
import { sanitizeError } from '@/lib/security/scrub';
import type { Provider } from '@/lib/llm/providers';

// ---------------------------------------------------------------------------
// Shared helpers for the two-step Stock Picker:
//   POST /api/picker/scan    — Tavily fan-out, saves articles to picker_jobs.
//   POST /api/picker/analyze — reads articles, runs the LLM with FULL context.
//
// Lives in lib/* (NOT under app/api/.../route.ts) because Next.js limits route
// modules to a fixed set of named exports — any extra export trips
// "Property X is not assignable to type 'never'" during typecheck. Importing
// from a route module would also force the picker_jobs INSERT side and the
// LLM side to share a bundle, which is exactly the split we're trying to
// avoid for cold-start latency.
// ---------------------------------------------------------------------------

// ---------- Markets ----------

export const MARKETS = ['US', 'HK', 'CN', 'TH', 'JP', 'KR', 'UK', 'DE', 'FR', 'TW'] as const;
export type Market = (typeof MARKETS)[number];

// Human-readable label that web queries actually rank well for. "US" alone
// matches nothing useful — "United States stocks" / "NYSE / Nasdaq" do.
export const MARKET_LABEL: Record<Market, string> = {
  US: 'United States (NYSE / Nasdaq)',
  HK: 'Hong Kong (HKEX)',
  CN: 'China A-shares (Shanghai / Shenzhen)',
  TH: 'Thailand (SET)',
  JP: 'Japan (Tokyo Stock Exchange)',
  KR: 'South Korea (KOSPI / KOSDAQ)',
  UK: 'United Kingdom (London Stock Exchange)',
  DE: 'Germany (XETRA / Frankfurt)',
  FR: 'France (Euronext Paris)',
  TW: 'Taiwan (TWSE)',
};

// Per-market exchange whitelist surfaced into the prompt so the model is
// hard-anchored to producing tradeable tickers on the right venue.
export const MARKET_EXCHANGES: Record<Market, string[]> = {
  US: ['NYSE', 'NASDAQ', 'AMEX'],
  HK: ['HKEX'],
  CN: ['SSE', 'SZSE'],
  TH: ['SET'],
  JP: ['TSE'],
  KR: ['KRX', 'KOSPI', 'KOSDAQ'],
  UK: ['LSE'],
  DE: ['XETRA', 'FWB'],
  FR: ['EPA', 'Euronext Paris'],
  TW: ['TWSE'],
};

// ---------- Stock types ----------

export const STOCK_TYPES = [
  'growth',
  'value',
  'dividend',
  'garp',
  'quality',
  'momentum',
  'defensive',
  'cyclical',
  'small_cap',
  'mid_cap',
  'large_cap',
  'speculative',
  'income',
  'turnaround',
  'emerging_tech',
  'esg',
] as const;
export type StockType = (typeof STOCK_TYPES)[number];

export const RISK_TOLERANCES = ['low', 'medium', 'high', 'aggressive'] as const;
export type RiskTolerance = (typeof RISK_TOLERANCES)[number];

export const RISK_MIN_PROTECTION: Record<RiskTolerance, number> = {
  low: 70,
  medium: 40,
  high: 20,
  aggressive: 0,
};

// ---------- Request body ----------

export const BodySchema = z
  .object({
    market: z.enum(MARKETS).nullable().optional(),
    customCountries: z.array(z.string().min(1).max(80)).max(10).optional(),
    autoPickMarket: z.boolean().optional(),
    sectors: z.array(z.string().min(1).max(80)).min(1).max(5),
    stockTypes: z.array(z.enum(STOCK_TYPES)).max(3).optional(),
    riskTolerance: z.enum(RISK_TOLERANCES).optional(),
  })
  .refine(
    (v) =>
      (v.market !== null && v.market !== undefined) ||
      (v.customCountries && v.customCountries.length > 0) ||
      v.autoPickMarket === true,
    {
      message:
        'one of `market`, `customCountries`, or `autoPickMarket` must be provided',
      path: ['market'],
    },
  );

export type PickerScanBody = z.infer<typeof BodySchema>;

// ---------- Response schema (drives generateObject in /api/picker/analyze) ----------

// Source-URL refinement happens at generate-time once we know the article
// list; the base schema enforces shape + boundaries.
// IMPORTANT: schema is intentionally LOOSE on validation bounds.
//
// Mistral Medium uses "soft" JSON mode — the schema's .min()/.max() bounds
// are NOT enforced by the model at generation time, only by Zod after the
// fact. Tight bounds cause "No object generated: response did not match
// schema" failures roughly 30% of the time on this prompt shape. The
// `.describe()` text is what actually steers the model.
//
// Strategy: keep the schema PERMISSIVE so the model rarely fails validation,
// then normalize values in post-processing (clamp scores to 0-100, round to
// int, drop cards with bad URLs). Self-heal in generateObjectWithSelfHeal
// catches the rare hard failure and asks Mistral to fix its own output.
export const StockCardSchema = z.object({
  symbol: z.string().min(1).max(20).describe('Ticker symbol as it trades on the requested market.'),
  exchange: z.string().min(1).max(20).describe('Exchange code — must belong to the requested market.'),
  name: z.string().min(1).max(200).describe('Full company name.'),
  industry: z.string().min(1).max(160).describe('GICS-level industry / sub-industry.'),
  industryContext: z
    .string()
    .min(1)
    .max(800)
    .describe('~50-word paragraph framing the industry trend right now.'),
  financialStatus: z
    .string()
    .min(1)
    .max(500)
    .describe('One or two sentences on revenue trend, margins, balance sheet health, or growth.'),
  performance: z
    .object({
      '1m': z.number().nullable().optional(),
      '3m': z.number().nullable().optional(),
      '1y': z.number().nullable().optional(),
      note: z.string().max(300).optional(),
    })
    .nullable()
    .optional()
    .describe('Percent returns when known. Use null + a note field if uncertain — never invent.'),
  upcomingEvents: z
    .array(
      z.object({
        date: z.string().describe('ISO date YYYY-MM-DD if known, or a coarse label like "Q3 2026".'),
        title: z.string().min(1).max(250),
      }),
    )
    .max(10)
    .describe('Earnings, product launches, regulatory decisions, expirations, etc.'),
  // Dropped .int() — Mistral often emits 83.5 instead of 83; clamp+round
  // in post-processing. Loose bounds give -1000..1000 headroom — clamp in
  // post-processing.
  boomProbability: z
    .number()
    .describe(
      'Calibrated 0-100 estimate. Most picks should land 30-60. Reserve >75 for stocks with multiple imminent catalysts AND strong evidence.',
    ),
  boomTriggers: z
    .array(z.string().min(1).max(300))
    .min(1)
    .max(10)
    .describe('Concrete catalysts that could drive the move — each must be supported by a cited article.'),
  riskProtection: z
    .number()
    .describe('Higher = SAFER. 80-100 large-cap blue-chip, 60-79 mid-cap, 40-59 small-cap profitable, 20-39 fragile, 0-19 distressed.'),
  riskWhy: z.string().min(1).max(500).describe('Brief explanation of the risk score, anchored in evidence.'),
  consensus: z
    .string()
    .min(1)
    .max(250)
    .describe('Analyst consensus, e.g. "8 Buy / 3 Hold / 1 Sell, avg target $185". Use "n/a" if not in sources.'),
  // Dropped .url() — Mistral often emits URLs without scheme or with trailing
  // markdown chars. Post-processing filters against the article URL set
  // anyway, so strict URL validation here just trashes good cards.
  sources: z
    .array(z.string().min(4))
    .min(1)
    .max(5)
    .describe('1-3 URLs from the provided article list that back this card.'),
});

export type StockCard = z.infer<typeof StockCardSchema>;

export const ResultSchema = z.object({
  // We ask for 6 but allow fewer for strict-risk filters that can't fill them.
  cards: z.array(StockCardSchema).min(1).max(6),
});

// ---------- News fan-out ----------

// Canonical shape for an article excerpt we got back from Tavily. The scan
// step persists an array of these into picker_jobs.articles; analyze reads
// them back and feeds them straight into the prompt.
export interface Article {
  url: string;
  title: string;
  content: string;
  publishedDate?: string;
}

// ---------- LLM provider fallback ----------
//
// Each model is called AT MOST ONCE per analyze request. No same-model
// self-heal retries (user spec — they ate the 55s watchdog without
// reliably fixing things). The chain ESCALATES through different models
// so a schema failure on one model has a real chance of succeeding on
// the next, instead of retrying the same weak constraint.
//
// Order rationale (user spec — "always mistral first"):
//   1. mistral-medium-latest  — user's preferred default, cheapest Mistral that handles 12-article context well.
//   2. mistral-large-latest   — bigger Mistral, follows schema constraints more reliably.
//   3. mistral-small-latest   — sometimes a smaller model paradoxically obeys structure better; also cheap.
//   4. openai gpt-4o-mini     — cheap OpenAI with strict json_schema mode (constrained decoding, can't fail validation).
//   5. openai gpt-4o          — last resort. Strict mode + most capable. Always succeeds.
//
// Hard cap of 5 entries — user spec ("total never exceed 5 call").
export const PROVIDER_CHAIN: Array<{ provider: Provider; modelId: string }> = [
  { provider: 'mistral', modelId: 'mistral-medium-latest' },
  { provider: 'mistral', modelId: 'mistral-large-latest' },
  { provider: 'mistral', modelId: 'mistral-small-latest' },
  { provider: 'openai', modelId: 'gpt-4o-mini' },
  { provider: 'openai', modelId: 'gpt-4o' },
];

export const PROVIDER_HOST: Record<Provider, string> = {
  openai: 'api.openai.com',
  anthropic: 'api.anthropic.com',
  google: 'generativelanguage.googleapis.com',
  mistral: 'api.mistral.ai',
  moonshot: 'api.moonshot.ai',
  deepseek: 'api.deepseek.com',
};

export async function recordAudit(
  kind: string,
  host: string,
  status: number | null,
  latencyMs: number,
): Promise<void> {
  try {
    await db.insert(outboundAudit).values({ kind, host, status, latencyMs });
  } catch (err) {
    console.error('[picker] audit insert failed:', sanitizeError(err));
  }
}

// ---------- SSE helpers ----------

type SseEventName = 'phase' | 'result' | 'error';

export function sseFormat(event: SseEventName, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

export function sseDone(): string {
  // Terminator the client uses to know the stream is intentionally closed.
  return `data: ${JSON.stringify({ done: true })}\n\n`;
}

export interface SseEmitter {
  phase: (
    name: string,
    detail: string,
    extra?: Record<string, unknown>,
  ) => void;
  result: (data: unknown) => void;
  error: (message: string, phase: string, kind: string) => void;
  end: () => void;
}

// ---------- Auto-pick market helper ----------

// Map a free-form market string (from autoPickMarkets or customCountries)
// to a (label, allowedExchanges) tuple. Unknown country names get a
// generic label and an empty exchange whitelist — the LLM is instructed
// to use major listed exchanges in that country.
export function resolveMarketLabel(input: string): {
  label: string;
  exchanges: string[];
} {
  const norm = input.trim();
  const upper = norm.toUpperCase();
  if ((MARKETS as readonly string[]).includes(upper)) {
    const m = upper as Market;
    return { label: MARKET_LABEL[m], exchanges: MARKET_EXCHANGES[m] };
  }
  return { label: norm, exchanges: [] };
}

// ---------- Tavily query builder ----------

export function buildQueries(marketLabel: string, sectors: string[]): string[] {
  // Capped at 4 to fit the 60s Hobby plan budget. Parallel fan-out makes
  // 4 calls ~5-8s. One generic "what's hot" + up to 3 sector-specific
  // queries; sector queries are richer signal so they win when there's a
  // conflict.
  const generic = `top ${marketLabel} stocks to watch 2026 strong buy upcoming catalysts`;
  const perSector = sectors.map(
    (s) => `best ${s} stocks ${marketLabel} 2026 analyst consensus catalysts`,
  );
  return [generic, ...perSector].slice(0, 4);
}

// ---------- Shared prompt builder ----------
//
// Both routes call this so the system + user prompt text is identical
// regardless of where the LLM call lives. `articles` carries the FULL
// 1000-char excerpts the scan step persisted — the user explicitly wants
// long context, and Mistral Medium's 32K window fits ~12 such excerpts
// plus the system rules with room to spare.
export function buildPickerPrompt(args: {
  articles: Article[];
  sectors: string[];
  stockTypes: StockType[];
  riskTolerance: RiskTolerance;
  primaryMarketLabel: string;
  allowedExchanges: string[];
}): { systemPrompt: string; userPrompt: string } {
  const { articles, sectors, stockTypes, riskTolerance, primaryMarketLabel, allowedExchanges } =
    args;

  const articleBlock = articles
    .map(
      (a, i) =>
        `[#${i + 1}] ${a.title}\n  URL: ${a.url}\n  ${
          a.publishedDate ? `Date: ${a.publishedDate}\n  ` : ''
        }${a.content.replace(/\s+/g, ' ').slice(0, 1000)}`,
    )
    .join('\n\n');

  const stockTypesStr = stockTypes.length > 0 ? stockTypes.join(', ') : 'any';
  const minRiskProtection = RISK_MIN_PROTECTION[riskTolerance];

  // FIRST-CALL DISCIPLINE: this prompt is engineered so Mistral Medium's
  // very first call succeeds. The OUTPUT FORMAT block at the top is repeated
  // verbatim by intent — Mistral's "soft" JSON mode benefits from the rules
  // being stated both early AND late in the prompt. The schema's
  // .describe() text on each field handles per-field shape; this block
  // handles meta-level discipline (no markdown, exact URLs, integers, etc.).
  const systemPrompt =
    `You are a SKEPTICAL stock analyst.\n\n` +
    `==========  OUTPUT FORMAT (READ FIRST, OBEY EXACTLY)  ==========\n` +
    `• Output ONE raw JSON object that exactly matches the provided schema. NOTHING ELSE.\n` +
    `• NO markdown. NO \`\`\`json fences. NO preamble. NO trailing prose. JSON ONLY.\n` +
    `• Numbers are integers in 0-100 unless the schema says otherwise. Never write 83.5 — write 83.\n` +
    `• Every URL in a \`sources\` array is a literal copy from the input article list. Do not edit, shorten, or invent URLs.\n` +
    `• Cap arrays at the schema's max. If unsure, emit FEWER items, not more.\n` +
    `• Any free-text field: keep concise but ≥1 character — never empty string.\n` +
    `• If you cannot satisfy a constraint with the supplied articles, emit fewer cards. Never pad with low-quality picks.\n` +
    `=================================================================\n\n` +
    `ANALYSIS RULES:\n\n` +
    `1. EVIDENCE > NARRATIVE. Every claim MUST trace back to one of the articles ` +
    `you were given. If an article doesn't support a claim, do NOT make it.\n` +
    `2. Boom probability is a CALIBRATED estimate, not marketing copy. Most ` +
    `stocks should be in the 30-60% range. Reserve >75% for stocks with ` +
    `multiple imminent (next 30 days) catalysts AND strong supporting ` +
    `evidence. Reserve <30% for stocks where you found mostly negative or ` +
    `no-signal news.\n` +
    `3. Risk protection is HIGHER = SAFER. Calibrate:\n` +
    `   - 80-100: large-cap blue-chip with diversified revenue, low debt, profitable\n` +
    `   - 60-79: mid-cap with positive cash flow but some concentration risk\n` +
    `   - 40-59: small-cap profitable OR mid-cap unprofitable\n` +
    `   - 20-39: small-cap unprofitable, high beta, single-product, or recent dilution\n` +
    `   - 0-19: pre-revenue, distressed balance sheet, or major litigation\n` +
    `4. Risk tolerance ${riskTolerance} adjusts the FILTER, not the rating:\n` +
    `   - low: only suggest stocks with risk_protection >= 70 (or you can't fill all 6 — emit fewer)\n` +
    `   - medium: risk_protection >= 40\n` +
    `   - high: risk_protection >= 20\n` +
    `   - aggressive: no minimum; explicitly include 1-2 speculative high-upside picks\n` +
    `   For this run, every card you emit MUST have risk_protection >= ${minRiskProtection}. ` +
    `If you cannot find 6 such stocks in the supplied articles, emit fewer — never pad.\n` +
    `5. Stock types ${stockTypesStr} filter: each card must have an ` +
    `\`industry\` and \`name\` that plausibly fits one of these types. If none ` +
    `listed, optimize for the user's risk tolerance.\n` +
    `6. Each card's \`sources\` array must contain 1-3 ACTUAL URLs from the input ` +
    `article list. Never invent URLs.\n` +
    `7. NEVER fabricate ticker symbols. If you're unsure about a ticker, drop the ` +
    `stock and surface a different one.\n\n` +
    `Target market(s): ${primaryMarketLabel}.\n` +
    (allowedExchanges.length > 0
      ? `Allowed exchanges: ${allowedExchanges.join(', ')}. Every \`exchange\` field must come from this list.\n`
      : `Use the major listed exchanges in the target country (verify the ticker actually trades there).\n`) +
    `\nREMINDER: output ONE raw JSON object only. No markdown fences. Integers for numeric fields. Verbatim URLs from the article list.`;

  const userPrompt =
    `Market(s): ${primaryMarketLabel}\n` +
    (allowedExchanges.length > 0
      ? `Allowed exchanges: ${allowedExchanges.join(', ')}\n`
      : '') +
    `Sectors of interest: ${sectors.join(', ')}\n` +
    `Stock-type filters: ${stockTypesStr}\n` +
    `Risk tolerance: ${riskTolerance} (minimum risk_protection ${minRiskProtection})\n\n` +
    `Articles consulted (cite by URL — these are the ONLY URLs you may put in the per-card sources arrays):\n\n${articleBlock}\n\n` +
    `Produce up to 6 stock cards. Diversify across sectors when multiple were requested. Anchor every claim to the article list above. ` +
    `Emit fewer cards if the evidence or risk filter doesn't justify 6.`;

  return { systemPrompt, userPrompt };
}

// ---------- Self-healing picker_jobs guard ----------
//
// Why this exists: `ensureSchema()` is fire-and-forget (returns immediately,
// runs ~90 bumps in the background). The very first picker request after a
// new deploy can race the bumper and try to INSERT into picker_jobs before
// CREATE TABLE has run — Postgres then throws `relation "picker_jobs" does
// not exist` and the whole scan flow dies with an opaque "db_insert_failed".
//
// Mirroring the same CREATE TABLE IF NOT EXISTS that ensure-schema runs
// is cheap (~10ms on Neon HTTP), idempotent, and removes the race entirely.
// Memoized per-process via globalThis so we don't pay the round-trip on
// every request once the bumper has caught up.
//
// Keep this DDL bit-for-bit identical to apps/web/lib/db/ensure-schema.ts §5.
declare global {
  // eslint-disable-next-line no-var
  var __pickerJobsTableEnsured: Promise<void> | undefined;
}

// ---------- Article sanitizer ----------
//
// Postgres `jsonb` rejects strings containing the Unicode null character
// ( ) with SQLSTATE 22P05 "unsupported Unicode escape sequence". Tavily
// returns content scraped from arbitrary web pages — PDF text layers, HTML
// fragments, scraped tables — and those frequently smuggle in NULs and other
// disallowed control bytes. The INSERT then dies and the whole picker scan
// is wasted (Tavily quota burned for nothing).
//
// Strip every C0 control char except the three that are actually printable
// (\t \n \r) AND the U+FFFE / U+FFFF non-characters that JSON.stringify
// happily passes through but jsonb rejects. Trim to a generous cap so a
// single runaway article can't push the row past Neon's row-size limit.
//
// Idempotent and cheap (single regex sweep per field).
//
// Built via `new RegExp` from explicit \uXXXX escapes so the source file
// never contains the literal control bytes (which break some editors,
// grep, and the codepoints can even round-trip differently through
// different Git autocrlf settings).
// eslint-disable-next-line no-control-regex
const CTRL_RE_SAFE = new RegExp(
  '[\\u0000-\\u0008\\u000B\\u000C\\u000E-\\u001F\\u007F\\uFFFE\\uFFFF]',
  'g',
);
function scrubForJsonb(s: string | null | undefined, max = 4000): string {
  if (!s) return '';
  return s.replace(CTRL_RE_SAFE, '').slice(0, max);
}

export function sanitizeArticlesForJsonb(articles: Article[]): Article[] {
  return articles.map((a) => ({
    ...a,
    url: scrubForJsonb(a.url, 500),
    title: scrubForJsonb(a.title, 300),
    content: scrubForJsonb(a.content, 4000),
    publishedDate: scrubForJsonb(a.publishedDate, 100),
  }));
}

export function ensurePickerJobsTable(): Promise<void> {
  if (!globalThis.__pickerJobsTableEnsured) {
    globalThis.__pickerJobsTableEnsured = (async () => {
      await db.execute(sql`CREATE TABLE IF NOT EXISTS picker_jobs (
        id serial PRIMARY KEY,
        user_id integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        status text NOT NULL DEFAULT 'searching',
        params jsonb NOT NULL,
        articles jsonb,
        cards jsonb,
        sources jsonb,
        error text,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      )`);
      await db.execute(
        sql`CREATE INDEX IF NOT EXISTS picker_jobs_user_created_idx ON picker_jobs (user_id, created_at DESC)`,
      );
    })().catch((err) => {
      // Reset memo so the next request retries — never strand the user on a
      // transient DDL hiccup.
      globalThis.__pickerJobsTableEnsured = undefined;
      throw err;
    });
  }
  return globalThis.__pickerJobsTableEnsured;
}

// ---------- Verbose DB-error formatter ----------
//
// Drizzle wraps the Neon error so `.message` is `Failed query: insert into
// ... params: ...` with the FULL parameter dump inline. The picker insert
// has a multi-KB articles jsonb payload, so the message alone can blow past
// Vercel's log line size limit and truncate every field after it.
//
// Field order matters: diagnostic fields come FIRST so PG `code` / `detail`
// / `column` / `constraint` survive even if the `message` is truncated. We
// also strip the inline `params: ...` suffix to keep the message compact.
export function formatDbError(err: unknown): Record<string, unknown> {
  const e = err as Record<string, unknown> | null | undefined;
  // Drizzle wraps the underlying NeonDbError on .cause; that's where the
  // PG fields actually live. Fall through to the outer error as backup.
  const cause = (e?.cause ?? null) as Record<string, unknown> | null;
  const raw = sanitizeError(err).message;
  // Drop the `params: ...` tail — keeps the SQL skeleton visible without
  // dragging the full jsonb payload into the log.
  const message = raw.split('\nparams:')[0]?.slice(0, 600) ?? raw;
  return {
    // Diagnostic fields first — survive truncation.
    code: cause?.code ?? e?.code ?? null,
    detail: cause?.detail ?? e?.detail ?? null,
    hint: cause?.hint ?? e?.hint ?? null,
    column: cause?.column ?? e?.column ?? null,
    constraint: cause?.constraint ?? e?.constraint ?? null,
    table: cause?.table ?? e?.table ?? null,
    severity: cause?.severity ?? e?.severity ?? null,
    routine: cause?.routine ?? e?.routine ?? null,
    // Compact message last.
    message,
  };
}

// ---------- Post-LLM card normalizer ----------
//
// The Zod schema is intentionally permissive so Mistral's "soft" JSON mode
// doesn't trip on every off-by-one issue (see StockCardSchema comment).
// Here we re-tighten the values that actually need to be sane: clamp scores
// to 0-100, round to int, strip trailing markdown chars from URLs.
//
// Returns null if the card is so broken that no amount of normalization
// can save it (e.g. completely missing URL list).
export function normalizeStockCard(card: StockCard): StockCard | null {
  const clampInt = (n: number, lo = 0, hi = 100) =>
    Math.max(lo, Math.min(hi, Math.round(n)));
  const cleanedSources = card.sources
    .map((u) =>
      String(u)
        .trim()
        // Strip common LLM-emit junk: trailing markdown parens, brackets,
        // surrounding quotes, leading "URL:" / "source:" labels.
        .replace(/^["'(\[<]+|["')\]>]+$/g, '')
        .replace(/^(?:url|source|link)\s*[:=]\s*/i, '')
        .trim(),
    )
    .filter((u) => u.length >= 4);
  if (cleanedSources.length === 0) return null;
  return {
    ...card,
    boomProbability: clampInt(card.boomProbability),
    riskProtection: clampInt(card.riskProtection),
    sources: cleanedSources,
  };
}

// ---------- (removed) self-heal loop ----------
//
// The earlier generateObjectWithSelfHeal helper retried the SAME Mistral
// model up to 3 times on schema failure. That blew past the 55s watchdog
// (3 × 20s) without reliably succeeding — repeating the same call against
// the same weak constraint rarely produces a different answer.
//
// New design (user spec): single call per model, escalate across DIFFERENT
// models in PROVIDER_CHAIN — mistral-medium → mistral-large → mistral-small
// → gpt-4o-mini → gpt-4o. Each model gets ONE shot. Total ≤ 5 calls
// (user spec). The analyze route enforces a per-call AbortSignal timeout
// AND a cumulative wall-clock guard so the chain bails before 55s.
//
// First-call quality is hardened in buildPickerPrompt (explicit OUTPUT
// FORMAT block) + loosened StockCardSchema + post-call normalizeStockCard
// so the fallbacks usually never fire.

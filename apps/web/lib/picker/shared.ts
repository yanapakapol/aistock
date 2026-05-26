import 'server-only';
import { z } from 'zod';
import { sql } from 'drizzle-orm';
import { generateObject, NoObjectGeneratedError, type LanguageModel } from 'ai';

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

// Mistral Medium primary per user spec — better ranking quality than Small
// on news-grounded prompts. The split-job pattern (scan saves to DB, analyze
// runs LLM) keeps each call's wall-clock under Vercel Hobby's 60s ceiling
// without sacrificing model quality or context length.
export const PROVIDER_CHAIN: Array<{ provider: Provider; modelId: string }> = [
  { provider: 'mistral', modelId: 'mistral-medium-latest' },
  { provider: 'openai', modelId: 'gpt-4o' },
  { provider: 'anthropic', modelId: 'claude-3-5-sonnet-latest' },
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

  const systemPrompt =
    `You are a SKEPTICAL stock analyst. You produce up to 6 well-evidenced candidates. RULES:\n\n` +
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
      : `Use the major listed exchanges in the target country (verify the ticker actually trades there).\n`);

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

// ---------- Self-healing generateObject ----------
//
// Mistral Medium uses "soft" JSON mode — the schema is baked into the
// system prompt and validated by Zod after the fact. There's no
// constrained decoding, so a non-trivial schema like StockCardSchema
// sometimes produces output that fails validation ("No object generated:
// response did not match schema"). The CURRENT behavior was: throw,
// fall through to gpt-4o/claude.
//
// New behavior: when Mistral fails validation, capture the raw text it
// emitted + the Zod error, then ASK MISTRAL TO FIX ITS OWN OUTPUT. Up to
// `maxRepairs` extra attempts at temperature 0 so the repair is
// deterministic. Only if all repairs also fail do we throw back to the
// caller (which then triggers provider fallback).
//
// This keeps Mistral as the primary provider (user spec) without paying
// the 30% silent-fail tax.
export interface SelfHealOptions<TSchema extends z.ZodType> {
  model: LanguageModel;
  schema: TSchema;
  system: string;
  prompt: string;
  /** How many EXTRA attempts beyond the first. Default: 2 → 3 total tries. */
  maxRepairs?: number;
  /** Called before each attempt so the UI can show "self-correcting…". */
  onAttempt?: (info: {
    attempt: number;
    total: number;
    isRepair: boolean;
    previousError?: string;
  }) => void;
}

export interface SelfHealResult<TSchema extends z.ZodType> {
  object: z.infer<TSchema>;
  attempts: number;
  repaired: boolean;
}

export async function generateObjectWithSelfHeal<TSchema extends z.ZodType>(
  opts: SelfHealOptions<TSchema>,
): Promise<SelfHealResult<TSchema>> {
  const { model, schema, system, prompt, onAttempt, maxRepairs = 2 } = opts;
  const total = maxRepairs + 1;

  let lastErr: unknown = null;
  let lastRawText: string | null = null;
  let lastErrSummary = '';

  for (let attempt = 1; attempt <= total; attempt++) {
    const isRepair = attempt > 1;
    onAttempt?.({
      attempt,
      total,
      isRepair,
      previousError: isRepair ? lastErrSummary : undefined,
    });

    try {
      const callSystem = isRepair
        ? `${system}\n\n` +
          `⚠ SELF-CORRECTION PASS. Your previous attempt FAILED schema validation. ` +
          `Read the error and previous output below, then output a CORRECTED full ` +
          `JSON response. NO markdown, NO commentary, NO code fences — just the ` +
          `raw JSON object.`
        : system;
      const callPrompt = isRepair
        ? buildRepairPrompt(prompt, lastRawText, lastErrSummary)
        : prompt;

      // mode: 'json' tells Mistral to use response_format: { type: 'json_object' }
      // so we at least get syntactically-valid JSON. temperature: 0 on
      // repair attempts so the model deterministically tries to satisfy
      // the schema instead of riffing again.
      const { object } = await generateObject({
        model,
        schema,
        system: callSystem,
        prompt: callPrompt,
        mode: 'json',
        temperature: isRepair ? 0 : 0.3,
      } as Parameters<typeof generateObject>[0]);

      return {
        object: object as z.infer<TSchema>,
        attempts: attempt,
        repaired: isRepair,
      };
    } catch (err) {
      lastErr = err;
      // Pull the raw text + zod cause out of NoObjectGeneratedError so the
      // repair prompt can show the model exactly what went wrong.
      if (NoObjectGeneratedError.isInstance(err)) {
        lastRawText = err.text ?? null;
      }
      lastErrSummary = summarizeValidationError(err);
    }
  }

  // All repairs exhausted — bubble up to the caller's provider-fallback chain.
  throw lastErr ?? new Error('generateObjectWithSelfHeal: unknown failure');
}

function summarizeValidationError(err: unknown): string {
  // Zod error path → "cards.0.industryContext (too_small): String must contain at least 40 character(s)"
  const cause = (err as { cause?: unknown })?.cause;
  if (cause instanceof z.ZodError) {
    return cause.issues
      .slice(0, 8)
      .map(
        (i) =>
          `${i.path.join('.') || '<root>'} (${i.code}): ${i.message}`,
      )
      .join('\n');
  }
  if (err instanceof Error) return err.message.slice(0, 400);
  return String(err).slice(0, 400);
}

function buildRepairPrompt(
  originalPrompt: string,
  previousText: string | null,
  errorSummary: string,
): string {
  const previousBlock = previousText
    ? `YOUR PREVIOUS OUTPUT (which failed validation):\n\n${previousText.slice(0, 6000)}\n\n`
    : `YOUR PREVIOUS OUTPUT could not be parsed at all (likely missing or malformed JSON).\n\n`;
  return (
    previousBlock +
    `VALIDATION ERRORS (path : code : reason):\n${errorSummary}\n\n` +
    `INSTRUCTIONS:\n` +
    `1. Read each error carefully. Fix EXACTLY those fields.\n` +
    `2. Output the COMPLETE corrected JSON object — not just the fixed fields.\n` +
    `3. No markdown, no \`\`\`json fences, no preamble. Raw JSON only.\n` +
    `4. Integer-typed fields: write integers (\`83\`, not \`83.5\`).\n` +
    `5. Score fields: clamp to 0-100.\n` +
    `6. URL fields: use the EXACT urls from the article list — copy/paste.\n` +
    `7. Array length bounds in the error mean: produce the right number of items.\n\n` +
    `ORIGINAL TASK (re-read for context):\n\n${originalPrompt}`
  );
}

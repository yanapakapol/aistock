import 'server-only';
import { z } from 'zod';

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
export const StockCardSchema = z.object({
  symbol: z.string().min(1).max(20).describe('Ticker symbol as it trades on the requested market.'),
  exchange: z.string().min(1).max(20).describe('Exchange code — must belong to the requested market.'),
  name: z.string().min(1).max(160).describe('Full company name.'),
  industry: z.string().min(1).max(120).describe('GICS-level industry / sub-industry.'),
  industryContext: z
    .string()
    .min(40)
    .max(600)
    .describe('~50-word paragraph framing the industry trend right now.'),
  financialStatus: z
    .string()
    .min(20)
    .max(400)
    .describe('One or two sentences on revenue trend, margins, balance sheet health, or growth.'),
  performance: z
    .object({
      '1m': z.number().nullable().optional(),
      '3m': z.number().nullable().optional(),
      '1y': z.number().nullable().optional(),
      note: z.string().max(200).optional(),
    })
    .describe('Percent returns when known. Use null + a note field if uncertain — never invent.'),
  upcomingEvents: z
    .array(
      z.object({
        date: z.string().describe('ISO date YYYY-MM-DD if known, or a coarse label like "Q3 2026".'),
        title: z.string().min(3).max(200),
      }),
    )
    .max(6)
    .describe('Earnings, product launches, regulatory decisions, expirations, etc.'),
  boomProbability: z
    .number()
    .int()
    .min(0)
    .max(100)
    .describe(
      'Calibrated 0-100 estimate. Most picks should land 30-60. Reserve >75 for stocks with multiple imminent catalysts AND strong evidence.',
    ),
  boomTriggers: z
    .array(z.string().min(5).max(200))
    .min(1)
    .max(6)
    .describe('Concrete catalysts that could drive the move — each must be supported by a cited article.'),
  riskProtection: z
    .number()
    .int()
    .min(0)
    .max(100)
    .describe('Higher = SAFER. 80-100 large-cap blue-chip, 60-79 mid-cap, 40-59 small-cap profitable, 20-39 fragile, 0-19 distressed.'),
  riskWhy: z.string().min(20).max(400).describe('Brief explanation of the risk score, anchored in evidence.'),
  consensus: z
    .string()
    .min(5)
    .max(200)
    .describe('Analyst consensus, e.g. "8 Buy / 3 Hold / 1 Sell, avg target $185". Use "n/a" if not in sources.'),
  sources: z
    .array(z.string().url())
    .min(1)
    .max(3)
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

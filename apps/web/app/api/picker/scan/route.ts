import { type NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { generateObject } from 'ai';

import { db } from '@/lib/db/client';
import { outboundAudit } from '@/lib/db/schema';

import { getCurrentUser } from '@/lib/auth/session';
import { sanitizeError } from '@/lib/security/scrub';
import { loadApiKey } from '@/lib/llm/keys';
import { clientFor } from '@/lib/llm/clientFor';
import type { Provider } from '@/lib/llm/providers';

import { searchNewsViaTavily, type TavilyResult } from '@/lib/news/tavily';
import { loadNewsKey } from '@/lib/news/keys';
import { NEWS_PROVIDERS } from '@/lib/db/schema';

export const runtime = 'nodejs';
// Hobby plan ceiling. The web search fan-out + Mistral generateObject call
// together typically resolve in 15-35s; 60s leaves headroom for slow Tavily
// nights without us getting Vercel's terse 504.
export const maxDuration = 60;
export const dynamic = 'force-dynamic';
export const revalidate = 0;

// ---------- Markets ----------

const MARKETS = ['US', 'HK', 'CN', 'TH', 'JP', 'KR', 'UK', 'DE', 'FR', 'TW'] as const;
type Market = (typeof MARKETS)[number];

// Human-readable label that web queries actually rank well for. "US" alone
// matches nothing useful — "United States stocks" / "NYSE / Nasdaq" do.
const MARKET_LABEL: Record<Market, string> = {
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
const MARKET_EXCHANGES: Record<Market, string[]> = {
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

const STOCK_TYPES = [
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
type StockType = (typeof STOCK_TYPES)[number];

const RISK_TOLERANCES = ['low', 'medium', 'high', 'aggressive'] as const;
type RiskTolerance = (typeof RISK_TOLERANCES)[number];

const RISK_MIN_PROTECTION: Record<RiskTolerance, number> = {
  low: 70,
  medium: 40,
  high: 20,
  aggressive: 0,
};

// ---------- Request body ----------

const BodySchema = z
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

// ---------- Response schema (drives generateObject) ----------

// Source-URL refinement happens at generate-time once we know the article
// list; the base schema enforces shape + boundaries.
const StockCardSchema = z.object({
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

type StockCard = z.infer<typeof StockCardSchema>;

const ResultSchema = z.object({
  // We ask for 6 but allow fewer for strict-risk filters that can't fill them.
  cards: z.array(StockCardSchema).min(1).max(6),
});

// ---------- Tavily query builder ----------

function buildQueries(marketLabel: string, sectors: string[]): string[] {
  // Cross-product is bounded by sectors.length (<=5) so we ship 4-6 queries
  // total per request (independent of sectors): three generic + one per
  // sector, capped at 6.
  const generic = [
    `top ${marketLabel} stocks to watch 2026 analyst consensus`,
    `${marketLabel} stocks upcoming catalysts earnings 2026`,
    `${marketLabel} undervalued small-cap breakout candidates`,
  ];
  const perSector = sectors.map(
    (s) => `best ${s} stocks ${marketLabel} 2026 strong buy upcoming catalysts`,
  );
  return [...generic, ...perSector].slice(0, 6);
}

// ---------- News fan-out ----------

interface Article {
  url: string;
  title: string;
  content: string;
  publishedDate?: string;
}

interface QueryFanoutResult {
  query: string;
  ok: boolean;
  count: number;
}

async function runOneTavily(
  q: string,
): Promise<{ articles: Article[]; ok: boolean }> {
  try {
    const res = await searchNewsViaTavily(q, {
      topic: 'news',
      searchDepth: 'advanced',
      maxResults: 6,
      days: 60,
    });
    const articles = res.results.map(
      (r: TavilyResult): Article => ({
        url: r.url,
        title: r.title,
        content: (r.content ?? '').slice(0, 600),
        publishedDate: r.publishedDate,
      }),
    );
    return { articles, ok: true };
  } catch (err) {
    console.error('[picker/scan] tavily query failed:', q, sanitizeError(err));
    return { articles: [], ok: false };
  }
}

function dedupeByUrl(articles: Article[], cap: number): Article[] {
  const seen = new Set<string>();
  const out: Article[] = [];
  for (const a of articles) {
    if (!a.url) continue;
    const key = a.url.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(a);
    if (out.length >= cap) break;
  }
  return out;
}

// ---------- LLM provider fallback ----------

// Mistral primary per spec, but if the user has no Mistral key fall through
// to OpenAI / Anthropic so the route still works for everyone.
const PROVIDER_CHAIN: Array<{ provider: Provider; modelId: string }> = [
  { provider: 'mistral', modelId: 'mistral-medium-latest' },
  { provider: 'openai', modelId: 'gpt-5.5' },
  { provider: 'anthropic', modelId: 'claude-opus-4-7' },
];

const PROVIDER_HOST: Record<Provider, string> = {
  openai: 'api.openai.com',
  anthropic: 'api.anthropic.com',
  google: 'generativelanguage.googleapis.com',
  mistral: 'api.mistral.ai',
  moonshot: 'api.moonshot.ai',
  deepseek: 'api.deepseek.com',
};

async function recordAudit(
  kind: string,
  host: string,
  status: number | null,
  latencyMs: number,
): Promise<void> {
  try {
    await db.insert(outboundAudit).values({ kind, host, status, latencyMs });
  } catch (err) {
    console.error('[picker/scan] audit insert failed:', sanitizeError(err));
  }
}

// ---------- SSE helpers ----------

type SseEventName = 'phase' | 'result' | 'error';

function sseFormat(event: SseEventName, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

function sseDone(): string {
  // Terminator the client uses to know the stream is intentionally closed.
  return `data: ${JSON.stringify({ done: true })}\n\n`;
}

interface SseEmitter {
  phase: (
    name: string,
    detail: string,
    extra?: Record<string, unknown>,
  ) => void;
  result: (data: unknown) => void;
  error: (message: string, phase: string, kind: string) => void;
  end: () => void;
}

// ---------- Auto-pick market ----------

interface AutoMarketPick {
  markets: string[];
  reasoning?: string;
}

const AutoMarketSchema = z.object({
  markets: z
    .array(z.string().min(1).max(40))
    .min(1)
    .max(3)
    .describe(
      'Market codes (US, HK, CN, TH, JP, KR, UK, DE, FR, TW) or country names like "India", "Singapore".',
    ),
  reasoning: z.string().min(10).max(400).describe('Brief macro/sector rationale.'),
});

async function autoPickMarkets(
  keyByProvider: Record<Provider, string | null>,
): Promise<AutoMarketPick | null> {
  for (const attempt of PROVIDER_CHAIN) {
    const key = keyByProvider[attempt.provider];
    if (!key) continue;
    const t0 = Date.now();
    try {
      const model = await clientFor(attempt.provider, attempt.modelId, key);
      const { object } = await generateObject({
        model,
        schema: AutoMarketSchema,
        system:
          'You are a global macro strategist. Reply ONLY with the requested JSON shape. Be specific and concise.',
        prompt:
          'Given current 2026 macro conditions, which 2 stock markets globally are most likely to see broad-based booms in the next 6 months? ' +
          'Reply with a JSON array of market codes (US, HK, CN, TH, JP, KR, UK, DE, FR, TW, or country names like "India", "Singapore"). ' +
          'Be specific and cite reasoning briefly.',
      });
      recordAudit(
        `picker.scan.auto.${attempt.provider}`,
        PROVIDER_HOST[attempt.provider],
        200,
        Date.now() - t0,
      ).catch(() => undefined);
      return object;
    } catch (err) {
      const status =
        (err as { status?: number; statusCode?: number })?.status ??
        (err as { statusCode?: number })?.statusCode ??
        500;
      recordAudit(
        `picker.scan.auto.${attempt.provider}`,
        PROVIDER_HOST[attempt.provider],
        status,
        Date.now() - t0,
      ).catch(() => undefined);
      console.error(
        `[picker/scan] auto-pick ${attempt.provider} failed:`,
        sanitizeError(err),
      );
      continue;
    }
  }
  return null;
}

// Map a free-form market string (from autoPickMarkets or customCountries)
// to a (label, allowedExchanges) tuple. Unknown country names get a
// generic label and an empty exchange whitelist — the LLM is instructed
// to use major listed exchanges in that country.
function resolveMarketLabel(input: string): {
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

// ---------- Handler ----------

export async function POST(req: NextRequest) {
  // Phase is tracked outside the stream so the top-level catch can report it.
  let phase = 'init';

  // ---- Pre-stream gates: auth + same-origin + body parse ----
  // These return classic JSON 4xx so the client knows to surface a toast
  // rather than try to parse an SSE stream.
  try {
    const sfs = req.headers.get('sec-fetch-site');
    if (sfs && sfs !== 'same-origin' && sfs !== 'none') {
      return NextResponse.json({ error: 'cross-site blocked' }, { status: 403 });
    }

    phase = 'auth';
    const user = await getCurrentUser().catch(() => null);
    if (!user) {
      return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
    }

    phase = 'parse-body';
    const json = (await req.json().catch(() => null)) as unknown;
    const parsed = BodySchema.safeParse(json);
    if (!parsed.success) {
      return NextResponse.json(
        { error: 'invalid request', issues: parsed.error.issues },
        { status: 400 },
      );
    }
    const body = parsed.data;
    const sectors = body.sectors;
    const stockTypes: StockType[] = body.stockTypes ?? [];
    const riskTolerance: RiskTolerance = body.riskTolerance ?? 'medium';

    // ---- Build the SSE stream ----
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        let closed = false;
        const send = (chunk: string) => {
          if (closed) return;
          try {
            controller.enqueue(encoder.encode(chunk));
          } catch {
            /* controller already torn down */
          }
        };
        const emitter: SseEmitter = {
          phase: (name, detail, extra) =>
            send(sseFormat('phase', { name, detail, ...(extra ?? {}) })),
          result: (data) => send(sseFormat('result', data)),
          error: (message, errPhase, kind) =>
            send(sseFormat('error', { message, phase: errPhase, kind })),
          end: () => {
            if (closed) return;
            send(sseDone());
            closed = true;
            try {
              controller.close();
            } catch {
              /* ignore */
            }
          },
        };

        try {
          await runScan({ body, sectors, stockTypes, riskTolerance, emitter });
        } catch (err) {
          const msg =
            err instanceof Error
              ? err.message || err.name || 'unknown error'
              : typeof err === 'string'
                ? err
                : 'unknown error';
          console.error(`[picker/scan] uncaught in phase=${phase}: ${msg}`);
          emitter.error(msg, phase, 'server_exception');
        } finally {
          emitter.end();
        }
      },
      cancel() {
        // Client disconnected — nothing to clean up; in-flight fetches will
        // be torn down by GC when the controller is no longer referenced.
      },
    });

    return new Response(stream, {
      status: 200,
      headers: {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
        // Disable proxy buffering (Nginx etc.) so events flush immediately.
        'x-accel-buffering': 'no',
      },
    });
  } catch (err) {
    // Top-level pre-stream backstop (e.g. body parser exploded). Always emits
    // a non-empty JSON body so the UI can render an actionable message.
    let message = 'unknown error';
    if (err instanceof Error) message = err.message || err.name || 'unknown error';
    else if (typeof err === 'string') message = err;
    console.error(`[picker/scan] uncaught pre-stream in phase=${phase}: ${message}`);
    return new NextResponse(
      JSON.stringify({ error: message, phase, kind: 'server_exception' }),
      {
        status: 500,
        headers: { 'content-type': 'application/json; charset=utf-8' },
      },
    );
  }

  // ---- Inner async pipeline (closure over phase via parameter) ----
  async function runScan(params: {
    body: z.infer<typeof BodySchema>;
    sectors: string[];
    stockTypes: StockType[];
    riskTolerance: RiskTolerance;
    emitter: SseEmitter;
  }): Promise<void> {
    const { body, sectors, stockTypes, riskTolerance, emitter } = params;

    // ---- Discover provider keys in parallel (LLMs + news) ----
    phase = 'discover-keys';
    emitter.phase('discover-keys', 'Loading API keys from the encrypted vault...');
    const [mistralKey, openaiKey, anthropicKey, tavilyKey, newsProviderKeys] =
      await Promise.all([
        loadApiKey('mistral').catch(() => null),
        loadApiKey('openai').catch(() => null),
        loadApiKey('anthropic').catch(() => null),
        loadNewsKey('tavily').catch(() => null),
        Promise.all(
          NEWS_PROVIDERS.map(async (p) => ({
            p,
            key: await loadNewsKey(p).catch(() => null),
          })),
        ),
      ]);

    const keyByProvider: Record<Provider, string | null> = {
      mistral: mistralKey,
      openai: openaiKey,
      anthropic: anthropicKey,
      google: null,
      moonshot: null,
      deepseek: null,
    };

    // ---- Resolve target markets ----
    phase = 'resolve-markets';
    const targets: Array<{ label: string; exchanges: string[] }> = [];

    if (body.autoPickMarket) {
      emitter.phase(
        'resolve-markets',
        'Asking the AI to pick the most likely booming markets...',
      );
      const picked = await autoPickMarkets(keyByProvider);
      if (!picked || picked.markets.length === 0) {
        // Soft-fail to whatever explicit market was provided, else US.
        const fallback =
          body.market ?? (body.customCountries?.[0] as string | undefined) ?? 'US';
        const resolved = resolveMarketLabel(fallback);
        targets.push(resolved);
        emitter.phase(
          'resolve-markets',
          `Auto-pick unavailable; falling back to ${resolved.label}.`,
          { markets: [resolved.label], autoPicked: false },
        );
      } else {
        for (const m of picked.markets.slice(0, 2)) {
          targets.push(resolveMarketLabel(m));
        }
        emitter.phase(
          'resolve-markets',
          `AI picked: ${targets.map((t) => t.label).join(', ')}.`,
          {
            markets: targets.map((t) => t.label),
            autoPicked: true,
            reasoning: picked.reasoning,
          },
        );
      }
    } else if (body.customCountries && body.customCountries.length > 0) {
      for (const c of body.customCountries.slice(0, 3)) {
        targets.push(resolveMarketLabel(c));
      }
      emitter.phase(
        'resolve-markets',
        `Scanning ${targets.map((t) => t.label).join(', ')}.`,
        { markets: targets.map((t) => t.label) },
      );
    } else if (body.market) {
      targets.push(resolveMarketLabel(body.market));
      emitter.phase(
        'resolve-markets',
        `Scanning ${targets[0]!.label}.`,
        { markets: [targets[0]!.label] },
      );
    }

    if (targets.length === 0) {
      emitter.error(
        'No market resolved. Pick a market, enter a country, or enable auto-pick.',
        'resolve-markets',
        'no_market',
      );
      return;
    }

    const primaryMarketLabel = targets.map((t) => t.label).join(' / ');
    const allowedExchanges = Array.from(
      new Set(targets.flatMap((t) => t.exchanges)),
    );

    // ---- Web search fan-out ----
    phase = 'tavily-search';
    const haveTavily = !!(tavilyKey || process.env.TAVILY_API_KEY);
    if (!haveTavily) {
      const configured = newsProviderKeys.filter((x) => x.key).map((x) => x.p);
      emitter.error(
        'No web-search provider configured. Add a Tavily key in Settings → News & data API keys. ' +
          (configured.length
            ? `(Configured: ${configured.join(', ')} — these are ticker-scoped, not open web search.)`
            : ''),
        'tavily-search',
        'no_search_key',
      );
      return;
    }

    // For multi-market targets, we still only fan out one query set against
    // a synthesized label — keeps Tavily cost bounded at 4-6 queries total.
    const queries = buildQueries(primaryMarketLabel, sectors);
    emitter.phase(
      'search',
      `Running ${queries.length} web searches via Tavily...`,
      { totalQueries: queries.length },
    );

    const articles: Article[] = [];
    const queryResults: QueryFanoutResult[] = [];
    const tStart = Date.now();
    for (let i = 0; i < queries.length; i++) {
      const q = queries[i]!;
      emitter.phase('search', `Tavily: ${q}`, {
        query: i + 1,
        of: queries.length,
        q,
      });
      const { articles: got, ok } = await runOneTavily(q);
      articles.push(...got);
      queryResults.push({ query: q, ok, count: got.length });
    }
    const deduped = dedupeByUrl(articles, 20);
    recordAudit(
      'picker.scan.tavily',
      'api.tavily.com',
      deduped.length > 0 ? 200 : 204,
      Date.now() - tStart,
    ).catch(() => undefined);

    emitter.phase(
      'sources',
      `${deduped.length} unique articles aggregated`,
      { count: deduped.length, queries: queryResults },
    );

    if (deduped.length === 0) {
      emitter.error(
        'Web search returned no usable articles for this market+sector combination. Try broader sectors or a different market.',
        'tavily-search',
        'no_articles',
      );
      return;
    }

    // ---- Build prompt ----
    phase = 'build-prompt';
    const articleBlock = deduped
      .map(
        (a, i) =>
          `[#${i + 1}] ${a.title}\n  URL: ${a.url}\n  ${
            a.publishedDate ? `Date: ${a.publishedDate}\n  ` : ''
          }${a.content.replace(/\s+/g, ' ').slice(0, 500)}`,
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

    // ---- generateObject with provider fallback ----
    phase = 'llm';
    emitter.phase(
      'llm',
      `Analyzing ${deduped.length} articles and ranking up to 6 stocks...`,
      { articleCount: deduped.length },
    );

    const articleUrlSet = new Set(deduped.map((a) => a.url.toLowerCase()));
    let lastErr: unknown = null;

    for (const attempt of PROVIDER_CHAIN) {
      const key = keyByProvider[attempt.provider];
      if (!key) continue;

      emitter.phase(
        'llm',
        `Trying ${attempt.provider} (${attempt.modelId})...`,
        { provider: attempt.provider, model: attempt.modelId },
      );

      const llmStart = Date.now();
      try {
        const model = await clientFor(attempt.provider, attempt.modelId, key);
        const { object } = await generateObject({
          model,
          schema: ResultSchema,
          system: systemPrompt,
          prompt: userPrompt,
        });

        recordAudit(
          `picker.scan.${attempt.provider}`,
          PROVIDER_HOST[attempt.provider],
          200,
          Date.now() - llmStart,
        ).catch(() => undefined);

        // ---- Post-LLM validation: URLs must be from the article set,
        //      risk_protection must clear the tolerance floor. ----
        const filtered: StockCard[] = [];
        for (const card of object.cards) {
          // Sources must all be from the article set (case-insensitive).
          const cleanSources = card.sources.filter((u) =>
            articleUrlSet.has(u.toLowerCase()),
          );
          if (cleanSources.length === 0) {
            // Model hallucinated all URLs — drop this card.
            console.warn(
              `[picker/scan] dropping ${card.symbol}: all sources outside article list`,
            );
            continue;
          }
          if (card.riskProtection < minRiskProtection) {
            // Honour the risk-tolerance floor even if the model didn't.
            continue;
          }
          filtered.push({ ...card, sources: cleanSources });
        }

        if (filtered.length === 0) {
          // The model returned cards but every one was rejected — surface as
          // an error so the UI shows something actionable rather than empty.
          emitter.error(
            'The model returned cards but none passed evidence + risk-tolerance filters. Try a broader risk tolerance or different sectors.',
            'llm',
            'all_cards_filtered',
          );
          return;
        }

        const sources = Array.from(new Set(deduped.map((a) => a.url))).slice(0, 20);
        emitter.result({ cards: filtered, sources });
        return;
      } catch (err) {
        const status =
          (err as { status?: number; statusCode?: number })?.status ??
          (err as { statusCode?: number })?.statusCode ??
          500;
        lastErr = err;
        recordAudit(
          `picker.scan.${attempt.provider}`,
          PROVIDER_HOST[attempt.provider],
          status,
          Date.now() - llmStart,
        ).catch(() => undefined);
        console.error(
          `[picker/scan] ${attempt.provider}/${attempt.modelId} failed:`,
          sanitizeError(err),
        );
        emitter.phase(
          'llm',
          `${attempt.provider} failed (HTTP ${status}); trying next provider...`,
          { provider: attempt.provider, status },
        );
        continue;
      }
    }

    // No provider had a key OR every attempt threw.
    if (!lastErr) {
      emitter.error(
        'No LLM key configured. Add a Mistral, OpenAI, or Anthropic key in Settings → LLM API keys.',
        'llm',
        'no_llm_key',
      );
      return;
    }
    emitter.error(sanitizeError(lastErr).message, 'llm', 'llm_failed');
  }
}

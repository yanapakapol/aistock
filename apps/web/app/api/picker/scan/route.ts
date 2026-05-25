import { NextResponse, type NextRequest } from 'next/server';
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

// ---------- Request body ----------

const BodySchema = z.object({
  market: z.enum(MARKETS),
  sectors: z.array(z.string().min(1).max(80)).min(1).max(5),
});

// ---------- Response schema (drives generateObject) ----------

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
    .min(0)
    .max(100)
    .describe('Best-effort estimate, 0-100, that the stock pops meaningfully in the next ~3 months.'),
  boomTriggers: z
    .array(z.string().min(5).max(200))
    .min(1)
    .max(6)
    .describe('Concrete catalysts that could drive the move.'),
  riskProtection: z
    .number()
    .min(0)
    .max(100)
    .describe('Higher = safer. 100 = bulletproof balance sheet, 0 = high blow-up risk.'),
  riskWhy: z.string().min(20).max(400).describe('Brief explanation of the risk score.'),
  consensus: z
    .string()
    .min(5)
    .max(200)
    .describe('Analyst consensus, e.g. "8 Buy / 3 Hold / 1 Sell, avg target $185". "n/a" if unknown.'),
  sources: z
    .array(z.string().url())
    .min(1)
    .max(3)
    .describe('1-3 URLs from the provided article list that back this card.'),
});

const ResultSchema = z.object({
  cards: z.array(StockCardSchema).length(6),
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

async function fanoutTavily(queries: string[], apiKey: string): Promise<Article[]> {
  // We have a Tavily key, but the helper resolves its own key from the vault.
  // The helper supports per-call overrides only via env, so we just call it
  // and let it re-resolve — adds one cache-hit DB round-trip per query, which
  // is negligible compared to Tavily latency.
  void apiKey; // intentionally unused; helper loads its own key
  const settled = await Promise.allSettled(
    queries.map(async (q) => {
      try {
        const res = await searchNewsViaTavily(q, {
          topic: 'news',
          searchDepth: 'advanced',
          maxResults: 6,
          days: 60,
        });
        return res.results.map(
          (r: TavilyResult): Article => ({
            url: r.url,
            title: r.title,
            content: (r.content ?? '').slice(0, 600),
            publishedDate: r.publishedDate,
          }),
        );
      } catch (err) {
        console.error('[picker/scan] tavily query failed:', q, sanitizeError(err));
        return [] as Article[];
      }
    }),
  );
  const out: Article[] = [];
  for (const s of settled) if (s.status === 'fulfilled') out.push(...s.value);
  return out;
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

// ---------- Handler ----------

export async function POST(req: NextRequest) {
  let phase = 'init';
  try {
    // CSRF: same-origin only.
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
    const { market, sectors } = parsed.data;
    const marketLabel = MARKET_LABEL[market];
    const allowedExchanges = MARKET_EXCHANGES[market];

    // ---- Discover provider keys in parallel (LLMs + news) ----
    phase = 'discover-keys';
    const [mistralKey, openaiKey, anthropicKey, tavilyKey, newsProviderKeys] = await Promise.all([
      loadApiKey('mistral').catch(() => null),
      loadApiKey('openai').catch(() => null),
      loadApiKey('anthropic').catch(() => null),
      loadNewsKey('tavily').catch(() => null),
      // Probe every news provider so we can fall back to ANY configured one.
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
      // Not in the chain — declared for type completeness.
      google: null,
      moonshot: null,
      deepseek: null,
    };

    // ---- Web search fan-out ----
    phase = 'tavily-search';
    const queries = buildQueries(marketLabel, sectors);
    let articles: Article[] = [];

    if (tavilyKey || process.env.TAVILY_API_KEY) {
      const tStart = Date.now();
      const raw = await fanoutTavily(queries, tavilyKey ?? process.env.TAVILY_API_KEY ?? '');
      articles = dedupeByUrl(raw, 20);
      recordAudit(
        'picker.scan.tavily',
        'api.tavily.com',
        articles.length > 0 ? 200 : 204,
        Date.now() - tStart,
      ).catch(() => undefined);
    } else {
      // Tavily not configured — surface which news provider IS configured so
      // the caller knows what to do. (Other providers in this vault are
      // ticker-scoped — Finnhub / EODHD — and not useful for an open
      // "find me 6 stocks" web search. So we hard-fail here rather than
      // silently produce hallucinated cards.)
      const configured = newsProviderKeys.filter((x) => x.key).map((x) => x.p);
      return NextResponse.json(
        {
          error:
            'No web-search provider configured. Add a Tavily key in Settings → News & data API keys. ' +
            (configured.length
              ? `(Configured: ${configured.join(', ')} — these are ticker-scoped, not open web search.)`
              : ''),
          phase: 'tavily-search',
          kind: 'no_search_key',
        },
        { status: 400 },
      );
    }

    if (articles.length === 0) {
      return NextResponse.json(
        {
          error:
            'Web search returned no usable articles for this market+sector combination. Try broader sectors or a different market.',
          phase: 'tavily-search',
          kind: 'no_articles',
        },
        { status: 502 },
      );
    }

    // ---- Build prompt ----
    phase = 'build-prompt';
    const articleBlock = articles
      .map(
        (a, i) =>
          `[#${i + 1}] ${a.title}\n  URL: ${a.url}\n  ${
            a.publishedDate ? `Date: ${a.publishedDate}\n  ` : ''
          }${a.content.replace(/\s+/g, ' ').slice(0, 500)}`,
      )
      .join('\n\n');

    const systemPrompt =
      'You are a sell-side equity scout assembling AI-curated stock cards for the aistock platform. ' +
      'You produce EXACTLY 6 cards, each tradeable on the requested market. ' +
      `For ${market}, only use exchanges from this list: ${allowedExchanges.join(', ')}. ` +
      'Hard rules: (1) NEVER fabricate ticker symbols — every symbol must correspond to a real, currently-listed company on one of those exchanges. ' +
      'If in doubt about a ticker, pick a different stock you are sure about. ' +
      '(2) Every card must cite 1-3 source URLs from the supplied article list — sources field must use ONLY URLs that appear in the Articles block. ' +
      '(3) boomProbability and riskProtection are 0-100 estimates; be explicit about uncertainty in the rationale fields. ' +
      '(4) If an article does not mention a stock, do not pretend it does — only cite articles that genuinely support the card. ' +
      '(5) Diversify across the requested sectors when there are multiple. ' +
      '(6) industryContext is ~50 words; financialStatus is 1-2 sentences. ' +
      '(7) consensus may be "n/a — no analyst data in sources" if the articles do not provide it; do not invent target prices.';

    const userPrompt =
      `Market: ${marketLabel}\n` +
      `Allowed exchanges: ${allowedExchanges.join(', ')}\n` +
      `Sectors of interest: ${sectors.join(', ')}\n\n` +
      `Articles consulted (cite by URL — these are the ONLY URLs you may put in the per-card sources arrays):\n\n${articleBlock}\n\n` +
      'Produce exactly 6 stock cards. Diversify across sectors when multiple were requested. Anchor every claim to the article list above.';

    // ---- generateObject with provider fallback ----
    phase = 'llm';
    let lastErr: unknown = null;
    let lastStatus = 500;

    for (const attempt of PROVIDER_CHAIN) {
      const key = keyByProvider[attempt.provider];
      if (!key) continue;

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

        const sources = Array.from(new Set(articles.map((a) => a.url))).slice(0, 20);
        return NextResponse.json({ cards: object.cards, sources }, { status: 200 });
      } catch (err) {
        const status =
          (err as { status?: number; statusCode?: number })?.status ??
          (err as { statusCode?: number })?.statusCode ??
          500;
        lastErr = err;
        lastStatus = status;
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
        // Try next provider in chain.
        continue;
      }
    }

    // No provider had a key OR every attempt threw.
    if (!lastErr) {
      return NextResponse.json(
        {
          error:
            'No LLM key configured. Add a Mistral, OpenAI, or Anthropic key in Settings → LLM API keys.',
          phase: 'llm',
          kind: 'no_llm_key',
        },
        { status: 400 },
      );
    }
    return NextResponse.json(
      {
        error: sanitizeError(lastErr),
        phase: 'llm',
        kind: 'llm_failed',
      },
      { status: lastStatus || 502 },
    );
  } catch (err) {
    // Top-level backstop. Always emits a non-empty JSON body so the UI agent
    // can render an actionable message instead of a bare "500".
    let message = 'unknown error';
    if (err instanceof Error) message = err.message || err.name || 'unknown error';
    else if (typeof err === 'string') message = err;
    else if (err && typeof err === 'object') {
      try {
        message = String((err as { message?: unknown }).message ?? JSON.stringify(err));
      } catch {
        /* keep default */
      }
    }
    console.error(`[picker/scan] uncaught in phase=${phase}: ${message}`);
    return new NextResponse(
      JSON.stringify({ error: message, phase, kind: 'server_exception' }),
      {
        status: 500,
        headers: { 'content-type': 'application/json; charset=utf-8' },
      },
    );
  }
}

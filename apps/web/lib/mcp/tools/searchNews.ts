import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { secureFetch } from '@/lib/security/secureFetch';
import { loadNewsKey } from '@/lib/news/keys';
import { db } from '@/lib/db/client';
import { stocks } from '@/lib/db/schema';
import type { ToolHandler } from '../types';

const input = z.object({
  stock_id: z.number().int().positive(),
  query: z.string().min(1),
  from: z.string().optional().describe('ISO date inclusive lower bound (optional)'),
  to: z.string().optional().describe('ISO date inclusive upper bound (optional)'),
  max_results: z.number().int().min(1).max(20).default(10),
});
type Input = z.infer<typeof input>;

const article = z.object({
  url: z.string(),
  title: z.string(),
  content: z.string(),
  published_date: z.string().nullable(),
  score: z.number().nullable(),
  source: z.string().optional(),
});
const output = z.object({
  query: z.string(),
  results: z.array(article),
  sources_used: z.array(z.string()),
  errors: z.array(z.string()),
});
type Output = z.infer<typeof output>;
type Article = z.infer<typeof article>;

interface TavilyResult {
  url?: string;
  title?: string;
  content?: string;
  published_date?: string;
  score?: number;
}
interface TavilyResponse {
  results?: TavilyResult[];
}

interface ExaResult {
  url?: string;
  title?: string;
  text?: string;
  publishedDate?: string;
  score?: number;
}
interface ExaResponse {
  results?: ExaResult[];
}

async function resolveTavilyKey(): Promise<string | null> {
  const vaultKey = await loadNewsKey('tavily').catch(() => null);
  if (vaultKey) return vaultKey;
  const envKey = process.env.TAVILY_API_KEY;
  if (envKey) {
    console.warn(
      '[searchNews] Falling back to TAVILY_API_KEY env var — configure the Tavily key in Settings to use the encrypted vault.',
    );
    return envKey;
  }
  return null;
}

async function searchTavily(
  query: string,
  from: string | undefined,
  to: string | undefined,
  max_results: number,
  apiKey: string,
): Promise<Output['results']> {
  const body: Record<string, unknown> = {
    api_key: apiKey,
    query,
    search_depth: 'advanced',
    max_results,
    include_answer: false,
    include_raw_content: false,
  };
  if (from) body.start_published_date = from;
  if (to) body.end_published_date = to;

  const res = await secureFetch(
    'https://api.tavily.com/search',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    },
    { kind: 'news.tavily' },
  );
  if (!res.ok) {
    // Don't echo the response body — Tavily error pages have echoed the
    // api_key back in the past.
    throw new Error(`Tavily search failed: HTTP ${res.status}`);
  }
  const json = (await res.json()) as TavilyResponse;
  return (json.results ?? []).map((r) => ({
    url: r.url ?? '',
    title: r.title ?? '',
    content: r.content ?? '',
    published_date: r.published_date ?? null,
    score: typeof r.score === 'number' ? r.score : null,
  }));
}

async function searchExa(
  query: string,
  from: string | undefined,
  to: string | undefined,
  max_results: number,
  apiKey: string,
): Promise<Output['results']> {
  const body: Record<string, unknown> = {
    query,
    numResults: max_results,
    contents: { text: true },
  };
  if (from) body.startPublishedDate = from;
  if (to) body.endPublishedDate = to;

  const res = await secureFetch(
    'https://api.exa.ai/search',
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
    },
    { kind: 'news.exa' },
  );
  if (!res.ok) {
    throw new Error(`Exa search failed: HTTP ${res.status}`);
  }
  const json = (await res.json()) as ExaResponse;
  return (json.results ?? []).map((r) => ({
    url: r.url ?? '',
    title: r.title ?? '',
    content: r.text ?? '',
    published_date: r.publishedDate ?? null,
    score: typeof r.score === 'number' ? r.score : null,
  }));
}

async function searchFinnhubCompanyNews(
  symbol: string,
  companyName: string | null,
  from: string | undefined,
  to: string | undefined,
  apiKey: string,
): Promise<Article[]> {
  const fromIso = from ?? new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const toIso = to ?? new Date().toISOString().slice(0, 10);
  const url = `https://finnhub.io/api/v1/company-news?symbol=${encodeURIComponent(symbol)}&from=${fromIso}&to=${toIso}&token=${encodeURIComponent(apiKey)}`;
  const r = await secureFetch(url, undefined, { kind: 'news.finnhub' });
  if (!r.ok) throw new Error(`Finnhub HTTP ${r.status}`);
  const j = (await r.json()) as Array<{
    headline?: string;
    summary?: string;
    url?: string;
    datetime?: number;
    source?: string;
    related?: string;
  }>;
  // Finnhub /company-news often returns sector noise that merely shares a
  // sector code, not the requested ticker. Filter to articles whose title,
  // summary, or `related` string actually mentions the symbol or company.
  const symU = symbol.toUpperCase();
  // Use the first significant word of the company name (e.g. "Globus") to
  // catch "Globus Medical Announces…" while skipping common suffixes.
  const nameToken = (companyName ?? '')
    .replace(/\b(inc|corp|corporation|company|co|ltd|plc|sa|nv|group|holdings?)\b\.?/gi, '')
    .trim()
    .split(/\s+/)[0]
    ?.toLowerCase();
  const filtered = (Array.isArray(j) ? j : []).filter((it) => {
    const hay = `${it.headline ?? ''} ${it.summary ?? ''} ${it.related ?? ''}`.toLowerCase();
    const relatedTokens = (it.related ?? '').toUpperCase().split(/[\s,;|]+/);
    if (relatedTokens.includes(symU)) return true;
    if (hay.includes(` ${symU.toLowerCase()} `) || hay.includes(`(${symU.toLowerCase()})`)) return true;
    if (nameToken && nameToken.length >= 3 && hay.includes(nameToken)) return true;
    return false;
  });
  return filtered.slice(0, 30).map((it) => ({
    url: it.url ?? '',
    title: it.headline ?? '',
    content: it.summary ?? '',
    published_date: it.datetime ? new Date(it.datetime * 1000).toISOString().slice(0, 10) : null,
    score: null,
    source: it.source ?? 'finnhub',
  }));
}

async function searchEodhdNews(
  symbol: string,
  from: string | undefined,
  to: string | undefined,
  apiKey: string,
): Promise<Article[]> {
  // EODHD news endpoint accepts `s` (symbol with optional exchange suffix) and date range.
  const params = new URLSearchParams({ s: symbol, api_token: apiKey, limit: '30', fmt: 'json' });
  if (from) params.set('from', from);
  if (to) params.set('to', to);
  const r = await secureFetch(`https://eodhd.com/api/news?${params.toString()}`, undefined, {
    kind: 'news.eodhd',
  });
  if (!r.ok) throw new Error(`EODHD HTTP ${r.status}`);
  const j = (await r.json()) as Array<{
    title?: string;
    content?: string;
    link?: string;
    date?: string;
  }>;
  return (Array.isArray(j) ? j : []).map((it) => ({
    url: it.link ?? '',
    title: it.title ?? '',
    content: (it.content ?? '').slice(0, 600),
    published_date: it.date ? it.date.slice(0, 10) : null,
    score: null,
    source: 'eodhd',
  }));
}

function mergeAndDedupe(lists: Article[][], cap: number): Article[] {
  const seen = new Set<string>();
  const out: Article[] = [];
  // Round-robin pull so each source contributes early.
  let pulled = true;
  let i = 0;
  while (pulled && out.length < cap * 3) {
    pulled = false;
    for (const list of lists) {
      const item = list[i];
      if (!item) continue;
      pulled = true;
      const key = (item.url || item.title).toLowerCase();
      if (!key || seen.has(key)) continue;
      seen.add(key);
      out.push(item);
    }
    i++;
  }
  // Sort newest-first then cap.
  out.sort((a, b) => (b.published_date ?? '').localeCompare(a.published_date ?? ''));
  return out.slice(0, cap);
}

export const searchNews: ToolHandler<Input, Output> = {
  name: 'search_news',
  description:
    'Web + financial news search. Fans out in parallel to every configured provider (Tavily, Exa, Finnhub company-news, EODHD news) and merges by URL. Returns ranked articles with ISO published_date so the caller can pair upsert_event with a real date. The stock_id is used to resolve the ticker for ticker-scoped sources (Finnhub, EODHD).',
  input,
  output,
  async execute({ stock_id, query, from, to, max_results }) {
    const [tavilyKey, exaKey, finnhubKey, eodhdKey] = await Promise.all([
      resolveTavilyKey(),
      loadNewsKey('exa').catch(() => null),
      loadNewsKey('finnhub').catch(() => null),
      loadNewsKey('eodhd').catch(() => null),
    ]);

    // Look up symbol/exchange/name for ticker-scoped providers.
    let symbol: string | null = null;
    let exchange: string | null = null;
    let companyName: string | null = null;
    try {
      const [row] = await db
        .select({
          symbol: stocks.symbol,
          exchange: stocks.exchange,
          name: stocks.name,
        })
        .from(stocks)
        .where(eq(stocks.id, stock_id))
        .limit(1);
      if (row) {
        symbol = row.symbol;
        exchange = row.exchange;
        companyName = row.name;
      }
    } catch {
      /* ignore */
    }
    // EODHD requires the symbol in `.US`/`.HK` style — reuse Yahoo-style suffix mapping.
    const eodhdSym = symbol
      ? exchange === 'US' || !exchange
        ? `${symbol}.US`
        : symbol.includes('.')
          ? symbol
          : `${symbol}.${exchange}`
      : null;

    if (!tavilyKey && !exaKey && !finnhubKey && !eodhdKey) {
      return {
        query,
        results: [
          {
            url: '/settings',
            title: 'NEWS SEARCH UNAVAILABLE — no API key configured',
            content:
              'Tell the user verbatim: "I cannot search the web for news because no news/data API keys are configured. Open Settings → News & data API keys and add a Tavily, Exa, Finnhub, or EODHD key, then ask me again." Do NOT invent or simulate news articles. Do NOT call upsert_event with made-up data. Stop tool use for this turn.',
            published_date: new Date().toISOString().slice(0, 10),
            score: null,
            source: 'system',
          },
        ],
        sources_used: [],
        errors: ['no_keys_configured'],
      };
    }

    const tasks: Array<{
      name: string;
      run: () => Promise<Article[]>;
    }> = [];
    if (tavilyKey)
      tasks.push({ name: 'tavily', run: () => searchTavily(query, from, to, max_results, tavilyKey) });
    if (exaKey)
      tasks.push({ name: 'exa', run: () => searchExa(query, from, to, max_results, exaKey) });
    if (finnhubKey && symbol)
      tasks.push({
        name: 'finnhub',
        run: () => searchFinnhubCompanyNews(symbol!, companyName, from, to, finnhubKey),
      });
    if (eodhdKey && eodhdSym)
      tasks.push({ name: 'eodhd', run: () => searchEodhdNews(eodhdSym, from, to, eodhdKey) });

    const settled = await Promise.allSettled(tasks.map((t) => t.run()));
    const lists: Article[][] = [];
    const sourcesUsed: string[] = [];
    const errors: string[] = [];
    settled.forEach((s, i) => {
      const name = tasks[i]!.name;
      if (s.status === 'fulfilled') {
        if (s.value.length > 0) sourcesUsed.push(`${name}(${s.value.length})`);
        else sourcesUsed.push(`${name}(0)`);
        lists.push(s.value);
      } else {
        errors.push(`${name}: ${(s.reason as Error)?.message ?? 'failed'}`);
      }
    });

    const merged = mergeAndDedupe(lists, max_results);
    return { query, results: merged, sources_used: sourcesUsed, errors };
  },
};

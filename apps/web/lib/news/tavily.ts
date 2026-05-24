import 'server-only';
import { secureFetch } from '@/lib/security/secureFetch';
import { loadNewsKey } from '@/lib/news/keys';

export interface TavilyOpts {
  fromDate?: string; // ISO date "YYYY-MM-DD"
  toDate?: string;
  maxResults?: number;
  /** "basic" | "advanced" — advanced costs more credits but returns higher recall. */
  searchDepth?: 'basic' | 'advanced';
  /** Restrict to news category. */
  topic?: 'news' | 'general';
  /** Days back from now (Tavily-native shortcut; ignored when fromDate is set). */
  days?: number;
}

export interface TavilyResult {
  title: string;
  url: string;
  content: string;
  score?: number;
  publishedDate?: string;
  rawContent?: string;
}

export interface TavilyResponse {
  query: string;
  results: TavilyResult[];
  answer?: string;
  responseTime?: number;
}

/**
 * Wrapper around Tavily's `/search` endpoint via the outbound `secureFetch`
 * allowlist. The Tavily key is loaded from the encrypted `api_keys` vault
 * (see `lib/news/keys.ts`). A `TAVILY_API_KEY` env var is honoured as a
 * backstop for legacy callers / dev setups, with a console warning.
 */
export async function searchNewsViaTavily(
  query: string,
  opts: TavilyOpts = {},
): Promise<TavilyResponse> {
  let apiKey = await loadNewsKey('tavily').catch(() => null);
  if (!apiKey) {
    const envKey = process.env.TAVILY_API_KEY;
    if (envKey) {
      console.warn(
        '[tavily] Falling back to TAVILY_API_KEY env var — configure the Tavily key in Settings to use the encrypted vault.',
      );
      apiKey = envKey;
    }
  }
  if (!apiKey) {
    throw new Error('configure a Tavily key in Settings');
  }

  const body: Record<string, unknown> = {
    api_key: apiKey,
    query,
    topic: opts.topic ?? 'news',
    search_depth: opts.searchDepth ?? 'basic',
    max_results: Math.min(opts.maxResults ?? 10, 20),
    include_answer: false,
    include_raw_content: false,
  };

  if (opts.fromDate) {
    body.start_date = opts.fromDate;
    if (opts.toDate) body.end_date = opts.toDate;
  } else if (opts.days) {
    body.days = opts.days;
  }

  const resp = await secureFetch('https://api.tavily.com/search', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error(`Tavily ${resp.status}: ${text.slice(0, 200)}`);
  }

  const json = (await resp.json()) as {
    query: string;
    results: Array<{
      title: string;
      url: string;
      content: string;
      score?: number;
      published_date?: string;
      raw_content?: string | null;
    }>;
    answer?: string;
    response_time?: number;
  };

  return {
    query: json.query,
    answer: json.answer,
    responseTime: json.response_time,
    results: (json.results ?? []).map((r) => ({
      title: r.title,
      url: r.url,
      content: r.content,
      score: r.score,
      publishedDate: r.published_date,
      rawContent: r.raw_content ?? undefined,
    })),
  };
}

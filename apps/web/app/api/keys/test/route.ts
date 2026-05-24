import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { PROVIDERS, type Provider } from '@/lib/llm/providers';
import { NEWS_PROVIDERS, type NewsProvider } from '@/lib/news/providers';

export const runtime = 'nodejs';

const Body = z.object({
  provider: z.union([z.enum(PROVIDERS), z.enum(NEWS_PROVIDERS)]),
  apiKey: z.string().min(8).max(512),
});

const LLM_SET = new Set<string>(PROVIDERS);
const NEWS_SET = new Set<string>(NEWS_PROVIDERS);

/**
 * Probe the provider's lightest authenticated endpoint with the supplied key.
 * 200 == valid. Nothing is persisted; this is the pre-save validation hook.
 */
export async function POST(req: NextRequest) {
  if (req.headers.get('sec-fetch-site') && req.headers.get('sec-fetch-site') !== 'same-origin') {
    return NextResponse.json({ error: 'cross-origin denied' }, { status: 403 });
  }
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: 'bad request' }, { status: 400 });
  const { provider, apiKey } = parsed.data;
  let ok = false;
  if (LLM_SET.has(provider)) {
    ok = await probeLlm(provider as Provider, apiKey);
  } else if (NEWS_SET.has(provider)) {
    ok = await probeNews(provider as NewsProvider, apiKey);
  }
  return NextResponse.json({ ok });
}

async function probeLlm(provider: Provider, apiKey: string): Promise<boolean> {
  try {
    switch (provider) {
      case 'openai':
        return (await fetch('https://api.openai.com/v1/models', {
          headers: { Authorization: `Bearer ${apiKey}` },
        })).ok;
      case 'anthropic':
        return (await fetch('https://api.anthropic.com/v1/models', {
          headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
        })).ok;
      case 'google':
        return (await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(apiKey)}`,
        )).ok;
      case 'mistral':
        return (await fetch('https://api.mistral.ai/v1/models', {
          headers: { Authorization: `Bearer ${apiKey}` },
        })).ok;
      case 'moonshot':
        return (await fetch('https://api.moonshot.ai/v1/models', {
          headers: { Authorization: `Bearer ${apiKey}` },
        })).ok;
      case 'deepseek':
        return (await fetch('https://api.deepseek.com/models', {
          headers: { Authorization: `Bearer ${apiKey}` },
        })).ok;
    }
  } catch {
    return false;
  }
}

async function probeNews(provider: NewsProvider, apiKey: string): Promise<boolean> {
  try {
    switch (provider) {
      case 'tavily':
        return (
          await fetch('https://api.tavily.com/search', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ api_key: apiKey, query: 'test', max_results: 1 }),
          })
        ).ok;
      case 'exa':
        return (
          await fetch('https://api.exa.ai/search', {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              Authorization: `Bearer ${apiKey}`,
            },
            body: JSON.stringify({ query: 'test', numResults: 1 }),
          })
        ).ok;
      case 'finnhub':
        return (
          await fetch(
            `https://finnhub.io/api/v1/quote?symbol=AAPL&token=${encodeURIComponent(apiKey)}`,
          )
        ).ok;
      case 'eodhd':
        return (
          await fetch(
            `https://eodhd.com/api/eod/AAPL.US?api_token=${encodeURIComponent(apiKey)}&fmt=json&period=d`,
          )
        ).ok;
    }
  } catch {
    return false;
  }
}

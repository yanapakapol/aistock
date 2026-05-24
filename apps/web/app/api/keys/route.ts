import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { saveApiKey, deleteApiKey, listSavedProviders } from '@/lib/llm/keys';
import { PROVIDERS, type Provider } from '@/lib/llm/providers';
import {
  saveNewsKey,
  deleteNewsKey,
  listSavedNewsProviders,
} from '@/lib/news/keys';
import { NEWS_PROVIDERS, type NewsProvider } from '@/lib/news/providers';

export const runtime = 'nodejs';

const LlmEnum = z.enum(PROVIDERS);
const NewsEnum = z.enum(NEWS_PROVIDERS);
const AnyProvider = z.union([LlmEnum, NewsEnum]);

const PostBody = z.object({
  provider: AnyProvider,
  apiKey: z.string().min(8).max(512),
});

const DeleteBody = z.object({
  provider: AnyProvider,
});

const LLM_SET = new Set<string>(PROVIDERS);
const NEWS_SET = new Set<string>(NEWS_PROVIDERS);

function classify(p: string): 'llm' | 'news' | null {
  if (LLM_SET.has(p)) return 'llm';
  if (NEWS_SET.has(p)) return 'news';
  return null;
}

function requireSameOrigin(req: NextRequest) {
  const site = req.headers.get('sec-fetch-site');
  if (site && site !== 'same-origin') {
    throw new Response('cross-origin denied', { status: 403 });
  }
}

export async function GET() {
  const [llmRows, newsRows] = await Promise.all([
    listSavedProviders().catch(() => []),
    listSavedNewsProviders().catch(() => []),
  ]);
  // `listSavedProviders` reads the whole table; filter to LLM providers so the
  // two lists don't double-count news rows.
  const llm = llmRows
    .map((r) => r.provider)
    .filter((p): p is Provider => LLM_SET.has(p));
  const news = newsRows.map((r) => r.provider as NewsProvider);
  return NextResponse.json({ llm, news });
}

export async function POST(req: NextRequest) {
  try {
    requireSameOrigin(req);
  } catch (r) {
    return r as Response;
  }
  const json = await req.json().catch(() => null);
  const parsed = PostBody.safeParse(json);
  if (!parsed.success) return NextResponse.json({ error: 'bad request' }, { status: 400 });
  const kind = classify(parsed.data.provider);
  if (kind === 'llm') {
    await saveApiKey(parsed.data.provider as Provider, parsed.data.apiKey);
  } else if (kind === 'news') {
    await saveNewsKey(parsed.data.provider as NewsProvider, parsed.data.apiKey);
  } else {
    return NextResponse.json({ error: 'unknown provider' }, { status: 400 });
  }
  return NextResponse.json({ ok: true });
}

export async function DELETE(req: NextRequest) {
  try {
    requireSameOrigin(req);
  } catch (r) {
    return r as Response;
  }
  const json = await req.json().catch(() => null);
  const parsed = DeleteBody.safeParse(json);
  if (!parsed.success) return NextResponse.json({ error: 'bad request' }, { status: 400 });
  const kind = classify(parsed.data.provider);
  if (kind === 'llm') {
    await deleteApiKey(parsed.data.provider as Provider);
  } else if (kind === 'news') {
    await deleteNewsKey(parsed.data.provider as NewsProvider);
  } else {
    return NextResponse.json({ error: 'unknown provider' }, { status: 400 });
  }
  return NextResponse.json({ ok: true });
}

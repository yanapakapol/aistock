import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import {
  saveApiKey,
  deleteApiKey,
  listSavedProviders,
  listAdminSavedProviders,
} from '@/lib/llm/keys';
import { PROVIDERS, type Provider } from '@/lib/llm/providers';
import {
  saveNewsKey,
  deleteNewsKey,
  listSavedNewsProviders,
} from '@/lib/news/keys';
import { NEWS_PROVIDERS, type NewsProvider } from '@/lib/news/providers';
import { getCurrentUser } from '@/lib/auth/session';

export const runtime = 'nodejs';

/**
 * Guests have read-only access to settings — they inherit the admin's keys
 * and cannot mutate the vault. Returns a 403 Response when the caller is a
 * guest, null otherwise. Callers (POST/DELETE) bail early on a non-null
 * return; GET is intentionally NOT guarded (another agent handles guest
 * fallback to admin keys there).
 */
async function denyGuestMutation(): Promise<Response | null> {
  const u = await getCurrentUser().catch(() => null);
  if (u?.role === 'guest') {
    return NextResponse.json(
      { error: 'guests cannot modify keys' },
      { status: 403 },
    );
  }
  return null;
}

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
  const me = await getCurrentUser().catch(() => null);
  const isGuest = me?.role === 'guest';

  const [llmRows, newsRows, adminLlmRows] = await Promise.all([
    listSavedProviders().catch(() => []),
    listSavedNewsProviders().catch(() => []),
    // Only spend the round-trip on the admin lookup when the caller is a
    // guest — admin/user accounts get no inheritance, so the answer would
    // be discarded anyway.
    isGuest ? listAdminSavedProviders().catch(() => []) : Promise.resolve([]),
  ]);
  // `listSavedProviders` reads the whole table; filter to LLM providers so the
  // two lists don't double-count news rows.
  const ownLlm = llmRows
    .map((r) => r.provider)
    .filter((p): p is Provider => LLM_SET.has(p));
  const news = newsRows.map((r) => r.provider as NewsProvider);

  // Union: guests see their own keys + admin's keys, with admin-sourced
  // entries marked `inherited: true`. Existence-only — no ciphertext or
  // plaintext crosses this boundary.
  const ownSet = new Set(ownLlm);
  const adminLlm = adminLlmRows
    .map((r) => r.provider)
    .filter((p): p is Provider => LLM_SET.has(p))
    .filter((p) => !ownSet.has(p));

  // Back-compat: existing UI consumers read `llm` as a bare string array.
  // Keep that intact and add a parallel `llmDetails` for clients that want
  // the inheritance flag.
  const llm: Provider[] = [...ownLlm, ...adminLlm];
  const llmDetails: Array<{ provider: Provider; inherited: boolean }> = [
    ...ownLlm.map((provider) => ({ provider, inherited: false })),
    ...adminLlm.map((provider) => ({ provider, inherited: true })),
  ];

  return NextResponse.json({ llm, news, llmDetails });
}

export async function POST(req: NextRequest) {
  try {
    requireSameOrigin(req);
  } catch (r) {
    return r as Response;
  }
  const denied = await denyGuestMutation();
  if (denied) return denied;
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
  const denied = await denyGuestMutation();
  if (denied) return denied;
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

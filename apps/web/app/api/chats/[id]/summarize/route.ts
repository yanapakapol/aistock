import { NextResponse, type NextRequest } from 'next/server';
import { and, asc, desc, eq, sql } from 'drizzle-orm';
import { generateText } from 'ai';
import { db } from '@/lib/db/client';
import { chats, chatMessages, chatSummaries, portfolios, stocks } from '@/lib/db/schema';
import { clientFor } from '@/lib/llm/clientFor';
import { loadApiKey } from '@/lib/llm/keys';
import { PROVIDERS, type Provider } from '@/lib/llm/providers';
import { scrubSecrets } from '@/lib/security/scrub';
import { getCurrentUser } from '@/lib/auth/session';

export const runtime = 'nodejs';
export const maxDuration = 120;

/**
 * GET /api/chats/:id/summarize — return the most recent stored summary.
 * POST /api/chats/:id/summarize — generate a fresh summary with the requested
 *    provider/model (or guess from any saved key), persist it, return it.
 *
 * Summaries live in chat_summaries (separate table). Raw history in
 * chat_messages is untouched, so the user can always re-load the full
 * conversation; the summary is an additional compact view.
 *
 * Ownership: we authorize via the chat → stock → portfolio → user chain,
 * matching ../route.ts. Without this any signed-in user could read/write/
 * delete summaries for any chat id.
 */
async function assertChatOwnedByMe(id: number, userId: number) {
  const ownedByMe = sql`EXISTS (
    SELECT 1 FROM ${stocks} s
    JOIN ${portfolios} p ON p.id = s.portfolio_id
    WHERE s.id = ${chats.stockId} AND p.user_id = ${userId}
  )`;
  const [chat] = await db
    .select()
    .from(chats)
    .where(and(eq(chats.id, id), ownedByMe))
    .limit(1);
  return chat ?? null;
}

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const me = await getCurrentUser();
  if (!me) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  const id = Number((await params).id);
  if (!Number.isFinite(id) || id <= 0) {
    return NextResponse.json({ error: 'bad id' }, { status: 400 });
  }
  const chat = await assertChatOwnedByMe(id, me.id);
  // 404 (not 403) to avoid leaking existence of someone else's chat.
  if (!chat) return NextResponse.json({ error: 'not found' }, { status: 404 });

  const [s] = await db
    .select()
    .from(chatSummaries)
    .where(eq(chatSummaries.chatId, id))
    .orderBy(desc(chatSummaries.createdAt))
    .limit(1);
  return NextResponse.json({ summary: s ?? null });
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  if (req.headers.get('sec-fetch-site') && req.headers.get('sec-fetch-site') !== 'same-origin') {
    return NextResponse.json({ error: 'cross-origin denied' }, { status: 403 });
  }
  const me = await getCurrentUser().catch(() => null);
  if (!me) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  const id = Number((await params).id);
  if (!Number.isFinite(id) || id <= 0) {
    return NextResponse.json({ error: 'bad id' }, { status: 400 });
  }

  const body = (await req.json().catch(() => ({}))) as {
    provider?: Provider;
    modelId?: string;
  };

  // Pick a provider/model. Caller may override; otherwise use the chat's own
  // recorded model + the first provider with a saved key.
  const chatRow = await assertChatOwnedByMe(id, me.id);
  if (!chatRow) return NextResponse.json({ error: 'not found' }, { status: 404 });

  const rows = await db
    .select({ role: chatMessages.role, contentMd: chatMessages.contentMd })
    .from(chatMessages)
    .where(eq(chatMessages.chatId, id))
    .orderBy(asc(chatMessages.createdAt));

  if (rows.length === 0) {
    return NextResponse.json({ error: 'chat is empty — nothing to summarize' }, { status: 400 });
  }

  // Resolve provider+model+key.
  let provider: Provider | null = body.provider ?? null;
  let modelId: string | null = body.modelId ?? chatRow.model ?? null;
  let apiKey: string | null = null;

  if (!provider) {
    for (const p of PROVIDERS) {
      const k = await loadApiKey(p);
      if (k) {
        provider = p;
        apiKey = k;
        break;
      }
    }
  } else {
    apiKey = await loadApiKey(provider);
  }
  if (!provider || !apiKey || !modelId) {
    return NextResponse.json(
      { error: 'no LLM key available — add one in Settings' },
      { status: 400 },
    );
  }

  const transcript = rows
    .map((r) => `**${r.role}**:\n${r.contentMd}`)
    .join('\n\n---\n\n');

  const prompt =
    `Summarize the chat below into a compact research note. Sections: ` +
    `Topic, Key findings (bulleted, cite source URLs already present in the transcript verbatim), ` +
    `Open questions, Action items. Do NOT invent facts not in the transcript. Use clean markdown.\n\n` +
    `=== TRANSCRIPT ===\n${transcript}\n=== END ===`;

  const model = await clientFor(provider, modelId, apiKey);
  const out = await generateText({ model, prompt }).catch((err) => {
    throw err;
  });

  const usage = out.usage as unknown as {
    inputTokens?: number;
    outputTokens?: number;
    promptTokens?: number;
    completionTokens?: number;
  };
  const tokensIn = usage?.inputTokens ?? usage?.promptTokens ?? null;
  const tokensOut = usage?.outputTokens ?? usage?.completionTokens ?? null;
  const summaryMd = String(scrubSecrets(out.text ?? ''));

  const [saved] = await db
    .insert(chatSummaries)
    .values({
      chatId: id,
      summaryMd,
      model: `${provider}/${modelId}`,
      tokensIn: tokensIn ?? null,
      tokensOut: tokensOut ?? null,
    })
    .returning();

  return NextResponse.json({ summary: saved });
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  if (req.headers.get('sec-fetch-site') && req.headers.get('sec-fetch-site') !== 'same-origin') {
    return NextResponse.json({ error: 'cross-origin denied' }, { status: 403 });
  }
  const me = await getCurrentUser().catch(() => null);
  if (!me) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  const id = Number((await params).id);
  if (!Number.isFinite(id) || id <= 0) {
    return NextResponse.json({ error: 'bad id' }, { status: 400 });
  }
  const chat = await assertChatOwnedByMe(id, me.id);
  if (!chat) return NextResponse.json({ error: 'not found' }, { status: 404 });

  await db.delete(chatSummaries).where(eq(chatSummaries.chatId, id));
  return NextResponse.json({ ok: true });
}

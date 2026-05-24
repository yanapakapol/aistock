// TODO: schema needs `chats.user_id` for true per-user isolation. Until then we
// authorize via the stock → portfolio → user chain (see ../route.ts).
import { NextResponse, type NextRequest } from 'next/server';
import { and, asc, eq, sql } from 'drizzle-orm';
import { db } from '@/lib/db/client';
import { chats, chatMessages, portfolios, stocks } from '@/lib/db/schema';
import { getCurrentUser } from '@/lib/auth/session';

export const runtime = 'nodejs';

/** GET /api/chats/:id — full message list for a single chat, ascending by time. */
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const me = await getCurrentUser();
  if (!me) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  const { id: raw } = await params;
  const id = Number(raw);
  if (!Number.isFinite(id) || id <= 0) {
    return NextResponse.json({ error: 'bad id' }, { status: 400 });
  }
  // Fetch the chat AND assert ownership in one round-trip. Either the chat has
  // no stock (global — currently shared, see TODO) OR its stock belongs to me.
  const ownedByMe = sql`EXISTS (
    SELECT 1 FROM ${stocks} s
    JOIN ${portfolios} p ON p.id = s.portfolio_id
    WHERE s.id = ${chats.stockId} AND p.user_id = ${me.id}
  )`;
  const [chat] = await db
    .select()
    .from(chats)
    .where(and(eq(chats.id, id), ownedByMe))
    .limit(1);
  // Return 404 (not 403) so we don't leak existence of someone else's chat.
  if (!chat) return NextResponse.json({ error: 'not found' }, { status: 404 });
  // The `parts` column was added after the initial schema snapshot. If the
  // user hasn't re-run db:migrate yet, fall back to the legacy column set so
  // chat history still works (just without rich tool-call replay).
  let rows: unknown[] = [];
  try {
    rows = await db
      .select({
        id: chatMessages.id,
        role: chatMessages.role,
        contentMd: chatMessages.contentMd,
        parts: chatMessages.parts,
        toolCalls: chatMessages.toolCalls,
        createdAt: chatMessages.createdAt,
      })
      .from(chatMessages)
      .where(eq(chatMessages.chatId, id))
      .orderBy(asc(chatMessages.createdAt));
  } catch (err) {
    const msg = (err as { message?: string }).message ?? '';
    if (!/parts|column.*does not exist/i.test(msg)) {
      console.error('[chats/:id GET] failed:', msg);
      return NextResponse.json({ error: 'load failed', detail: msg }, { status: 500 });
    }
    console.warn('[chats/:id GET] `parts` column missing — run db:migrate. Falling back.');
    rows = await db
      .select({
        id: chatMessages.id,
        role: chatMessages.role,
        contentMd: chatMessages.contentMd,
        toolCalls: chatMessages.toolCalls,
        createdAt: chatMessages.createdAt,
      })
      .from(chatMessages)
      .where(eq(chatMessages.chatId, id))
      .orderBy(asc(chatMessages.createdAt));
  }
  return NextResponse.json({ chat, messages: rows });
}

/**
 * DELETE /api/chats/:id — cascade-deletes its messages via FK. Ownership-
 * scoped: only deletes if the chat belongs to one of the caller's stocks.
 * Previously this would happily delete any chat by id with no check at all.
 */
export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  if (req.headers.get('sec-fetch-site') && req.headers.get('sec-fetch-site') !== 'same-origin') {
    return NextResponse.json({ error: 'cross-origin denied' }, { status: 403 });
  }
  const me = await getCurrentUser().catch(() => null);
  if (!me) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  const { id: raw } = await params;
  const id = Number(raw);
  if (!Number.isFinite(id) || id <= 0) {
    return NextResponse.json({ error: 'bad id' }, { status: 400 });
  }
  const ownedByMe = sql`EXISTS (
    SELECT 1 FROM ${stocks} s
    JOIN ${portfolios} p ON p.id = s.portfolio_id
    WHERE s.id = ${chats.stockId} AND p.user_id = ${me.id}
  )`;
  const result = await db
    .delete(chats)
    .where(and(eq(chats.id, id), ownedByMe))
    .returning({ id: chats.id });
  if (result.length === 0) {
    return NextResponse.json({ error: 'not found' }, { status: 404 });
  }
  return NextResponse.json({ ok: true });
}

// TODO: schema needs `chats.user_id` for true per-user isolation. Until then we
// scope chats via the stock → portfolio → user chain (a chat is "yours" iff its
// stockId belongs to a stock under a portfolio you own). Chats with
// stockId IS NULL have NO user link at all — they are returned ONLY when the
// caller explicitly opts in via ?includeGlobal=1, otherwise they are hidden.
import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { and, desc, eq, ilike, isNull, or, sql } from 'drizzle-orm';
import { db } from '@/lib/db/client';
import { chats, chatMessages, portfolios, stocks } from '@/lib/db/schema';
import { getCurrentUser } from '@/lib/auth/session';

export const runtime = 'nodejs';

const Query = z.object({
  tab: z.enum(['research', 'analysis']).optional(),
  stockId: z.coerce.number().int().positive().optional(),
  includeGlobal: z.enum(['0', '1']).optional(),
});

/** GET /api/chats?tab=&stockId=&includeGlobal= — list recent chats with first-user-message preview, scoped to current user. */
export async function GET(req: NextRequest) {
  const me = await getCurrentUser();
  if (!me) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  const url = new URL(req.url);
  const parsed = Query.safeParse({
    tab: url.searchParams.get('tab') ?? undefined,
    stockId: url.searchParams.get('stockId') ?? undefined,
    includeGlobal: url.searchParams.get('includeGlobal') ?? undefined,
  });
  if (!parsed.success) return NextResponse.json({ error: 'bad query' }, { status: 400 });

  const { tab, stockId, includeGlobal } = parsed.data;
  const wantGlobal = includeGlobal === '1';

  // Ownership predicate: stock joined through portfolios owned by current user.
  // This sub-select returns 1 if the chat's stockId belongs to me.
  const ownedByMe = sql`EXISTS (
    SELECT 1 FROM ${stocks} s
    JOIN ${portfolios} p ON p.id = s.portfolio_id
    WHERE s.id = ${chats.stockId} AND p.user_id = ${me.id}
  )`;

  const conds: Array<ReturnType<typeof eq> | ReturnType<typeof sql>> = [];
  if (tab) conds.push(eq(chats.tab, tab));

  if (stockId) {
    // Strict-only that stockId AND the stock must be owned by me.
    conds.push(eq(chats.stockId, stockId));
    conds.push(ownedByMe);
  } else if (wantGlobal) {
    // No stock filter: include user-owned-stock chats OR global (NULL) chats.
    conds.push(or(ownedByMe, isNull(chats.stockId))!);
  } else {
    // Default: hide globals; only chats whose stock you own.
    conds.push(ownedByMe);
  }

  const rows = await db
    .select({
      id: chats.id,
      tab: chats.tab,
      stockId: chats.stockId,
      model: chats.model,
      createdAt: chats.createdAt,
      preview: sql<string>`(
        select content_md from chat_messages
         where chat_id = ${chats.id} and role = 'user'
         order by created_at asc limit 1
      )`,
      msgCount: sql<number>`(
        select count(*)::int from chat_messages where chat_id = ${chats.id}
      )`,
    })
    .from(chats)
    .where(and(...conds))
    .orderBy(desc(chats.createdAt))
    .limit(100);

  return NextResponse.json(
    { chats: rows },
    // Short private TTL — no SWR — so a brand-new chat shows up on next nav.
    { headers: { 'Cache-Control': 'private, max-age=10' } },
  );
}

const DeleteBody = z.object({ ids: z.array(z.number().int().positive()).min(1) });

/**
 * DELETE /api/chats body {ids:[...]} — cascade deletes via FK. Ownership-
 * scoped: only deletes chats whose stockId belongs to one of the caller's
 * portfolios. Without this check, any signed-in user could nuke any chat
 * by guessing its id.
 */
export async function DELETE(req: NextRequest) {
  if (req.headers.get('sec-fetch-site') && req.headers.get('sec-fetch-site') !== 'same-origin') {
    return NextResponse.json({ error: 'cross-origin denied' }, { status: 403 });
  }
  const me = await getCurrentUser().catch(() => null);
  if (!me) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  const parsed = DeleteBody.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: 'bad body' }, { status: 400 });
  const ids = parsed.data.ids;

  // Filter down to chats the caller actually owns (via stock→portfolio→user).
  // Chats with stockId IS NULL are not owned by anyone in particular today —
  // we skip those entirely from delete-by-id (use the purge endpoint instead).
  const owned = await db
    .select({ id: chats.id })
    .from(chats)
    .innerJoin(stocks, eq(stocks.id, chats.stockId))
    .innerJoin(portfolios, eq(portfolios.id, stocks.portfolioId))
    .where(and(sql`${chats.id} = ANY(${ids})`, eq(portfolios.userId, me.id)));
  const ownedIds = owned.map((r) => r.id);
  if (ownedIds.length === 0) {
    return NextResponse.json({ ok: true, deleted: 0 });
  }
  await db.delete(chats).where(sql`id = ANY(${ownedIds})`);
  return NextResponse.json({ ok: true, deleted: ownedIds.length });
}

const PurgeBody = z.object({
  tab: z.enum(['research', 'analysis']).optional(),
  stockId: z.number().int().positive().optional(),
  patterns: z.array(z.string().min(2).max(200)).optional(),
});

/**
 * POST /api/chats/purge — bulk-delete chats whose ASSISTANT messages match any
 * of the supplied patterns (case-insensitive `ILIKE %pattern%`). Defaults to a
 * curated list of "AI is simulating" tells.
 */
export async function POST(req: NextRequest) {
  if (req.headers.get('sec-fetch-site') && req.headers.get('sec-fetch-site') !== 'same-origin') {
    return NextResponse.json({ error: 'cross-origin denied' }, { status: 403 });
  }
  const me = await getCurrentUser().catch(() => null);
  if (!me) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  const parsed = PurgeBody.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ error: 'bad body' }, { status: 400 });

  const patterns =
    parsed.data.patterns ?? [
      'simulated approach',
      'Simulated News',
      'Simulated Research Process',
      'If Tools Were Available',
      'Let me simulate',
      'I will proceed with a simulated',
      'hypothetical example',
    ];

  // Find candidate chat ids whose assistant messages contain any pattern.
  const likeConds = patterns.map((p) => ilike(chatMessages.contentMd, `%${p}%`));
  const ids = await db
    .selectDistinct({ id: chatMessages.chatId })
    .from(chatMessages)
    .where(and(eq(chatMessages.role, 'assistant'), or(...likeConds)!));

  let scope = ids.map((r) => r.id);

  // Always narrow to chats owned by the caller (via stock→portfolio→user).
  // Optional tab/stockId narrowing applies on top.
  if (scope.length) {
    const conds: Array<ReturnType<typeof eq> | ReturnType<typeof sql>> = [
      sql`${chats.id} = ANY(${scope})`,
      eq(portfolios.userId, me.id),
    ];
    if (parsed.data.tab) conds.push(eq(chats.tab, parsed.data.tab));
    if (parsed.data.stockId) conds.push(eq(chats.stockId, parsed.data.stockId));
    const ok = await db
      .select({ id: chats.id })
      .from(chats)
      .innerJoin(stocks, eq(stocks.id, chats.stockId))
      .innerJoin(portfolios, eq(portfolios.id, stocks.portfolioId))
      .where(and(...conds));
    scope = ok.map((r) => r.id);
  }

  if (scope.length) {
    await db.delete(chats).where(sql`id = ANY(${scope})`);
  }
  return NextResponse.json({ ok: true, deleted: scope.length, ids: scope });
}

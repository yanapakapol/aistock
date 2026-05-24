import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { and, desc, eq, ilike, or, sql } from 'drizzle-orm';
import { db } from '@/lib/db/client';
import { chats, chatMessages } from '@/lib/db/schema';

export const runtime = 'nodejs';

const Query = z.object({
  tab: z.enum(['research', 'analysis']).optional(),
  stockId: z.coerce.number().int().positive().optional(),
});

/** GET /api/chats?tab=&stockId= — list recent chats with first-user-message preview. */
export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const parsed = Query.safeParse({
    tab: url.searchParams.get('tab') ?? undefined,
    stockId: url.searchParams.get('stockId') ?? undefined,
  });
  if (!parsed.success) return NextResponse.json({ error: 'bad query' }, { status: 400 });

  const conds = [] as Array<ReturnType<typeof eq>>;
  if (parsed.data.tab) conds.push(eq(chats.tab, parsed.data.tab));
  if (parsed.data.stockId) conds.push(eq(chats.stockId, parsed.data.stockId));

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
    .where(conds.length ? and(...conds) : undefined)
    .orderBy(desc(chats.createdAt))
    .limit(100);

  return NextResponse.json({ chats: rows });
}

const DeleteBody = z.object({ ids: z.array(z.number().int().positive()).min(1) });

/** DELETE /api/chats body {ids:[...]} — cascade deletes via FK. */
export async function DELETE(req: NextRequest) {
  if (req.headers.get('sec-fetch-site') && req.headers.get('sec-fetch-site') !== 'same-origin') {
    return NextResponse.json({ error: 'cross-origin denied' }, { status: 403 });
  }
  const parsed = DeleteBody.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: 'bad body' }, { status: 400 });
  const ids = parsed.data.ids;
  await db.delete(chats).where(sql`id = ANY(${ids})`);
  return NextResponse.json({ ok: true, deleted: ids.length });
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

  // Optional scope narrowing by tab/stockId.
  if ((parsed.data.tab || parsed.data.stockId) && scope.length) {
    const conds = [] as Array<ReturnType<typeof eq>>;
    if (parsed.data.tab) conds.push(eq(chats.tab, parsed.data.tab));
    if (parsed.data.stockId) conds.push(eq(chats.stockId, parsed.data.stockId));
    const ok = await db
      .select({ id: chats.id })
      .from(chats)
      .where(and(...conds, sql`id = ANY(${scope})`));
    scope = ok.map((r) => r.id);
  }

  if (scope.length) {
    await db.delete(chats).where(sql`id = ANY(${scope})`);
  }
  return NextResponse.json({ ok: true, deleted: scope.length, ids: scope });
}

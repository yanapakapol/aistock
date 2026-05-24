import { NextResponse, type NextRequest } from 'next/server';
import { revalidateTag } from 'next/cache';
import { z } from 'zod';
import { and, eq } from 'drizzle-orm';
import { db } from '@/lib/db/client';
import { stocks } from '@/lib/db/schema';
import { getCurrentUser } from '@/lib/auth/session';
import { ensureSchema } from '@/lib/db/ensure-schema';
import {
  getDefaultPortfolioId,
  listStocks,
  listStocksFull,
  assertOwnsStock,
} from '@/lib/portfolio/queries';

export const runtime = 'nodejs';

const SWR_HEADERS = {
  // Cache portfolio listing for 5 min, allow up to 1 h stale while we revalidate.
  // Watchlist barely changes mid-session. Per-user via the session cookie.
  'Cache-Control': 'private, max-age=300, stale-while-revalidate=3600',
};

const AddBody = z.object({
  symbol: z.string().min(1).max(32),
  exchange: z.string().min(1).max(16),
  name: z.string().min(1).max(256),
  currency: z.string().min(1).max(8).optional(),
  mic: z.string().min(1).max(16).optional(),
});

const DeleteBody = z.object({
  stockId: z.number().int().positive(),
});

function requireSameOrigin(req: NextRequest) {
  const site = req.headers.get('sec-fetch-site');
  if (site && site !== 'same-origin') {
    throw new Response('cross-origin denied', { status: 403 });
  }
}

async function requireUserId(): Promise<number | Response> {
  await ensureSchema().catch(() => undefined);
  const me = await getCurrentUser().catch(() => null);
  if (!me) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  return me.id;
}

export async function GET(req: NextRequest) {
  const uid = await requireUserId();
  if (typeof uid !== 'number') return uid;
  // ?fields=full opts into the legacy shape (portfolioId + mic). Default is
  // the narrow shape (~25% smaller payload, scales with watchlist size).
  const wantsFull = req.nextUrl.searchParams.get('fields') === 'full';
  const rows = wantsFull ? await listStocksFull(uid) : await listStocks(uid);
  return NextResponse.json({ stocks: rows }, { headers: SWR_HEADERS });
}

export async function POST(req: NextRequest) {
  try {
    requireSameOrigin(req);
  } catch (r) {
    return r as Response;
  }
  const uid = await requireUserId();
  if (typeof uid !== 'number') return uid;

  const json = await req.json().catch(() => null);
  const parsed = AddBody.safeParse(json);
  if (!parsed.success) return NextResponse.json({ error: 'bad request' }, { status: 400 });

  const portfolioId = await getDefaultPortfolioId(uid);
  const { symbol, exchange, name, currency, mic } = parsed.data;

  // Per-portfolio idempotent — only checks within THIS user's portfolio.
  // Another user can have the same symbol+exchange as their own stocks row.
  const existing = await db
    .select()
    .from(stocks)
    .where(
      and(
        eq(stocks.portfolioId, portfolioId),
        eq(stocks.symbol, symbol),
        eq(stocks.exchange, exchange),
      ),
    )
    .limit(1);
  if (existing.length > 0) {
    return NextResponse.json({ stock: existing[0], created: false });
  }

  try {
    const inserted = await db
      .insert(stocks)
      .values({
        portfolioId,
        symbol,
        exchange,
        name,
        currency: currency ?? null,
        mic: mic ?? null,
      })
      .returning();
    revalidateTag('portfolio');
    return NextResponse.json({ stock: inserted[0], created: true }, { status: 201 });
  } catch (err) {
    const pgErr = err as { code?: string; message?: string };
    const safeDetail = (pgErr?.message ?? '').split('\n')[0].slice(0, 200);
    return NextResponse.json(
      { error: 'insert failed', detail: safeDetail },
      { status: 500 },
    );
  }
}

export async function DELETE(req: NextRequest) {
  try {
    requireSameOrigin(req);
  } catch (r) {
    return r as Response;
  }
  const uid = await requireUserId();
  if (typeof uid !== 'number') return uid;

  const json = await req.json().catch(() => null);
  const parsed = DeleteBody.safeParse(json);
  if (!parsed.success) return NextResponse.json({ error: 'bad request' }, { status: 400 });

  // Ownership-checked delete: refuse 404 if the stock isn't in any of THIS
  // user's portfolios. Without this, any signed-in user could delete any
  // stock by guessing its id.
  try {
    await assertOwnsStock(parsed.data.stockId, uid);
  } catch (r) {
    return r as Response;
  }

  const result = await db
    .delete(stocks)
    .where(eq(stocks.id, parsed.data.stockId))
    .returning({ id: stocks.id });
  if (result.length === 0) {
    return NextResponse.json({ error: 'not found' }, { status: 404 });
  }
  revalidateTag('portfolio');
  return NextResponse.json({ ok: true, deletedId: result[0].id });
}

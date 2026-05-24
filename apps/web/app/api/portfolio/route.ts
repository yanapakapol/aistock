import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { and, eq } from 'drizzle-orm';
import { db } from '@/lib/db/client';
import { stocks } from '@/lib/db/schema';
import { getDefaultPortfolioId, listStocks } from '@/lib/portfolio/queries';

export const runtime = 'nodejs';

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

export async function GET() {
  const rows = await listStocks();
  return NextResponse.json({ stocks: rows }, { headers: SWR_HEADERS });
}

export async function POST(req: NextRequest) {
  try {
    requireSameOrigin(req);
  } catch (r) {
    return r as Response;
  }
  const json = await req.json().catch(() => null);
  const parsed = AddBody.safeParse(json);
  if (!parsed.success) return NextResponse.json({ error: 'bad request' }, { status: 400 });

  const portfolioId = await getDefaultPortfolioId();
  const { symbol, exchange, name, currency, mic } = parsed.data;

  // Idempotent on (symbol, exchange) — return the existing row if present.
  const existing = await db
    .select()
    .from(stocks)
    .where(and(eq(stocks.symbol, symbol), eq(stocks.exchange, exchange)))
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
    return NextResponse.json({ stock: inserted[0], created: true }, { status: 201 });
  } catch (err) {
    return NextResponse.json(
      { error: 'insert failed', detail: (err as Error).message },
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
  const json = await req.json().catch(() => null);
  const parsed = DeleteBody.safeParse(json);
  if (!parsed.success) return NextResponse.json({ error: 'bad request' }, { status: 400 });
  const result = await db
    .delete(stocks)
    .where(eq(stocks.id, parsed.data.stockId))
    .returning({ id: stocks.id });
  if (result.length === 0) {
    return NextResponse.json({ error: 'not found' }, { status: 404 });
  }
  return NextResponse.json({ ok: true, deletedId: result[0].id });
}

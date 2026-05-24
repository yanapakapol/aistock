import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { ingestDailyForStock } from '@/lib/market/ingest';
import { getStockById } from '@/lib/portfolio/queries';
import { getCurrentUser } from '@/lib/auth/session';

export const runtime = 'nodejs';

const StockIdSchema = z.coerce.number().int().positive();

function requireSameOrigin(req: NextRequest) {
  const site = req.headers.get('sec-fetch-site');
  if (site && site !== 'same-origin') {
    throw new Response('cross-origin denied', { status: 403 });
  }
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ stockId: string }> },
) {
  try {
    requireSameOrigin(req);
  } catch (r) {
    return r as Response;
  }
  const me = await getCurrentUser().catch(() => null);
  if (!me) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  const { stockId: stockIdRaw } = await params;
  const parsed = StockIdSchema.safeParse(stockIdRaw);
  if (!parsed.success) {
    return NextResponse.json({ error: 'bad stockId' }, { status: 400 });
  }
  const stockId = parsed.data;

  // Ownership-scoped — refuse if the stock isn't in the caller's portfolios.
  const stock = await getStockById(stockId, me.id);
  if (!stock) {
    return NextResponse.json({ error: 'stock not found' }, { status: 404 });
  }

  try {
    const result = await ingestDailyForStock(
      stockId,
      stock.symbol,
      stock.exchange as Parameters<typeof ingestDailyForStock>[2],
    );
    return NextResponse.json({ ok: true, stockId, upserted: result.rows, ...result });
  } catch (err) {
    return NextResponse.json(
      { error: 'ingest failed', detail: (err as Error).message },
      { status: 502 },
    );
  }
}

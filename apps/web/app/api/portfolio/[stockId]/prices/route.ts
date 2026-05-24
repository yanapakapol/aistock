import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { and, asc, eq, gte, lte } from 'drizzle-orm';
import { db } from '@/lib/db/client';
import { pricesDaily } from '@/lib/db/schema';
import { getStockById } from '@/lib/portfolio/queries';

export const runtime = 'nodejs';

const StockIdSchema = z.coerce.number().int().positive();
const DateString = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'expected YYYY-MM-DD');

const QuerySchema = z.object({
  from: DateString.optional(),
  to: DateString.optional(),
});

function toISODate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ stockId: string }> },
) {
  const { stockId: stockIdRaw } = await params;
  const stockIdParsed = StockIdSchema.safeParse(stockIdRaw);
  if (!stockIdParsed.success) {
    return NextResponse.json({ error: 'bad stockId' }, { status: 400 });
  }
  const stockId = stockIdParsed.data;

  const url = new URL(req.url);
  const qParsed = QuerySchema.safeParse({
    from: url.searchParams.get('from') ?? undefined,
    to: url.searchParams.get('to') ?? undefined,
  });
  if (!qParsed.success) {
    return NextResponse.json({ error: 'bad request' }, { status: 400 });
  }

  const stock = await getStockById(stockId);
  if (!stock) {
    return NextResponse.json({ error: 'stock not found' }, { status: 404 });
  }

  const today = new Date();
  const defaultFrom = new Date(today);
  defaultFrom.setUTCDate(defaultFrom.getUTCDate() - 365);

  const from = qParsed.data.from ?? toISODate(defaultFrom);
  const to = qParsed.data.to ?? toISODate(today);

  const rows = await db
    .select()
    .from(pricesDaily)
    .where(
      and(eq(pricesDaily.stockId, stockId), gte(pricesDaily.date, from), lte(pricesDaily.date, to)),
    )
    .orderBy(asc(pricesDaily.date));

  // bigint volume isn't JSON-serializable by default; coerce.
  const serialized = rows.map((r) => ({
    ...r,
    volume: typeof r.volume === 'bigint' ? r.volume.toString() : r.volume,
  }));

  return NextResponse.json({ stockId, from, to, prices: serialized });
}

import 'server-only';
import { sql } from 'drizzle-orm';
import { db } from '@/lib/db/client';
import { pricesDaily } from '@/lib/db/schema';
import { getAdapter } from './index';
import type { Exchange } from './types';

export interface IngestResult {
  symbol: string;
  exchange: Exchange;
  rows: number;
  from: string;
  to: string;
  source: string;
}

export async function ingestDailyForStock(
  stockId: number,
  symbol: string,
  exchange: Exchange,
  lookbackDays = 365,
): Promise<IngestResult> {
  const adapter = getAdapter();
  const to = new Date();
  const from = new Date(to.getTime() - lookbackDays * 24 * 60 * 60 * 1000);
  const bars = await adapter.getDailyOhlcv(symbol, exchange, from, to);
  if (bars.length === 0) {
    return { symbol, exchange, rows: 0, from: iso(from), to: iso(to), source: adapter.name };
  }

  const rows = bars.map((b) => ({
    stockId,
    date: b.date,
    open: String(b.open),
    high: String(b.high),
    low: String(b.low),
    close: String(b.close),
    volume: BigInt(Math.trunc(b.volume)),
    source: adapter.name,
  }));

  await db
    .insert(pricesDaily)
    .values(rows)
    .onConflictDoUpdate({
      target: [pricesDaily.stockId, pricesDaily.date],
      set: {
        open: sql`excluded.open`,
        high: sql`excluded.high`,
        low: sql`excluded.low`,
        close: sql`excluded.close`,
        volume: sql`excluded.volume`,
        source: sql`excluded.source`,
      },
    });

  return {
    symbol,
    exchange,
    rows: rows.length,
    from: iso(from),
    to: iso(to),
    source: adapter.name,
  };
}

function iso(d: Date): string {
  return d.toISOString().slice(0, 10);
}

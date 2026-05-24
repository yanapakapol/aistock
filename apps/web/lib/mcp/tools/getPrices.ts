import { z } from 'zod';
import { and, between, eq, asc } from 'drizzle-orm';
import { db } from '@/lib/db/client';
import { pricesDaily } from '@/lib/db/schema';
import type { ToolHandler } from '../types';

const input = z.object({
  stock_id: z.number().int().positive(),
  from: z.string().describe('ISO date (YYYY-MM-DD) inclusive lower bound'),
  to: z.string().describe('ISO date (YYYY-MM-DD) inclusive upper bound'),
  interval: z
    .literal('1d')
    .default('1d')
    .describe('Only "1d" is supported here; use get_prices_intraday for finer bars.'),
});
type Input = z.infer<typeof input>;

const bar = z.object({
  date: z.string(),
  open: z.number(),
  high: z.number(),
  low: z.number(),
  close: z.number(),
  volume: z.number(),
  source: z.string(),
});
const output = z.object({ bars: z.array(bar) });
type Output = z.infer<typeof output>;

export const getPrices: ToolHandler<Input, Output> = {
  name: 'get_prices',
  description:
    'Daily OHLCV rows for a stock between `from` and `to` (inclusive). Use this for day-level price queries; ranges are bounded by what the ingestion job has already loaded into prices_daily.',
  input,
  output,
  async execute({ stock_id, from, to }) {
    const rows = await db
      .select()
      .from(pricesDaily)
      .where(
        and(
          eq(pricesDaily.stockId, stock_id),
          between(pricesDaily.date, from, to),
        ),
      )
      .orderBy(asc(pricesDaily.date));
    return {
      bars: rows.map((r) => ({
        date: r.date as unknown as string,
        open: Number(r.open),
        high: Number(r.high),
        low: Number(r.low),
        close: Number(r.close),
        // bigint -> number; volumes fit in 2^53 for all real-world equities.
        volume: Number(r.volume),
        source: r.source,
      })),
    };
  },
};

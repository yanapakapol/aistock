import { z } from 'zod';
import { and, between, eq, asc } from 'drizzle-orm';
import { db } from '@/lib/db/client';
import { pricesIntraday } from '@/lib/db/schema';
import type { ToolHandler } from '../types';
import { assertOwnsStock } from '../ownership';

const input = z.object({
  stock_id: z.number().int().positive(),
  around_ts: z.string().describe('ISO timestamp the window is centered on'),
  window_days: z
    .number()
    .int()
    .min(1)
    .max(10)
    .default(2)
    .describe('Days on each side of around_ts to fetch'),
  interval: z
    .string()
    .default('1h')
    .describe('Interval label as stored on prices_intraday.interval, e.g. "1m","5m","1h"'),
});
type Input = z.infer<typeof input>;

const bar = z.object({
  ts: z.string(),
  interval: z.string(),
  ohlcv: z.unknown(),
  source: z.string(),
});
const output = z.object({ bars: z.array(bar) });
type Output = z.infer<typeof output>;

const MS_PER_DAY = 86_400_000;

export const getPricesIntraday: ToolHandler<Input, Output> = {
  name: 'get_prices_intraday',
  description:
    'Intraday OHLCV bars stored around event timestamps. Returns rows from prices_intraday for the given stock within ±window_days of around_ts at the requested interval.',
  input,
  output,
  async execute({ stock_id, around_ts, window_days, interval }, ctx) {
    await assertOwnsStock(stock_id, ctx);
    const center = new Date(around_ts);
    if (Number.isNaN(center.getTime())) {
      throw new Error(`around_ts is not a valid timestamp: ${around_ts}`);
    }
    const from = new Date(center.getTime() - window_days * MS_PER_DAY);
    const to = new Date(center.getTime() + window_days * MS_PER_DAY);

    const rows = await db
      .select()
      .from(pricesIntraday)
      .where(
        and(
          eq(pricesIntraday.stockId, stock_id),
          eq(pricesIntraday.interval, interval),
          between(pricesIntraday.ts, from, to),
        ),
      )
      .orderBy(asc(pricesIntraday.ts));

    return {
      bars: rows.map((r) => ({
        ts: r.ts.toISOString(),
        interval: r.interval,
        ohlcv: r.ohlcv,
        source: r.source,
      })),
    };
  },
};

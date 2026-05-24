import { z } from 'zod';
import { and, desc, eq, inArray } from 'drizzle-orm';
import { db } from '@/lib/db/client';
import { fundamentals } from '@/lib/db/schema';
import type { ToolHandler } from '../types';
import { assertOwnsStock } from '../ownership';

const input = z.object({
  stock_id: z.number().int().positive(),
  metrics: z
    .array(z.string().min(1))
    .min(1)
    .describe('Metric names to filter on, e.g. ["pe","revenue","eps"]'),
});
type Input = z.infer<typeof input>;

const row = z.object({
  period: z.string(),
  metric: z.string(),
  value: z.number(),
  source: z.string(),
  fetched_at: z.string(),
});
const output = z.object({ rows: z.array(row) });
type Output = z.infer<typeof output>;

export const getFundamentals: ToolHandler<Input, Output> = {
  name: 'get_fundamentals',
  description:
    'Fundamental metrics (revenue, eps, pe, etc.) recorded for a stock. Filters by the supplied metric names. Most recent fetch first.',
  input,
  output,
  async execute({ stock_id, metrics }, ctx) {
    await assertOwnsStock(stock_id, ctx);
    const rows = await db
      .select()
      .from(fundamentals)
      .where(
        and(
          eq(fundamentals.stockId, stock_id),
          inArray(fundamentals.metric, metrics),
        ),
      )
      .orderBy(desc(fundamentals.fetchedAt));
    return {
      rows: rows.map((r) => ({
        period: r.period,
        metric: r.metric,
        value: Number(r.value),
        source: r.source,
        fetched_at: r.fetchedAt.toISOString(),
      })),
    };
  },
};

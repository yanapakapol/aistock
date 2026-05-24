import { z } from 'zod';
import { and, eq } from 'drizzle-orm';
import { db } from '@/lib/db/client';
import { futureEvents } from '@/lib/db/schema';
import type { ToolHandler } from '../types';
import { assertOwnsStock } from '../ownership';

const input = z.object({
  stock_id: z.number().int().positive(),
  expected_date: z.string().describe('ISO date (YYYY-MM-DD)'),
  date_precision: z.enum(['day', 'week', 'month']).default('day'),
  title: z.string().min(1),
  description_md: z.string(),
  probability_positive: z.number().min(0).max(1).optional(),
  probability_negative: z.number().min(0).max(1).optional(),
  expected_impact_pct: z.number().optional(),
  source_urls: z.array(z.string().url()).default([]),
});
type Input = z.infer<typeof input>;

const output = z.object({
  id: z.number().int(),
  action: z.enum(['inserted', 'updated']),
});
type Output = z.infer<typeof output>;

export const upsertFutureEvent: ToolHandler<Input, Output> = {
  name: 'upsert_future_event',
  description:
    'Insert a forward-looking event, or update the existing row if (stock_id, expected_date, title) already match. Used to record earnings calendars, expected announcements, and regulatory dates with probability estimates.',
  input,
  output,
  async execute(args, ctx) {
    await assertOwnsStock(args.stock_id, ctx);
    const existing = (
      await db
        .select({ id: futureEvents.id })
        .from(futureEvents)
        .where(
          and(
            eq(futureEvents.stockId, args.stock_id),
            eq(futureEvents.expectedDate, args.expected_date),
            eq(futureEvents.title, args.title),
          ),
        )
        .limit(1)
    )[0];

    const values = {
      stockId: args.stock_id,
      expectedDate: args.expected_date,
      datePrecision: args.date_precision,
      title: args.title,
      descriptionMd: args.description_md,
      probabilityPositive:
        args.probability_positive == null ? null : args.probability_positive.toFixed(3),
      probabilityNegative:
        args.probability_negative == null ? null : args.probability_negative.toFixed(3),
      expectedImpactPct:
        args.expected_impact_pct == null ? null : args.expected_impact_pct.toFixed(3),
      sourceUrls: args.source_urls,
    };

    if (existing) {
      await db
        .update(futureEvents)
        .set(values)
        .where(eq(futureEvents.id, existing.id));
      return { id: existing.id, action: 'updated' };
    }

    const inserted = await db
      .insert(futureEvents)
      .values(values)
      .returning({ id: futureEvents.id });
    const newId = inserted[0]?.id;
    if (newId == null) throw new Error('upsert_future_event: insert returned no id');
    return { id: newId, action: 'inserted' };
  },
};

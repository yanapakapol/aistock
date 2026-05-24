import { z } from 'zod';
import { asc, eq } from 'drizzle-orm';
import { db } from '@/lib/db/client';
import { futureEvents } from '@/lib/db/schema';
import type { ToolHandler } from '../types';

const input = z.object({ stock_id: z.number().int().positive() });
type Input = z.infer<typeof input>;

const fe = z.object({
  id: z.number().int(),
  expected_date: z.string(),
  date_precision: z.enum(['day', 'week', 'month']),
  title: z.string(),
  description_md: z.string(),
  probability_positive: z.number().nullable(),
  probability_negative: z.number().nullable(),
  expected_impact_pct: z.number().nullable(),
  source_urls: z.array(z.string()),
  created_at: z.string(),
});
const output = z.object({ future_events: z.array(fe) });
type Output = z.infer<typeof output>;

export const getFutureEvents: ToolHandler<Input, Output> = {
  name: 'get_future_events',
  description:
    'Forward-looking events on the calendar for a stock (earnings, expected announcements, regulatory dates) ordered by expected_date ascending.',
  input,
  output,
  async execute({ stock_id }) {
    const rows = await db
      .select()
      .from(futureEvents)
      .where(eq(futureEvents.stockId, stock_id))
      .orderBy(asc(futureEvents.expectedDate));

    return {
      future_events: rows.map((r) => ({
        id: r.id,
        expected_date: r.expectedDate as unknown as string,
        date_precision: r.datePrecision,
        title: r.title,
        description_md: r.descriptionMd,
        probability_positive:
          r.probabilityPositive == null ? null : Number(r.probabilityPositive),
        probability_negative:
          r.probabilityNegative == null ? null : Number(r.probabilityNegative),
        expected_impact_pct:
          r.expectedImpactPct == null ? null : Number(r.expectedImpactPct),
        source_urls: r.sourceUrls ?? [],
        created_at: r.createdAt.toISOString(),
      })),
    };
  },
};

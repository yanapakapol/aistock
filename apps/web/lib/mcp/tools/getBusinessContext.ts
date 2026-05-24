import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { db } from '@/lib/db/client';
import { businessContext } from '@/lib/db/schema';
import type { ToolHandler } from '../types';
import { assertOwnsStock } from '../ownership';

const input = z.object({ stock_id: z.number().int().positive() });
type Input = z.infer<typeof input>;

const output = z.object({
  found: z.boolean(),
  summary_md: z.string(),
  timeline_md: z.string(),
  future_outlook_md: z.string(),
  updated_at: z.string().nullable(),
});
type Output = z.infer<typeof output>;

export const getBusinessContext: ToolHandler<Input, Output> = {
  name: 'get_business_context',
  description:
    'Returns the merged business-context document for a stock (summary, historical timeline, forward outlook). Empty strings if no row has been written yet.',
  input,
  output,
  async execute({ stock_id }, ctx) {
    await assertOwnsStock(stock_id, ctx);
    const row = (
      await db
        .select()
        .from(businessContext)
        .where(eq(businessContext.stockId, stock_id))
        .limit(1)
    )[0];

    if (!row) {
      return {
        found: false,
        summary_md: '',
        timeline_md: '',
        future_outlook_md: '',
        updated_at: null,
      };
    }
    return {
      found: true,
      summary_md: row.summaryMd,
      timeline_md: row.timelineMd,
      future_outlook_md: row.futureOutlookMd,
      updated_at: row.updatedAt.toISOString(),
    };
  },
};

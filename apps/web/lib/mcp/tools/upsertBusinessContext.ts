import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { db } from '@/lib/db/client';
import { businessContext } from '@/lib/db/schema';
import type { ToolHandler } from '../types';
import { assertOwnsStock } from '../ownership';

const input = z.object({
  stock_id: z.number().int().positive(),
  patch_md: z
    .string()
    .describe(
      'Markdown to append to summary_md. The caller LLM is responsible for any clever merging — this tool only appends and stamps updatedAt.',
    ),
  section: z
    .enum(['summary', 'timeline', 'future_outlook'])
    .default('summary')
    .describe('Which section the patch belongs to. Defaults to summary.'),
});
type Input = z.infer<typeof input>;

const output = z.object({
  stock_id: z.number().int(),
  action: z.enum(['inserted', 'updated']),
  updated_at: z.string(),
});
type Output = z.infer<typeof output>;

function appendMd(prev: string, patch: string): string {
  if (!prev) return patch;
  if (!patch) return prev;
  return prev.endsWith('\n') ? prev + patch : prev + '\n\n' + patch;
}

export const upsertBusinessContext: ToolHandler<Input, Output> = {
  name: 'upsert_business_context',
  description:
    'Appends a markdown patch to a stock\'s business_context row (summary/timeline/future_outlook). Creates the row if missing. The caller LLM does the semantic merge and passes the final patch text — this tool deliberately does not try to be clever.',
  input,
  output,
  async execute({ stock_id, patch_md, section }, ctx) {
    await assertOwnsStock(stock_id, ctx);
    const existing = (
      await db
        .select()
        .from(businessContext)
        .where(eq(businessContext.stockId, stock_id))
        .limit(1)
    )[0];

    const now = new Date();

    if (!existing) {
      const values = {
        stockId: stock_id,
        summaryMd: section === 'summary' ? patch_md : '',
        timelineMd: section === 'timeline' ? patch_md : '',
        futureOutlookMd: section === 'future_outlook' ? patch_md : '',
        updatedAt: now,
      };
      await db.insert(businessContext).values(values);
      return { stock_id, action: 'inserted', updated_at: now.toISOString() };
    }

    const next: Record<string, string | Date> = { updatedAt: now };
    if (section === 'summary') next.summaryMd = appendMd(existing.summaryMd, patch_md);
    if (section === 'timeline') next.timelineMd = appendMd(existing.timelineMd, patch_md);
    if (section === 'future_outlook')
      next.futureOutlookMd = appendMd(existing.futureOutlookMd, patch_md);

    await db
      .update(businessContext)
      .set(next)
      .where(eq(businessContext.stockId, stock_id));
    return { stock_id, action: 'updated', updated_at: now.toISOString() };
  },
};

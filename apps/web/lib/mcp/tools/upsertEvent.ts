import { z } from 'zod';
import { and, eq } from 'drizzle-orm';
import { db } from '@/lib/db/client';
import { events } from '@/lib/db/schema';
import type { ToolHandler } from '../types';

const input = z.object({
  stock_id: z.number().int().positive(),
  event_date: z.string().describe('ISO date (YYYY-MM-DD) of the event'),
  event_ts: z.string().optional().describe('Optional ISO timestamp for intraday precision'),
  event_tz: z.string().optional(),
  date_precision: z.enum(['day', 'week', 'month']).default('day'),
  session_relative: z.enum(['pre', 'intraday', 'post', 'overnight']).optional(),
  title: z.string().min(1),
  summary_md: z.string(),
  source_url: z.string().url(),
  source_title: z.string().optional(),
  sentiment_score: z.number().min(-1).max(1).optional(),
  sentiment_label: z.enum(['bull', 'bear', 'neutral']).optional(),
});
type Input = z.infer<typeof input>;

const output = z.object({
  id: z.number().int(),
  action: z.enum(['inserted', 'updated']),
});
type Output = z.infer<typeof output>;

export const upsertEvent: ToolHandler<Input, Output> = {
  name: 'upsert_event',
  description:
    'Insert a historical event, or update the existing row if (stock_id, event_date, title) already match. Used by the research loop to record dated news with sources.',
  input,
  output,
  async execute(args) {
    const existing = (
      await db
        .select({ id: events.id })
        .from(events)
        .where(
          and(
            eq(events.stockId, args.stock_id),
            eq(events.eventDate, args.event_date),
            eq(events.title, args.title),
          ),
        )
        .limit(1)
    )[0];

    const values = {
      stockId: args.stock_id,
      eventDate: args.event_date,
      eventTs: args.event_ts ? new Date(args.event_ts) : null,
      eventTz: args.event_tz ?? null,
      datePrecision: args.date_precision,
      sessionRelative: args.session_relative ?? null,
      title: args.title,
      summaryMd: args.summary_md,
      sourceUrl: args.source_url,
      sourceTitle: args.source_title ?? null,
      sentimentScore:
        args.sentiment_score == null ? null : args.sentiment_score.toFixed(2),
      sentimentLabel: args.sentiment_label ?? null,
    };

    if (existing) {
      await db.update(events).set(values).where(eq(events.id, existing.id));
      return { id: existing.id, action: 'updated' };
    }

    const inserted = await db.insert(events).values(values).returning({ id: events.id });
    const newId = inserted[0]?.id;
    if (newId == null) throw new Error('upsert_event: insert returned no id');
    return { id: newId, action: 'inserted' };
  },
};

import { z } from 'zod';
import { and, between, eq, desc, gte, lte } from 'drizzle-orm';
import { db } from '@/lib/db/client';
import { events } from '@/lib/db/schema';
import type { ToolHandler } from '../types';
import { assertOwnsStock } from '../ownership';

const input = z.object({
  stock_id: z.number().int().positive(),
  from: z.string().optional().describe('ISO date inclusive lower bound (optional)'),
  to: z.string().optional().describe('ISO date inclusive upper bound (optional)'),
  limit: z.number().int().min(1).max(500).default(100),
});
type Input = z.infer<typeof input>;

const event = z.object({
  id: z.number().int(),
  event_date: z.string(),
  event_ts: z.string().nullable(),
  event_tz: z.string().nullable(),
  date_precision: z.enum(['day', 'week', 'month']),
  session_relative: z.enum(['pre', 'intraday', 'post', 'overnight']).nullable(),
  title: z.string(),
  summary_md: z.string(),
  source_url: z.string(),
  source_title: z.string().nullable(),
  sentiment_score: z.number().nullable(),
  sentiment_label: z.enum(['bull', 'bear', 'neutral']).nullable(),
  created_at: z.string(),
});
const output = z.object({ events: z.array(event) });
type Output = z.infer<typeof output>;

export const getEvents: ToolHandler<Input, Output> = {
  name: 'get_events',
  description:
    'Historical events recorded for a stock, optionally filtered by date range. Most recent first. Returns up to `limit` rows (default 100).',
  input,
  output,
  async execute({ stock_id, from, to, limit }, ctx) {
    await assertOwnsStock(stock_id, ctx);
    const conds = [eq(events.stockId, stock_id)];
    if (from && to) conds.push(between(events.eventDate, from, to));
    else if (from) conds.push(gte(events.eventDate, from));
    else if (to) conds.push(lte(events.eventDate, to));

    const rows = await db
      .select()
      .from(events)
      .where(and(...conds))
      .orderBy(desc(events.eventDate))
      .limit(limit);

    return {
      events: rows.map((r) => ({
        id: r.id,
        event_date: r.eventDate as unknown as string,
        event_ts: r.eventTs ? r.eventTs.toISOString() : null,
        event_tz: r.eventTz,
        date_precision: r.datePrecision,
        session_relative: r.sessionRelative,
        title: r.title,
        summary_md: r.summaryMd,
        source_url: r.sourceUrl,
        source_title: r.sourceTitle,
        sentiment_score: r.sentimentScore == null ? null : Number(r.sentimentScore),
        sentiment_label: r.sentimentLabel,
        created_at: r.createdAt.toISOString(),
      })),
    };
  },
};

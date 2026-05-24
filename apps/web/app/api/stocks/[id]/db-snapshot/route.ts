import { NextResponse, type NextRequest } from 'next/server';
import { desc, eq, sql } from 'drizzle-orm';
import { db } from '@/lib/db/client';
import {
  events,
  futureEvents,
  businessContext,
  pricesDaily,
  researchTasks,
  newsChunks,
  researchNotes,
  businessContextChunks,
  stocks,
} from '@/lib/db/schema';

export const runtime = 'nodejs';

/**
 * GET /api/stocks/:id/db-snapshot — returns every Postgres row tied to this
 * stock so the user can audit exactly what the platform has stored.
 *
 * Returns:
 *   stock                — stocks row
 *   events[]             — all past events (newest first)
 *   future_events[]      — all forward-looking events
 *   business_context     — single merged context row (or null)
 *   research_tasks[]     — driver checklist
 *   prices_summary       — {count, from, to, latestClose}
 *   rag_counts           — chunk counts per RAG table
 */
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const id = Number((await params).id);
  if (!Number.isFinite(id) || id <= 0) {
    return NextResponse.json({ error: 'bad id' }, { status: 400 });
  }
  const [stock] = await db.select().from(stocks).where(eq(stocks.id, id)).limit(1);
  if (!stock) return NextResponse.json({ error: 'not found' }, { status: 404 });

  const [eventsRows, futureRows, ctxRow, tasksRows, priceAgg, newsCount, notesCount, ctxChunksCount] =
    await Promise.all([
      db.select().from(events).where(eq(events.stockId, id)).orderBy(desc(events.eventDate)).limit(500),
      db
        .select()
        .from(futureEvents)
        .where(eq(futureEvents.stockId, id))
        .orderBy(futureEvents.expectedDate),
      db.select().from(businessContext).where(eq(businessContext.stockId, id)).limit(1),
      db
        .select()
        .from(researchTasks)
        .where(eq(researchTasks.stockId, id))
        .orderBy(desc(researchTasks.updatedAt))
        .limit(200),
      db
        .select({
          count: sql<number>`count(*)::int`,
          fromDate: sql<string | null>`min(date)::text`,
          toDate: sql<string | null>`max(date)::text`,
          latestClose: sql<string | null>`(select close::text from prices_daily where stock_id = ${id} order by date desc limit 1)`,
        })
        .from(pricesDaily)
        .where(eq(pricesDaily.stockId, id)),
      db
        .select({ count: sql<number>`count(*)::int` })
        .from(newsChunks)
        .where(eq(newsChunks.stockId, id)),
      db
        .select({ count: sql<number>`count(*)::int` })
        .from(researchNotes)
        .where(eq(researchNotes.stockId, id)),
      db
        .select({ count: sql<number>`count(*)::int` })
        .from(businessContextChunks)
        .where(eq(businessContextChunks.stockId, id)),
    ]);

  // Drizzle returns camelCase; the chat tool renderers expect snake_case (they
  // also consume MCP tool output). Map every row before returning so the same
  // <DbEventsBlock /> etc. work for both pipelines.
  return NextResponse.json({
    stock,
    events: eventsRows.map((r) => ({
      id: r.id,
      stock_id: r.stockId,
      event_date: r.eventDate,
      event_ts: r.eventTs,
      event_tz: r.eventTz,
      date_precision: r.datePrecision,
      session_relative: r.sessionRelative,
      title: r.title,
      summary_md: r.summaryMd,
      source_url: r.sourceUrl,
      source_title: r.sourceTitle,
      sentiment_label: r.sentimentLabel,
      sentiment_score: r.sentimentScore == null ? null : Number(r.sentimentScore),
      created_at: r.createdAt,
    })),
    future_events: futureRows.map((r) => ({
      id: r.id,
      stock_id: r.stockId,
      expected_date: r.expectedDate,
      date_precision: r.datePrecision,
      title: r.title,
      description_md: r.descriptionMd,
      probability_positive:
        r.probabilityPositive == null ? null : Number(r.probabilityPositive),
      probability_negative:
        r.probabilityNegative == null ? null : Number(r.probabilityNegative),
      expected_impact_pct:
        r.expectedImpactPct == null ? null : Number(r.expectedImpactPct),
      source_urls: r.sourceUrls,
      created_at: r.createdAt,
    })),
    business_context: ctxRow[0]
      ? {
          stock_id: ctxRow[0].stockId,
          summary_md: ctxRow[0].summaryMd,
          timeline_md: ctxRow[0].timelineMd,
          future_outlook_md: ctxRow[0].futureOutlookMd,
          updated_at: ctxRow[0].updatedAt,
        }
      : null,
    research_tasks: tasksRows.map((t) => ({
      id: t.id,
      driver: t.driver,
      status: t.status,
      updatedAt: t.updatedAt,
    })),
    prices_summary: priceAgg[0] ?? { count: 0, fromDate: null, toDate: null, latestClose: null },
    rag_counts: {
      news_chunks: newsCount[0]?.count ?? 0,
      research_notes: notesCount[0]?.count ?? 0,
      business_context_chunks: ctxChunksCount[0]?.count ?? 0,
    },
  });
}

// Connection-pool note: `@/lib/db/client` exports a singleton `postgres()` pool
// (max=10) cached on globalThis. Every `db.select(...)` here borrows from that
// same pool — Drizzle does NOT open a new TCP connection per query. The 8
// queries in the Promise.all below execute on (up to) 8 pooled connections
// concurrently and return them on completion. Do not import `postgres` or
// `drizzle` directly elsewhere — always go through `@/lib/db/client` so we
// stay under Neon's connection limit.
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
import { getCurrentUser } from '@/lib/auth/session';
import { getStockById } from '@/lib/portfolio/queries';

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
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  // ?fields=full returns the verbose legacy shape (stock_id, event_ts,
  // date_precision, sentiment_score, probability_negative, created_at, etc.).
  // Default omits those — they aren't rendered by db-snapshot-panel or any
  // tool renderer, and dropping them ~halves the payload on chatty stocks.
  const me = await getCurrentUser().catch(() => null);
  if (!me) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  const wantsFull = req.nextUrl.searchParams.get('fields') === 'full';
  const id = Number((await params).id);
  if (!Number.isFinite(id) || id <= 0) {
    return NextResponse.json({ error: 'bad id' }, { status: 400 });
  }
  // Ownership-scoped: refuse if the stock isn't in the caller's portfolios.
  // Returns 404 (not 403) on purpose — don't disclose whether the id exists
  // in another user's portfolio.
  const stock = await getStockById(id, me.id);
  if (!stock) return NextResponse.json({ error: 'not found' }, { status: 404 });
  // Silence the unused-import lint for the legacy `stocks` table reference
  // (we used to read it directly; ownership check goes through the helper).
  void stocks;

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
    events: eventsRows.map((r) =>
      wantsFull
        ? {
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
          }
        : {
            // Narrow shape — only fields the renderer actually reads.
            id: r.id,
            event_date: r.eventDate,
            title: r.title,
            summary_md: r.summaryMd,
            source_url: r.sourceUrl,
            source_title: r.sourceTitle,
            sentiment_label: r.sentimentLabel,
          },
    ),
    future_events: futureRows.map((r) =>
      wantsFull
        ? {
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
          }
        : {
            id: r.id,
            expected_date: r.expectedDate,
            title: r.title,
            description_md: r.descriptionMd,
            probability_positive:
              r.probabilityPositive == null ? null : Number(r.probabilityPositive),
            expected_impact_pct:
              r.expectedImpactPct == null ? null : Number(r.expectedImpactPct),
            source_urls: r.sourceUrls,
          },
    ),
    business_context: ctxRow[0]
      ? wantsFull
        ? {
            stock_id: ctxRow[0].stockId,
            summary_md: ctxRow[0].summaryMd,
            timeline_md: ctxRow[0].timelineMd,
            future_outlook_md: ctxRow[0].futureOutlookMd,
            updated_at: ctxRow[0].updatedAt,
          }
        : {
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
    },
    {
      headers: { 'Cache-Control': 'private, max-age=60, stale-while-revalidate=600' },
    },
  );
}

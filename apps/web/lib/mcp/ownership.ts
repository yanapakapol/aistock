import 'server-only';
import { sql } from 'drizzle-orm';
import { db } from '@/lib/db/client';
import type { ToolCtx } from './types';

/**
 * Ownership predicate for stock-scoped MCP tools.
 *
 * Throws if `ctx.userId` is undefined (no authenticated caller) or if the
 * given stock id does not belong to one of that user's portfolios. The
 * thrown Error is intentionally generic so the LLM doesn't get a hint
 * about whether other users' ids exist.
 *
 * Every tool that takes a `stockId` (or `stock_id`) MUST call this before
 * any read/write on stock-scoped tables (events, future_events,
 * business_context, prices_*, fundamentals, research_tasks, *_chunks).
 * If the call is skipped, a malicious LLM can read another user's events
 * by guessing stock ids.
 */
export async function assertOwnsStock(stockId: number, ctx: ToolCtx): Promise<void> {
  if (!ctx.userId) {
    throw new Error('forbidden: no authenticated user');
  }
  const rows = (await db.execute(sql`
    SELECT 1 FROM stocks s
    JOIN portfolios p ON p.id = s.portfolio_id
    WHERE s.id = ${stockId} AND p.user_id = ${ctx.userId}
    LIMIT 1
  `)) as unknown as Array<{ '?column?': number }>;
  if (rows.length === 0) {
    throw new Error('forbidden: stock not in your portfolio');
  }
}

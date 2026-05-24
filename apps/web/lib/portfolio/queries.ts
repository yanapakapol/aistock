import 'server-only';
import { and, eq, desc } from 'drizzle-orm';
import { db } from '@/lib/db/client';
import { portfolios, stocks } from '@/lib/db/schema';

const DEFAULT_PORTFOLIO_NAME = 'Default';

/**
 * Returns the id of the caller's "Default" portfolio, creating it if it does
 * not exist. Per-user: each user gets their own Default portfolio.
 *
 * Safe to call concurrently — uses a transaction with a SELECT-then-INSERT
 * scoped by user_id. (No unique constraint on portfolios(user_id, name)
 * because legacy rows pre-date this convention; we serialize via tx for the
 * common path.)
 */
export async function getDefaultPortfolioId(userId: number): Promise<number> {
  return await db.transaction(async (tx) => {
    const existing = await tx
      .select({ id: portfolios.id })
      .from(portfolios)
      .where(
        and(eq(portfolios.name, DEFAULT_PORTFOLIO_NAME), eq(portfolios.userId, userId)),
      )
      .limit(1);
    if (existing.length > 0) return existing[0].id;
    const inserted = await tx
      .insert(portfolios)
      .values({ name: DEFAULT_PORTFOLIO_NAME, userId })
      .returning({ id: portfolios.id });
    return inserted[0].id;
  });
}

/**
 * Lists the caller's watchlist (their portfolio's stocks). Per-user filter
 * is mandatory — without it, a multi-tenant deploy would leak every user's
 * stocks to every other user.
 *
 * No data cache here on purpose: per-user keys would explode the cache and
 * `revalidateTag` already invalidates globally on every write. At our scale
 * the direct DB hit is fine; reintroduce caching if listStocks shows up in
 * profiling.
 */
export async function listStocks(userId: number) {
  return await db
    .select({
      id: stocks.id,
      symbol: stocks.symbol,
      exchange: stocks.exchange,
      name: stocks.name,
      currency: stocks.currency,
      addedAt: stocks.addedAt,
    })
    .from(stocks)
    .innerJoin(portfolios, eq(stocks.portfolioId, portfolios.id))
    .where(eq(portfolios.userId, userId))
    .orderBy(desc(stocks.addedAt));
}

/** Full row including portfolioId + mic. Use only when a caller actually needs them. */
export async function listStocksFull(userId: number) {
  return await db
    .select({
      id: stocks.id,
      portfolioId: stocks.portfolioId,
      symbol: stocks.symbol,
      exchange: stocks.exchange,
      mic: stocks.mic,
      name: stocks.name,
      currency: stocks.currency,
      addedAt: stocks.addedAt,
    })
    .from(stocks)
    .innerJoin(portfolios, eq(stocks.portfolioId, portfolios.id))
    .where(eq(portfolios.userId, userId))
    .orderBy(desc(stocks.addedAt));
}

/**
 * Fetches a stock by id ONLY if it belongs to the given user. Returns null
 * otherwise. The join through portfolios is the single source of truth for
 * stock ownership — every route that takes a stock id from the URL or
 * request body MUST go through this function (or an equivalent join) before
 * reading any stock-scoped data.
 */
export async function getStockById(id: number, userId: number) {
  const rows = await db
    .select({
      id: stocks.id,
      portfolioId: stocks.portfolioId,
      symbol: stocks.symbol,
      exchange: stocks.exchange,
      mic: stocks.mic,
      name: stocks.name,
      currency: stocks.currency,
      addedAt: stocks.addedAt,
    })
    .from(stocks)
    .innerJoin(portfolios, eq(stocks.portfolioId, portfolios.id))
    .where(and(eq(stocks.id, id), eq(portfolios.userId, userId)))
    .limit(1);
  return rows[0] ?? null;
}

/**
 * Server-side ownership predicate used in DELETE / mutating routes. Throws
 * a 404-shaped Response if the stock does not belong to the user, so the
 * caller can `try { await assertOwnsStock(id, uid) } catch (r) { return r }`.
 */
export async function assertOwnsStock(id: number, userId: number): Promise<void> {
  const s = await getStockById(id, userId);
  if (!s) {
    throw new Response(JSON.stringify({ error: 'not found' }), {
      status: 404,
      headers: { 'content-type': 'application/json' },
    });
  }
}

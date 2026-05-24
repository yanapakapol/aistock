import 'server-only';
import { unstable_cache } from 'next/cache';
import { and, eq, desc } from 'drizzle-orm';
import { db } from '@/lib/db/client';
import { portfolios, stocks } from '@/lib/db/schema';

const DEFAULT_PORTFOLIO_NAME = 'Default';

/**
 * Returns the id of the caller's "Default" portfolio, creating it if it does
 * not exist. Per-user: each user gets their own Default portfolio.
 *
 * Used to wrap the SELECT-then-INSERT in a Drizzle transaction for
 * concurrency safety, but the HTTP driver (neon-http) doesn't support
 * .transaction(cb). The rare SELECT/SELECT/INSERT/INSERT race could
 * produce two "Default" portfolios for the same user — at our scale
 * that's roughly never (a single user makes at most one concurrent
 * first-time request) and on subsequent calls the SELECT branch still
 * picks one deterministically. If it ever becomes a real problem, add
 * a partial unique index `ON portfolios (user_id) WHERE name = 'Default'`
 * and catch the duplicate-key error to re-select.
 */
export async function getDefaultPortfolioId(userId: number): Promise<number> {
  const existing = await db
    .select({ id: portfolios.id })
    .from(portfolios)
    .where(
      and(eq(portfolios.name, DEFAULT_PORTFOLIO_NAME), eq(portfolios.userId, userId)),
    )
    .limit(1);
  if (existing.length > 0) return existing[0].id;
  const inserted = await db
    .insert(portfolios)
    .values({ name: DEFAULT_PORTFOLIO_NAME, userId })
    .returning({ id: portfolios.id });
  return inserted[0].id;
}

/**
 * Lists the caller's watchlist (their portfolio's stocks). Per-user filter
 * is mandatory — without it, a multi-tenant deploy would leak every user's
 * stocks to every other user.
 *
 * Cached via `unstable_cache` keyed by userId: the function-of-function
 * pattern below is required because Next 15's `unstable_cache` needs the
 * userId baked into the key array to produce a per-user entry. Mutating
 * endpoints call `revalidateTag('portfolio')` to invalidate every user's
 * entry at once on write.
 */
async function listStocksRaw(userId: number) {
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

export const listStocks = (userId: number) =>
  unstable_cache(
    async () => listStocksRaw(userId),
    ['portfolio:list-stocks', String(userId)],
    { revalidate: 60, tags: ['portfolio'] },
  )();

/** Full row including portfolioId + mic. Use only when a caller actually needs them. */
async function listStocksFullRaw(userId: number) {
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

export const listStocksFull = (userId: number) =>
  unstable_cache(
    async () => listStocksFullRaw(userId),
    ['portfolio:list-stocks-full', String(userId)],
    { revalidate: 60, tags: ['portfolio'] },
  )();

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

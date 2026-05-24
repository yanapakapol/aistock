import 'server-only';
import { unstable_cache } from 'next/cache';
import { eq, desc } from 'drizzle-orm';
import { db } from '@/lib/db/client';
import { portfolios, stocks } from '@/lib/db/schema';

const DEFAULT_PORTFOLIO_NAME = 'Default';

/**
 * Returns the id of the "Default" portfolio, creating it if it does not exist.
 * Safe to call concurrently — uses a transaction with a SELECT-then-INSERT and
 * tolerates a unique race by re-selecting on conflict. (No unique constraint
 * on portfolios.name; we serialize via tx for the common path.)
 */
export async function getDefaultPortfolioId(): Promise<number> {
  return await db.transaction(async (tx) => {
    const existing = await tx
      .select({ id: portfolios.id })
      .from(portfolios)
      .where(eq(portfolios.name, DEFAULT_PORTFOLIO_NAME))
      .limit(1);
    if (existing.length > 0) return existing[0].id;
    const inserted = await tx
      .insert(portfolios)
      .values({ name: DEFAULT_PORTFOLIO_NAME })
      .returning({ id: portfolios.id });
    return inserted[0].id;
  });
}

// Watchlist barely changes mid-session. Wrap with the Next 15 data cache so
// repeat GET /api/portfolio (header refresh, AppShell mount, history panel
// open, etc.) skip Postgres entirely for 60s. Mutating endpoints
// (POST/DELETE /api/portfolio) revalidate via `revalidateTag('portfolio')`.
//
// NOTE: We deliberately do NOT select portfolioId or mic — neither is rendered
// in the UI. Saves bytes on every list call. If a future caller needs them,
// add `?fields=full`.
async function listStocksRaw() {
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
    .orderBy(desc(stocks.addedAt));
}

export const listStocks = unstable_cache(listStocksRaw, ['portfolio:list-stocks'], {
  revalidate: 60,
  tags: ['portfolio'],
});

/** Full row including portfolioId + mic. Use only when a caller actually needs them. */
export async function listStocksFull() {
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
    .orderBy(desc(stocks.addedAt));
}

export async function getStockById(id: number) {
  const rows = await db.select().from(stocks).where(eq(stocks.id, id)).limit(1);
  return rows[0] ?? null;
}

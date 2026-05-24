import 'server-only';
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

export async function listStocks() {
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

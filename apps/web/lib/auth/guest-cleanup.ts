import 'server-only';
import { and, eq, inArray, lt } from 'drizzle-orm';
import { db } from '@/lib/db/client';
import {
  apiKeys,
  chats,
  portfolios,
  stocks,
  users,
  userTokenUsage,
} from '@/lib/db/schema';

const GUEST_TTL_DAYS = 7;

export interface GuestCleanupSummary {
  usersReset: number;
  rowsDeleted: number;
  resetUserIds: number[];
}

/**
 * Find every guest whose `expires_at` is in the past and wipe their
 * portfolios, chats, api_keys, and token-usage roll-up. The user row itself
 * is RETAINED so the username stays reserved; `expires_at` is rolled forward
 * another 7 days so the next window starts fresh.
 *
 * Cascade behaviour (worth re-checking when schema changes):
 *  - Deleting a portfolio cascades to stocks → events / future_events /
 *    prices_* / fundamentals / research_tasks / news_chunks / etc.
 *  - Chats only reference stocks (set null on delete), not users, so we
 *    must collect the user's stock ids and delete the chats explicitly
 *    BEFORE wiping portfolios, otherwise chats get orphaned with
 *    `stock_id = NULL` and stay forever.
 *
 * Invocation paths:
 *  - In-process scheduler (`lib/scheduler/index.ts`) fires this at 03:00 UTC
 *    daily — only relevant for local dev / self-hosted long-running Node.
 *  - Vercel Cron Jobs (`/api/cron/tick`) call this every 5 minutes. That's
 *    cheap because the WHERE clause (`role='guest' AND expires_at < now`)
 *    hits an index and returns 0 rows in the common case; deletes only
 *    happen when there's actually something to delete, so we don't bother
 *    with a 24h gate.
 *  - `/api/admin/cleanup-guests` (admin-triggered, manual).
 */
export async function cleanupExpiredGuestData(now: Date = new Date()): Promise<GuestCleanupSummary> {
  // 1. Find expired guests.
  const expired = await db
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.role, 'guest'), lt(users.expiresAt, now)));

  if (expired.length === 0) {
    return { usersReset: 0, rowsDeleted: 0, resetUserIds: [] };
  }

  const userIds = expired.map((u) => u.id);
  let rowsDeleted = 0;

  // 2. Collect every stock owned (transitively) by these users so we can
  //    nuke chats keyed on those stocks before portfolios are dropped.
  const stockRows = await db
    .select({ id: stocks.id })
    .from(stocks)
    .innerJoin(portfolios, eq(stocks.portfolioId, portfolios.id))
    .where(inArray(portfolios.userId, userIds));
  const stockIds = stockRows.map((s) => s.id);

  if (stockIds.length > 0) {
    const chatDel = await db.delete(chats).where(inArray(chats.stockId, stockIds));
    rowsDeleted += rowCount(chatDel);
  }

  // 3. Portfolios (cascades to stocks → events / prices / fundamentals / …).
  const portDel = await db.delete(portfolios).where(inArray(portfolios.userId, userIds));
  rowsDeleted += rowCount(portDel);

  // 4. API keys (cascade is also on FK, but be explicit so the row count
  //    surfaces in the summary).
  const keyDel = await db.delete(apiKeys).where(inArray(apiKeys.userId, userIds));
  rowsDeleted += rowCount(keyDel);

  // 5. Token-usage roll-up.
  const usageDel = await db.delete(userTokenUsage).where(inArray(userTokenUsage.userId, userIds));
  rowsDeleted += rowCount(usageDel);

  // 6. Roll the guest's expiry forward another window.
  const nextExpiry = new Date(now.getTime() + GUEST_TTL_DAYS * 24 * 60 * 60 * 1000);
  await db
    .update(users)
    .set({ expiresAt: nextExpiry })
    .where(inArray(users.id, userIds));

  return {
    usersReset: userIds.length,
    rowsDeleted,
    resetUserIds: userIds,
  };
}

/**
 * Drizzle's pg driver returns either a result-with-`rowCount` or an array,
 * depending on the underlying client. Normalise to a number; 0 if unknown.
 */
function rowCount(res: unknown): number {
  if (res && typeof res === 'object') {
    const r = res as { rowCount?: number | null; count?: number | null };
    if (typeof r.rowCount === 'number') return r.rowCount;
    if (typeof r.count === 'number') return r.count;
  }
  return 0;
}


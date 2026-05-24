import 'server-only';
import { sql } from 'drizzle-orm';
import { db } from '../db/client';
import { budgetLedger } from '../db/schema';

function utcDayString(d: Date = new Date()): string {
  // YYYY-MM-DD in UTC; budget_ledger.day is a `date` column.
  return d.toISOString().slice(0, 10);
}

/** Returns the USD already spent for `provider` on the given UTC day (default: today). */
export async function getDailySpend(provider: string, dayUtc: Date = new Date()): Promise<number> {
  const day = utcDayString(dayUtc);
  const rows = await db
    .select({ usdSpent: budgetLedger.usdSpent })
    .from(budgetLedger)
    .where(sql`${budgetLedger.day} = ${day} AND ${budgetLedger.provider} = ${provider}`)
    .limit(1);
  if (rows.length === 0) return 0;
  return Number(rows[0].usdSpent ?? 0);
}

/**
 * Adds `usd` to today's bucket for `provider`. Upsert keyed on `(day, provider)`.
 * No-op when `usd <= 0`.
 */
export async function addSpend(provider: string, usd: number): Promise<void> {
  if (!Number.isFinite(usd) || usd <= 0) return;
  const day = utcDayString();
  await db
    .insert(budgetLedger)
    .values({ day, provider, usdSpent: usd.toFixed(6) })
    .onConflictDoUpdate({
      target: [budgetLedger.day, budgetLedger.provider],
      set: {
        usdSpent: sql`${budgetLedger.usdSpent} + ${usd.toFixed(6)}::numeric`,
      },
    });
}

/**
 * Throws when this call would push today's `provider` spend past `capUsd`.
 * Call this *before* dispatching the LLM request; on success the caller is
 * expected to follow up with `addSpend(provider, actualUsd)` once the response
 * is metered.
 */
export async function checkBudgetOrThrow(
  provider: string,
  plannedUsd: number,
  capUsd: number,
): Promise<void> {
  if (!Number.isFinite(capUsd) || capUsd <= 0) return; // cap disabled
  const spent = await getDailySpend(provider);
  if (spent + plannedUsd > capUsd) {
    const err = new Error(
      `daily budget exceeded for ${provider}: $${spent.toFixed(4)} spent + $${plannedUsd.toFixed(4)} planned > $${capUsd.toFixed(2)} cap`,
    ) as Error & { status?: number; code?: string };
    err.status = 429;
    err.code = 'budget_exceeded';
    throw err;
  }
}

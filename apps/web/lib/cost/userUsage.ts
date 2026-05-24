import 'server-only';
import { sql } from 'drizzle-orm';
import { db } from '../db/client';
import { userTokenUsage } from '../db/schema';

/**
 * Per-user daily token + USD usage helpers. The chat route enforces caps via
 * these functions and other routes (admin dashboards, /api/me, etc.) can read
 * the same numbers without re-implementing the aggregation.
 *
 * NOTE: lives here (not inside `app/api/chat/route.ts`) because Next.js
 * forbids non-HTTP-method exports from route files — adding one breaks the
 * generated route-types build.
 */

/**
 * Aggregates today's token + cost usage for a user across ALL providers.
 * Returns zeros when the user has no row for today.
 */
export async function getUserDailyUsage(
  userId: number,
): Promise<{ tokens_in: number; tokens_out: number; cost_usd: number }> {
  const rows = await db
    .select({
      tokensIn: sql<string>`COALESCE(SUM(${userTokenUsage.tokensIn}), 0)::text`,
      tokensOut: sql<string>`COALESCE(SUM(${userTokenUsage.tokensOut}), 0)::text`,
      costUsd: sql<string>`COALESCE(SUM(${userTokenUsage.costUsd}), 0)::text`,
    })
    .from(userTokenUsage)
    .where(sql`${userTokenUsage.day} = CURRENT_DATE AND ${userTokenUsage.userId} = ${userId}`);
  const r = rows[0];
  return {
    tokens_in: Number(r?.tokensIn ?? 0),
    tokens_out: Number(r?.tokensOut ?? 0),
    cost_usd: Number(r?.costUsd ?? 0),
  };
}

/** Upserts today's per-user/per-provider usage delta. No-op for zero rows. */
export async function addUserDailyUsage(
  userId: number,
  provider: string,
  tokensIn: number,
  tokensOut: number,
  costUsd: number,
): Promise<void> {
  if ((tokensIn | 0) <= 0 && (tokensOut | 0) <= 0 && !(costUsd > 0)) return;
  const safeIn = Math.max(0, tokensIn | 0);
  const safeOut = Math.max(0, tokensOut | 0);
  const safeUsd = Number.isFinite(costUsd) && costUsd > 0 ? costUsd.toFixed(6) : '0';
  await db.execute(sql`
    INSERT INTO user_token_usage (day, user_id, provider, tokens_in, tokens_out, cost_usd)
    VALUES (CURRENT_DATE, ${userId}, ${provider}, ${safeIn}, ${safeOut}, ${safeUsd}::numeric)
    ON CONFLICT (day, user_id, provider) DO UPDATE SET
      tokens_in = user_token_usage.tokens_in + EXCLUDED.tokens_in,
      tokens_out = user_token_usage.tokens_out + EXCLUDED.tokens_out,
      cost_usd = user_token_usage.cost_usd + EXCLUDED.cost_usd
  `);
}

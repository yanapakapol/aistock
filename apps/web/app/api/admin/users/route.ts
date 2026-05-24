import { NextResponse } from 'next/server';
import { sql } from 'drizzle-orm';
import { db } from '@/lib/db/client';
import { getCurrentUser } from '@/lib/auth/session';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Admin-only listing of all users with today's token/USD usage rolled up
 * from `user_token_usage` (LEFT JOIN so users with zero usage still show).
 */
async function requireAdmin(): Promise<Response | null> {
  const u = await getCurrentUser().catch(() => null);
  if (!u) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  // `getCurrentUser` doesn't select `role` — re-check it directly.
  const [row] = (await db.execute(
    sql`select role from users where id = ${u.id} limit 1`,
  )) as unknown as Array<{ role: string }>;
  if (!row || row.role !== 'admin') {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }
  return null;
}

export async function GET() {
  const denied = await requireAdmin();
  if (denied) return denied;

  // One query: users LEFT JOIN aggregated user_token_usage WHERE day = today.
  const rows = (await db.execute(sql`
    select
      u.id,
      u.username,
      u.role::text                                    as role,
      u.daily_token_cap                               as daily_token_cap,
      u.daily_usd_cap::text                           as daily_usd_cap,
      u.expires_at                                    as expires_at,
      coalesce(t.today_tokens, 0)::int                as today_tokens,
      coalesce(t.today_usd, 0)::text                  as today_usd
    from users u
    left join (
      select
        user_id,
        sum(tokens_in + tokens_out)::int as today_tokens,
        sum(cost_usd)::numeric           as today_usd
      from user_token_usage
      where day = current_date
      group by user_id
    ) t on t.user_id = u.id
    order by u.id asc
  `)) as unknown as Array<{
    id: number;
    username: string;
    role: 'admin' | 'user' | 'guest';
    daily_token_cap: number | null;
    daily_usd_cap: string | null;
    expires_at: Date | string | null;
    today_tokens: number;
    today_usd: string;
  }>;

  return NextResponse.json({
    users: rows.map((r) => ({
      id: r.id,
      username: r.username,
      role: r.role,
      daily_token_cap: r.daily_token_cap,
      daily_usd_cap: r.daily_usd_cap == null ? null : Number(r.daily_usd_cap),
      expires_at: r.expires_at == null ? null : new Date(r.expires_at).toISOString(),
      today_tokens: r.today_tokens,
      today_usd: Number(r.today_usd ?? 0),
    })),
  });
}

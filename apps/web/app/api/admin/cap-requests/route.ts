import { NextResponse } from 'next/server';
import { sql } from 'drizzle-orm';
import { db } from '@/lib/db/client';
import { getCurrentUser } from '@/lib/auth/session';
import { ensureSchema } from '@/lib/db/ensure-schema';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

async function requireAdmin(): Promise<Response | null> {
  await ensureSchema().catch(() => undefined);
  const u = await getCurrentUser().catch(() => null);
  if (!u) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  if (u.isAdmin) return null;
  const [row] = (await db.execute(
    sql`select role from users where id = ${u.id} limit 1`,
  )) as unknown as Array<{ role: string }>;
  if (!row || row.role !== 'admin') {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }
  return null;
}

/**
 * List pending cap-increase requests for the admin inbox. Joins on `users`
 * so the admin sees `current_*_cap` next to the requested values to make a
 * fast yes/no decision.
 */
export async function GET() {
  const denied = await requireAdmin();
  if (denied) return denied;

  const rows = (await db.execute(sql`
    select
      r.id,
      r.user_id,
      u.username,
      r.requested_token_cap,
      r.requested_usd_cap::text as requested_usd_cap,
      r.reason,
      r.created_at,
      u.daily_token_cap        as current_token_cap,
      u.daily_usd_cap::text    as current_usd_cap
    from cap_requests r
    join users u on u.id = r.user_id
    where r.status = 'pending'
    order by r.created_at asc
  `)) as unknown as Array<{
    id: number;
    user_id: number;
    username: string;
    requested_token_cap: number | null;
    requested_usd_cap: string | null;
    reason: string | null;
    created_at: Date | string;
    current_token_cap: number | null;
    current_usd_cap: string | null;
  }>;

  return NextResponse.json({
    requests: rows.map((r) => ({
      id: r.id,
      user_id: r.user_id,
      username: r.username,
      requested_token_cap: r.requested_token_cap,
      requested_usd_cap: r.requested_usd_cap == null ? null : Number(r.requested_usd_cap),
      reason: r.reason,
      created_at: new Date(r.created_at).toISOString(),
      current_token_cap: r.current_token_cap,
      current_usd_cap: r.current_usd_cap == null ? null : Number(r.current_usd_cap),
    })),
  });
}

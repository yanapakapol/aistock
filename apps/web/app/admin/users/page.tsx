import { redirect } from 'next/navigation';
import { sql } from 'drizzle-orm';
import { db } from '@/lib/db/client';
import { getCurrentUser } from '@/lib/auth/session';
import { UsersClient, type AdminUserRow } from './users-client';

export const dynamic = 'force-dynamic';

export default async function AdminUsersPage() {
  const me = await getCurrentUser().catch(() => null);
  if (!me) redirect('/login');

  // `getCurrentUser` only returns id/username/isAdmin — re-check `role` from
  // the source of truth. isAdmin is kept in sync with role='admin' by the
  // PATCH endpoint, so this check is consistent with the boolean.
  const [meRow] = (await db.execute(
    sql`select role from users where id = ${me.id} limit 1`,
  )) as unknown as Array<{ role: string }>;
  if (!meRow || meRow.role !== 'admin') redirect('/');

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

  const initial: AdminUserRow[] = rows.map((r) => ({
    id: r.id,
    username: r.username,
    role: r.role,
    daily_token_cap: r.daily_token_cap,
    daily_usd_cap: r.daily_usd_cap == null ? null : Number(r.daily_usd_cap),
    expires_at: r.expires_at == null ? null : new Date(r.expires_at).toISOString(),
    today_tokens: r.today_tokens,
    today_usd: Number(r.today_usd ?? 0),
  }));

  return (
    <div className="h-full overflow-auto">
      <div className="mx-auto max-w-6xl p-6 space-y-6">
        <header>
          <h1 className="text-lg font-semibold">User management</h1>
          <p className="text-sm text-muted-foreground">
            Set per-user daily caps, assign API keys on their behalf, and remove accounts.
            Keys you assign are encrypted at rest and never shown back to you.
          </p>
        </header>
        <UsersClient initialUsers={initial} currentUserId={me.id} />
      </div>
    </div>
  );
}

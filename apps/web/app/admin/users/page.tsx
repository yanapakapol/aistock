import { redirect } from 'next/navigation';
import { sql } from 'drizzle-orm';
import { db } from '@/lib/db/client';
import { getCurrentUser } from '@/lib/auth/session';
import { UsersClient, type AdminUserRow } from './users-client';

export const dynamic = 'force-dynamic';

/**
 * Render a friendly "schema not migrated" page instead of crashing with a
 * 500 + Vercel digest. The most common cause of failure here is that the
 * deploy added new schema (the `role` column, `user_token_usage` table) but
 * the operator never ran `npm run -w apps/web db:migrate` against their
 * Neon DATABASE_URL.
 */
function MigrationNeeded({ error }: { error: string }) {
  return (
    <div className="h-full overflow-auto">
      <div className="mx-auto max-w-3xl p-6 space-y-4">
        <h1 className="text-lg font-semibold">User management — setup required</h1>
        <div className="rounded-md border border-amber-500/40 bg-amber-500/10 p-4 text-sm">
          <p className="font-medium text-amber-700 dark:text-amber-300">
            Database schema is out of date.
          </p>
          <p className="mt-2 text-muted-foreground">
            This page needs the <code>users.role</code> column and the{' '}
            <code>user_token_usage</code> table, which were added in a recent
            migration. Run migrations against your production database:
          </p>
          <pre className="mt-3 overflow-x-auto rounded bg-muted/50 p-3 text-xs">
{`# locally, pointing at your production DATABASE_URL:
DATABASE_URL='<your neon url>' npm run -w apps/web db:migrate`}
          </pre>
          <p className="mt-2 text-xs text-muted-foreground">
            Then redeploy / refresh. Original error:
          </p>
          <pre className="mt-1 overflow-x-auto rounded bg-muted/50 p-2 text-[10px] text-muted-foreground">
{error}
          </pre>
        </div>
      </div>
    </div>
  );
}

export default async function AdminUsersPage() {
  const me = await getCurrentUser().catch(() => null);
  if (!me) redirect('/login');

  // Authoritative admin check uses the legacy `users.isAdmin` boolean from the
  // session lookup, which always exists. The `role` column is newer and may
  // not be present yet on un-migrated DBs; we treat `isAdmin` as truth.
  if (!me.isAdmin) redirect('/');

  let rows: Array<{
    id: number;
    username: string;
    role: 'admin' | 'user' | 'guest';
    daily_token_cap: number | null;
    daily_usd_cap: string | null;
    expires_at: Date | string | null;
    today_tokens: number;
    today_usd: string;
  }>;

  try {
    rows = (await db.execute(sql`
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
    `)) as unknown as typeof rows;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    // Surface schema-missing errors as a friendly setup page instead of a 500.
    if (
      /column .* does not exist/i.test(msg) ||
      /relation .* does not exist/i.test(msg) ||
      /type .* does not exist/i.test(msg)
    ) {
      return <MigrationNeeded error={msg} />;
    }
    throw e;
  }

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

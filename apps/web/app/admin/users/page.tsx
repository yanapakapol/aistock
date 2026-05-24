import { redirect } from 'next/navigation';
import { sql } from 'drizzle-orm';
import { db } from '@/lib/db/client';
import { getCurrentUser } from '@/lib/auth/session';
import { ensureSchema } from '@/lib/db/ensure-schema';
import { UsersClient, type AdminUserRow } from './users-client';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * Renders a friendly error card instead of crashing the route with an
 * opaque Vercel error digest. Vercel hides server-side error messages in
 * production builds, so without this the user just sees "Application
 * error: a server-side exception has occurred". With this, the actual
 * Postgres / runtime message is visible and actionable.
 */
function ErrorCard({ title, detail }: { title: string; detail: string }) {
  return (
    <div className="h-full overflow-auto">
      <div className="mx-auto max-w-3xl p-6 space-y-4">
        <h1 className="text-lg font-semibold">User management — {title}</h1>
        <div className="rounded-md border border-amber-500/40 bg-amber-500/10 p-4 text-sm space-y-2">
          <p className="font-medium text-amber-700 dark:text-amber-300">
            Something went wrong loading this page.
          </p>
          <p className="text-xs text-muted-foreground">
            The platform tries to self-heal its database schema on the first
            request. If you see this repeatedly, the message below is the
            real Postgres / runtime error.
          </p>
          <pre className="overflow-x-auto rounded bg-muted/50 p-2 text-[10px] text-muted-foreground whitespace-pre-wrap">
{detail}
          </pre>
          <p className="text-xs text-muted-foreground">
            You can also force a one-time manual migration:
          </p>
          <pre className="overflow-x-auto rounded bg-muted/50 p-2 text-[10px] text-muted-foreground">
{`DATABASE_URL='<your neon url>' npm run -w apps/web db:migrate`}
          </pre>
        </div>
      </div>
    </div>
  );
}

interface UserRow {
  id: number;
  username: string;
  role: 'admin' | 'user' | 'guest';
  daily_token_cap: number | null;
  daily_usd_cap: string | null;
  expires_at: Date | string | null;
  today_tokens: number;
  today_usd: string;
}

async function loadUsers(): Promise<UserRow[]> {
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
  `)) as unknown as UserRow[];
  return rows;
}

/**
 * Best-effort fallback when the joined query fails — usually because
 * `user_token_usage` doesn't exist yet on a brand-new DB. Returns users
 * with zero usage rather than 500ing.
 */
async function loadUsersFallback(): Promise<UserRow[]> {
  const rows = (await db.execute(sql`
    select
      u.id,
      u.username,
      coalesce(u.role::text, case when u.is_admin then 'admin' else 'user' end) as role,
      u.daily_token_cap                               as daily_token_cap,
      u.daily_usd_cap::text                           as daily_usd_cap,
      u.expires_at                                    as expires_at,
      0::int                                          as today_tokens,
      '0'::text                                       as today_usd
    from users u
    order by u.id asc
  `)) as unknown as UserRow[];
  return rows;
}

/**
 * Very-last-resort fallback: only the legacy columns that have always
 * existed. Used when even `role` / cap columns are missing.
 */
async function loadUsersLegacy(): Promise<UserRow[]> {
  const rows = (await db.execute(sql`
    select
      u.id,
      u.username,
      case when u.is_admin then 'admin' else 'user' end as role,
      null::int as daily_token_cap,
      null::text as daily_usd_cap,
      null::timestamptz as expires_at,
      0::int as today_tokens,
      '0'::text as today_usd
    from users u
    order by u.id asc
  `)) as unknown as UserRow[];
  return rows;
}

export default async function AdminUsersPage() {
  try {
    // Self-heal schema. Errors here are non-fatal — the layered fallbacks
    // below will degrade gracefully if a column is still missing.
    await ensureSchema().catch((err) => {
      // eslint-disable-next-line no-console
      console.error('[admin/users] ensureSchema failed:', err);
    });

    const me = await getCurrentUser().catch(() => null);
    if (!me) redirect('/login');
    if (!me.isAdmin) redirect('/');

    // Try the full joined query first → fall back through degraded variants.
    let rows: UserRow[];
    try {
      rows = await loadUsers();
    } catch (e1) {
      // eslint-disable-next-line no-console
      console.error('[admin/users] full query failed, trying fallback:', e1);
      try {
        rows = await loadUsersFallback();
      } catch (e2) {
        // eslint-disable-next-line no-console
        console.error('[admin/users] fallback failed, trying legacy:', e2);
        rows = await loadUsersLegacy();
      }
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
  } catch (err) {
    // `redirect()` throws an internal NEXT_REDIRECT — we MUST re-throw it
    // or the redirect becomes an error page.
    if (
      err &&
      typeof err === 'object' &&
      'digest' in err &&
      typeof (err as { digest: unknown }).digest === 'string' &&
      ((err as { digest: string }).digest.startsWith('NEXT_REDIRECT') ||
        (err as { digest: string }).digest.startsWith('NEXT_NOT_FOUND'))
    ) {
      throw err;
    }
    const msg = err instanceof Error ? `${err.message}\n\n${err.stack ?? ''}` : String(err);
    // eslint-disable-next-line no-console
    console.error('[admin/users] unrecoverable:', err);
    return <ErrorCard title="failed to load" detail={msg} />;
  }
}

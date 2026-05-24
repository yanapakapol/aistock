import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { eq, sql } from 'drizzle-orm';
import { db } from '@/lib/db/client';
import { users } from '@/lib/db/schema';
import { getCurrentUser } from '@/lib/auth/session';
import { ensureSchema } from '@/lib/db/ensure-schema';
import { hashPassword } from '@/lib/auth/password';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Admin-only listing of all users with today's token/USD usage rolled up
 * from `user_token_usage` (LEFT JOIN so users with zero usage still show).
 */
async function requireAdmin(): Promise<Response | null> {
  // Make sure new columns exist before any query touches them.
  await ensureSchema().catch(() => undefined);
  const u = await getCurrentUser().catch(() => null);
  if (!u) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  // Prefer the session's isAdmin flag (always present); fall back to checking
  // the `role` column for newly-promoted users whose session predates the role.
  if (u.isAdmin) return null;
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

// --- Admin-created accounts ------------------------------------------------
// Admin creates a guest or user account directly from /admin/users without
// going through the public /register flow. Lets the admin pre-set caps and
// (for guests) a custom TTL.

const CreateBody = z
  .object({
    username: z.string().min(3).max(64).regex(/^[A-Za-z0-9_.-]+$/),
    password: z.string().min(8).max(128),
    role: z.enum(['user', 'guest']).default('guest'),
    daily_token_cap: z.number().int().nonnegative().nullable().optional(),
    daily_usd_cap: z.number().nonnegative().max(9999).nullable().optional(),
    // Number of days until expiry for guest accounts. NULL/omitted = 7d default.
    expires_in_days: z.number().int().min(1).max(365).optional(),
  })
  .strict();

const HARD_DEFAULT_TOKEN_CAP = 50_000;
const HARD_DEFAULT_USD_CAP = '0.50';
const GUEST_TTL_DAYS = 7;

export async function POST(req: NextRequest) {
  const site = req.headers.get('sec-fetch-site');
  if (site && site !== 'same-origin' && site !== 'none') {
    return NextResponse.json({ error: 'cross-origin denied' }, { status: 403 });
  }
  const denied = await requireAdmin();
  if (denied) return denied;

  const parsed = CreateBody.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: 'invalid input', issues: parsed.error.issues }, { status: 400 });
  }
  const body = parsed.data;

  const tokenCap = body.daily_token_cap ?? HARD_DEFAULT_TOKEN_CAP;
  const usdCap =
    body.daily_usd_cap == null ? HARD_DEFAULT_USD_CAP : String(body.daily_usd_cap);
  const ttlDays = body.expires_in_days ?? GUEST_TTL_DAYS;
  const expiresAt =
    body.role === 'guest' ? new Date(Date.now() + ttlDays * 24 * 60 * 60 * 1000) : null;

  // Pre-check duplicate (Drizzle hides the postgres 23505 error code).
  const [taken] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.username, body.username))
    .limit(1);
  if (taken) {
    return NextResponse.json({ error: 'username already taken' }, { status: 409 });
  }

  const passwordHash = await hashPassword(body.password);
  try {
    const [created] = await db
      .insert(users)
      .values({
        username: body.username,
        passwordHash,
        isAdmin: false,
        role: body.role,
        dailyTokenCap: tokenCap,
        dailyUsdCap: usdCap,
        expiresAt,
      })
      .returning({ id: users.id, username: users.username, role: users.role });
    return NextResponse.json({ ok: true, user: created });
  } catch (err) {
    const pgErr = err as { code?: string; message?: string };
    if (pgErr?.code === '23505') {
      return NextResponse.json({ error: 'username already taken' }, { status: 409 });
    }
    const safeDetail = (pgErr?.message ?? '').split('\n')[0].slice(0, 200);
    return NextResponse.json({ error: 'create failed', detail: safeDetail }, { status: 500 });
  }
}

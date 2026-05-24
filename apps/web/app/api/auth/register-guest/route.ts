import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { db } from '@/lib/db/client';
import { users } from '@/lib/db/schema';
import { hashPassword } from '@/lib/auth/password';
import { createSession } from '@/lib/auth/session';
import { ensureSchema } from '@/lib/db/ensure-schema';

export const runtime = 'nodejs';

const Body = z.object({
  username: z.string().min(3).max(64).regex(/^[A-Za-z0-9_.-]+$/),
  password: z.string().min(8).max(128),
});

// Sentinel username for admin-tunable guest defaults. If a row with this
// username exists, its `dailyTokenCap` and `dailyUsdCap` columns are inherited
// by every new guest. Otherwise the hard defaults below apply.
const GUEST_DEFAULTS_USERNAME = '__guest_defaults__';
const HARD_DEFAULT_TOKEN_CAP = 50_000;
const HARD_DEFAULT_USD_CAP = '0.50';
const GUEST_TTL_DAYS = 7;

export async function POST(req: NextRequest) {
  if (req.headers.get('sec-fetch-site') && req.headers.get('sec-fetch-site') !== 'same-origin') {
    return NextResponse.json({ error: 'cross-origin denied' }, { status: 403 });
  }
  // Self-heal the schema on first hit. Cheap after the first call (memoized).
  try {
    await ensureSchema();
  } catch (err) {
    const msg = (err as { message?: string })?.message ?? String(err);
    return NextResponse.json(
      { error: 'database schema bootstrap failed', detail: msg },
      { status: 500 },
    );
  }
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: 'invalid input', issues: parsed.error.issues }, { status: 400 });
  }
  const { username, password } = parsed.data;

  // Block direct registration under the sentinel name — admins set defaults
  // via a different (server-side) path, not by registering it as a user.
  if (username === GUEST_DEFAULTS_USERNAME) {
    return NextResponse.json({ error: 'username reserved' }, { status: 409 });
  }

  // Look up admin-tunable defaults row (may not exist).
  const [defaults] = await db
    .select({ tokenCap: users.dailyTokenCap, usdCap: users.dailyUsdCap })
    .from(users)
    .where(eq(users.username, GUEST_DEFAULTS_USERNAME))
    .limit(1);

  const dailyTokenCap = defaults?.tokenCap ?? HARD_DEFAULT_TOKEN_CAP;
  const dailyUsdCap = defaults?.usdCap ?? HARD_DEFAULT_USD_CAP;
  const expiresAt = new Date(Date.now() + GUEST_TTL_DAYS * 24 * 60 * 60 * 1000);

  // Pre-check for an existing username so we can return a clean 409 instead
  // of relying on the INSERT to fail. Drizzle wraps the postgres-js unique-
  // violation error in a way that hides the `code` (23505), so catching it
  // by error code alone is fragile.
  const [taken] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.username, username))
    .limit(1);
  if (taken) {
    return NextResponse.json({ error: 'username already taken' }, { status: 409 });
  }

  const passwordHash = await hashPassword(password);
  try {
    const [created] = await db
      .insert(users)
      .values({
        username,
        passwordHash,
        isAdmin: false,
        role: 'guest',
        dailyTokenCap,
        dailyUsdCap,
        expiresAt,
      })
      .returning({ id: users.id, isAdmin: users.isAdmin });
    await createSession({ uid: created!.id, isAdmin: created!.isAdmin });
    return NextResponse.json({
      ok: true,
      user: {
        id: created!.id,
        username,
        isAdmin: created!.isAdmin,
        role: 'guest',
        expiresAt: expiresAt.toISOString(),
      },
    });
  } catch (err) {
    // Postgres unique_violation code. More reliable than parsing the message,
    // which Drizzle wraps as "Failed query: insert ..." and doesn't surface
    // the underlying "duplicate key" text.
    const pgErr = err as { code?: string; message?: string };
    if (pgErr?.code === '23505') {
      return NextResponse.json({ error: 'username already taken' }, { status: 409 });
    }
    // Don't echo the SQL / param list (contains the bcrypt hash). Strip
    // anything after the first newline so we keep the headline but drop
    // the parameter dump.
    const safeDetail = (pgErr?.message ?? '').split('\n')[0].slice(0, 200);
    return NextResponse.json({ error: 'register failed', detail: safeDetail }, { status: 500 });
  }
}

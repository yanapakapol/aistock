import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { sql } from 'drizzle-orm';
import { db } from '@/lib/db/client';
import { users } from '@/lib/db/schema';
import { hashPassword } from '@/lib/auth/password';
import { createSession } from '@/lib/auth/session';

export const runtime = 'nodejs';

const Body = z.object({
  username: z.string().min(3).max(64).regex(/^[A-Za-z0-9_.-]+$/),
  password: z.string().min(8).max(128),
});

// New-user default caps. Previously NULL → ∞ (e.g. the `Test2` row admins
// saw with no cap on the users page). Now we mirror the guest pattern:
// give every new account a sane daily ceiling. Admin can lift per-user via
// /admin/users. The first user (the bootstrap admin) bypasses these
// defaults — admins SHOULD start unlimited because they own the bill.
//
// Tuning rationale: ~10× the guest defaults — guests are throwaway
// throwaway accounts; named users are presumably trusted-ish humans, so
// they deserve more headroom by default. Tweak via the constants below.
const USER_DEFAULT_TOKEN_CAP = 500_000;
const USER_DEFAULT_USD_CAP = '5.00'; // string for numeric(8,4) column

export async function POST(req: NextRequest) {
  if (req.headers.get('sec-fetch-site') && req.headers.get('sec-fetch-site') !== 'same-origin') {
    return NextResponse.json({ error: 'cross-origin denied' }, { status: 403 });
  }
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: 'invalid input', issues: parsed.error.issues }, { status: 400 });
  }
  const { username, password } = parsed.data;

  // First user becomes admin, no one else can ever be admin.
  // Used to wrap COUNT+INSERT in a transaction for atomicity, but
  // neon-http doesn't support .transaction(cb). Two simultaneous
  // first-time signups could theoretically both see count=0 and both
  // become admin — in practice the bootstrap window is a single human
  // action, and the operator can demote the dupe via SQL if it ever
  // happens. Worth it for the cold-start win.
  const passwordHash = await hashPassword(password);
  try {
    const [{ count }] = (await db.execute(
      sql`select count(*)::int as count from users`,
    )) as unknown as Array<{ count: number }>;
    const isAdmin = Number(count) === 0;
    // Admin (bootstrap user) starts unlimited — they own the keys and the
    // bill. Everyone else gets the user-role default caps; admin can lift
    // them per-user via /admin/users.
    const [created] = await db
      .insert(users)
      .values(
        isAdmin
          ? { username, passwordHash, isAdmin }
          : {
              username,
              passwordHash,
              isAdmin,
              dailyTokenCap: USER_DEFAULT_TOKEN_CAP,
              dailyUsdCap: USER_DEFAULT_USD_CAP,
            },
      )
      .returning({ id: users.id, isAdmin: users.isAdmin });
    const role: 'admin' | 'user' = created!.isAdmin ? 'admin' : 'user';
    await createSession({ uid: created!.id, isAdmin: created!.isAdmin, role, username });
    return NextResponse.json({ ok: true, user: { id: created!.id, username, isAdmin: created!.isAdmin } });
  } catch (err) {
    const msg = (err as { message?: string })?.message ?? '';
    if (/unique|duplicate/i.test(msg)) {
      return NextResponse.json({ error: 'username already taken' }, { status: 409 });
    }
    return NextResponse.json({ error: 'register failed', detail: msg }, { status: 500 });
  }
}

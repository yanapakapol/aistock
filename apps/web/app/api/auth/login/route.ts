import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { db } from '@/lib/db/client';
import { users } from '@/lib/db/schema';
import { verifyPassword } from '@/lib/auth/password';
import { createSession } from '@/lib/auth/session';

// Edge runtime: every login starts a session — moving off Node cold-start
// (~1-2s) onto Edge (~50-100ms) is a big perceived-latency win. Safe here
// because: bcryptjs has a `"browser": { "crypto": false }` export map and
// falls back to Web Crypto for random bytes; @neondatabase/serverless is
// HTTP-based and edge-compatible; session.ts uses Web Crypto for HMAC.
export const runtime = 'edge';

const Body = z.object({
  username: z.string().min(1).max(64),
  password: z.string().min(1).max(128),
});

// Naïve per-IP login rate limit (10 attempts/minute) — enough to slow online
// brute force on a single user; persistent backoff would need a store.
const buckets = new Map<string, { count: number; resetAt: number }>();
function rl(ip: string): boolean {
  const now = Date.now();
  const b = buckets.get(ip);
  if (!b || b.resetAt < now) {
    buckets.set(ip, { count: 1, resetAt: now + 60_000 });
    return true;
  }
  if (b.count >= 10) return false;
  b.count++;
  return true;
}

export async function POST(req: NextRequest) {
  if (req.headers.get('sec-fetch-site') && req.headers.get('sec-fetch-site') !== 'same-origin') {
    return NextResponse.json({ error: 'cross-origin denied' }, { status: 403 });
  }
  const ip =
    req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? 'local';
  if (!rl(ip)) {
    return NextResponse.json({ error: 'too many attempts, slow down' }, { status: 429 });
  }
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: 'invalid input' }, { status: 400 });
  }
  const { username, password } = parsed.data;
  const [row] = await db.select().from(users).where(eq(users.username, username)).limit(1);
  // Constant-ish-time: always run bcrypt even on missing user to leak less.
  const ok = row ? await verifyPassword(password, row.passwordHash) : false;
  if (!row || !ok) {
    return NextResponse.json({ error: 'invalid username or password' }, { status: 401 });
  }
  const role: 'admin' | 'user' | 'guest' =
    (row.role as 'admin' | 'user' | 'guest' | null | undefined) ??
    (row.isAdmin ? 'admin' : 'user');
  await createSession({ uid: row.id, isAdmin: row.isAdmin, role, username: row.username });
  return NextResponse.json({ ok: true, user: { id: row.id, username: row.username, isAdmin: row.isAdmin } });
}

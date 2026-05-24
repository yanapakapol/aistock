import 'server-only';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { cookies } from 'next/headers';
import { db } from '@/lib/db/client';
import { users } from '@/lib/db/schema';
import { eq, sql } from 'drizzle-orm';

const COOKIE = 'aistock_session';
const MAX_AGE = 60 * 60 * 24 * 30; // 30 days

function secret(): Buffer {
  const raw = process.env.SESSION_SECRET || process.env.MASTER_KEY;
  if (!raw) throw new Error('SESSION_SECRET or MASTER_KEY must be set for auth');
  // Derive a stable 32-byte secret from whatever was provided.
  return createHmac('sha256', 'aistock-session').update(raw).digest();
}

interface SessionPayload {
  uid: number;
  adm: boolean;
  exp: number; // unix seconds
}

function sign(payload: SessionPayload): string {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const mac = createHmac('sha256', secret()).update(body).digest('base64url');
  return `${body}.${mac}`;
}

function verify(token: string): SessionPayload | null {
  const dot = token.indexOf('.');
  if (dot < 0) return null;
  const body = token.slice(0, dot);
  const mac = token.slice(dot + 1);
  const expected = createHmac('sha256', secret()).update(body).digest();
  let actual: Buffer;
  try {
    actual = Buffer.from(mac, 'base64url');
  } catch {
    return null;
  }
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString()) as SessionPayload;
    if (typeof payload.exp !== 'number' || payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch {
    return null;
  }
}

export async function createSession(args: { uid: number; isAdmin: boolean }) {
  const token = sign({
    uid: args.uid,
    adm: args.isAdmin,
    exp: Math.floor(Date.now() / 1000) + MAX_AGE,
  });
  const jar = await cookies();
  jar.set(COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: MAX_AGE,
  });
}

export async function destroySession() {
  const jar = await cookies();
  jar.delete(COOKIE);
}

export async function getSession(): Promise<SessionPayload | null> {
  const jar = await cookies();
  const tok = jar.get(COOKIE)?.value;
  if (!tok) return null;
  return verify(tok);
}

export async function getCurrentUser() {
  const s = await getSession();
  if (!s) return null;
  // Try to read role too (column added in a later migration). Wrap in
  // try/catch so an un-migrated DB still returns the legacy fields.
  try {
    const [row] = (await db.execute(sql`
      select id, username, is_admin as "isAdmin",
             coalesce(role::text, case when is_admin then 'admin' else 'user' end) as role
      from users where id = ${s.uid} limit 1
    `)) as unknown as Array<{
      id: number;
      username: string;
      isAdmin: boolean;
      role: 'admin' | 'user' | 'guest';
    }>;
    return row ?? null;
  } catch {
    // Fallback to legacy select if the role column truly doesn't exist
    // (shouldn't happen post-ensureSchema, but cheap belt-and-braces).
    const [row] = await db
      .select({ id: users.id, username: users.username, isAdmin: users.isAdmin })
      .from(users)
      .where(eq(users.id, s.uid))
      .limit(1);
    if (!row) return null;
    return { ...row, role: row.isAdmin ? ('admin' as const) : ('user' as const) };
  }
}

export async function requireUser() {
  const u = await getCurrentUser();
  if (!u) throw new Response('unauthorized', { status: 401 });
  return u;
}

/** Random session secret bootstrap helper — only used by /api/auth/register
 *  to seed SESSION_SECRET-from-env warnings. */
export function randomSecret(): string {
  return randomBytes(32).toString('base64');
}

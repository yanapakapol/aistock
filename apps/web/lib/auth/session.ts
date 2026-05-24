import 'server-only';
import { cookies } from 'next/headers';
import { db } from '@/lib/db/client';
import { users } from '@/lib/db/schema';
import { eq, sql } from 'drizzle-orm';

const COOKIE = 'aistock_session';
const MAX_AGE = 60 * 60 * 24 * 30; // 30 days

// --- Web Crypto helpers (edge-compatible; no node:crypto) ---------------

const encoder = new TextEncoder();

function base64urlEncode(bytes: Uint8Array): string {
  // btoa expects binary string. Build it without spreading into a giant
  // argument list (avoids stack-overflow on large inputs — defensive even
  // though our payloads are tiny).
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64urlDecode(s: string): Uint8Array | null {
  try {
    const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4));
    const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + pad;
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

async function importHmacKey(rawKey: Uint8Array, usage: 'sign' | 'verify'): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    // Copy into a fresh ArrayBuffer so we never hand subtle.importKey a
    // SharedArrayBuffer or a sliced Buffer view (importKey is strict
    // about BufferSource alignment on some runtimes).
    rawKey.slice().buffer,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    [usage],
  );
}

async function hmacSign(message: string, rawKey: Uint8Array): Promise<Uint8Array> {
  const key = await importHmacKey(rawKey, 'sign');
  const sig = await crypto.subtle.sign('HMAC', key, encoder.encode(message));
  return new Uint8Array(sig);
}

// --- Session secret derivation ------------------------------------------

async function secret(): Promise<Uint8Array> {
  const raw = process.env.SESSION_SECRET || process.env.MASTER_KEY;
  if (!raw) throw new Error('SESSION_SECRET or MASTER_KEY must be set for auth');
  // Derive a stable 32-byte secret from whatever was provided.
  // Mirrors the previous HMAC-SHA256('aistock-session', raw) derivation so
  // cookies issued under the node:crypto version stay valid.
  return hmacSign(raw, encoder.encode('aistock-session'));
}

interface SessionPayload {
  uid: number;
  adm: boolean; // legacy is_admin boolean
  role?: 'admin' | 'user' | 'guest'; // optional for back-compat with old cookies
  u?: string; // username, short key to save bytes
  exp: number; // unix seconds
}

async function sign(payload: SessionPayload): Promise<string> {
  const body = base64urlEncode(encoder.encode(JSON.stringify(payload)));
  const mac = base64urlEncode(await hmacSign(body, await secret()));
  return `${body}.${mac}`;
}

async function verify(token: string): Promise<SessionPayload | null> {
  const dot = token.indexOf('.');
  if (dot < 0) return null;
  const body = token.slice(0, dot);
  const mac = token.slice(dot + 1);
  const expected = await hmacSign(body, await secret());
  const actual = base64urlDecode(mac);
  if (!actual) return null;
  if (!constantTimeEqual(actual, expected)) return null;
  try {
    const bodyBytes = base64urlDecode(body);
    if (!bodyBytes) return null;
    const payload = JSON.parse(new TextDecoder().decode(bodyBytes)) as SessionPayload;
    if (typeof payload.exp !== 'number' || payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch {
    return null;
  }
}

export async function createSession(args: {
  uid: number;
  isAdmin: boolean;
  role?: 'admin' | 'user' | 'guest';
  username?: string;
}) {
  const token = await sign({
    uid: args.uid,
    adm: args.isAdmin,
    role: args.role,
    u: args.username,
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
  // Fast path: cookie has everything we need. ~1ms vs 50-150ms cold Neon query.
  if (s.u && s.role) {
    return { id: s.uid, username: s.u, isAdmin: s.adm, role: s.role };
  }
  // Fallback for cookies issued before the role+username fields were added.
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
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  // Standard base64 (not base64url) to match the previous output shape.
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

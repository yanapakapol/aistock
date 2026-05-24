import { NextResponse, type NextRequest } from 'next/server';

// ─── Config ────────────────────────────────────────────────────────────────
const MUTATING_METHODS = new Set(['POST', 'PATCH', 'PUT', 'DELETE']);
const RATE_LIMIT_RPM = 60;
const RATE_LIMIT_REFILL_MS = 60_000 / RATE_LIMIT_RPM;
const RATE_LIMIT_BUCKET_MAX = RATE_LIMIT_RPM;

const REMOTE_BEARER_EXEMPT = ['/setup', '/api/setup', '/api/push/vapid-public-key'];
const BEARER_COOKIE = 'aistock_bearer';

// Paths exempt from the username/password auth gate (login/register itself,
// session-check, static assets, etc.).
const AUTH_FREE_PATHS = new Set([
  '/login',
  '/register',
  '/api/auth/login',
  '/api/auth/register',
  '/api/auth/me',
  '/api/auth/logout',
  '/setup',
  '/api/setup',
  '/api/push/vapid-public-key',
  '/manifest.webmanifest',
  '/sw.js',
]);

function authFree(pathname: string): boolean {
  if (AUTH_FREE_PATHS.has(pathname)) return true;
  if (pathname.startsWith('/_next/')) return true;
  if (pathname.startsWith('/icon-')) return true;
  return false;
}

// ─── Rate limiter ──────────────────────────────────────────────────────────
type Bucket = { tokens: number; lastRefillTs: number };
const globalForRl = globalThis as unknown as { __aistockRateBuckets?: Map<string, Bucket> };
const buckets: Map<string, Bucket> = globalForRl.__aistockRateBuckets ?? new Map();
globalForRl.__aistockRateBuckets = buckets;

function getClientIp(req: NextRequest): string {
  const xff = req.headers.get('x-forwarded-for');
  if (xff) return xff.split(',')[0]!.trim();

  const realIp = req.headers.get('x-real-ip');
  if (realIp) return realIp.trim();

  const ip = (req as any).ip as string | undefined;
  return ip || 'unknown';
}

function consumeToken(ip: string): boolean {
  const now = Date.now();
  const bucket = buckets.get(ip);

  if (!bucket) {
    buckets.set(ip, { tokens: RATE_LIMIT_BUCKET_MAX - 1, lastRefillTs: now });
    return true;
  }

  const elapsed = now - bucket.lastRefillTs;
  if (elapsed > 0) {
    const refill = elapsed / RATE_LIMIT_REFILL_MS;
    bucket.tokens = Math.min(RATE_LIMIT_BUCKET_MAX, bucket.tokens + refill);
    bucket.lastRefillTs = now;
  }

  if (bucket.tokens >= 1) {
    bucket.tokens -= 1;
    return true;
  }

  return false;
}

// ─── Edge-safe bearer-cookie verification ─────────────────────────────────
const encoder = new TextEncoder();

function toHex(bytes: ArrayBuffer): string {
  return Array.from(new Uint8Array(bytes))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;

  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

async function hmacSha256Hex(message: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );

  const sig = await crypto.subtle.sign('HMAC', key, encoder.encode(message));
  return toHex(sig);
}

async function verifyBearerCookie(
  cookieVal: string | undefined,
  secret: string,
): Promise<boolean> {
  if (!cookieVal) return false;

  const dot = cookieVal.lastIndexOf('.');
  if (dot <= 0) return false;

  const msg = cookieVal.slice(0, dot);
  const sig = cookieVal.slice(dot + 1);

  try {
    const expected = await hmacSha256Hex(msg, secret);
    return constantTimeEqual(expected, sig);
  } catch {
    return false;
  }
}

function isRemoteAccessMode(): boolean {
  return process.env.BIND_HOST === '0.0.0.0' && !!process.env.SETUP_BEARER_HMAC_SECRET;
}

function isExemptPath(pathname: string): boolean {
  return REMOTE_BEARER_EXEMPT.some((p) => pathname === p || pathname.startsWith(`${p}/`));
}

// ─── Middleware ────────────────────────────────────────────────────────────
export async function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;
  const method = req.method.toUpperCase();

  if (pathname.startsWith('/api/') && MUTATING_METHODS.has(method)) {
    const sfs = req.headers.get('sec-fetch-site');
    if (sfs && sfs !== 'same-origin' && sfs !== 'none') {
      return new NextResponse('cross-origin blocked', { status: 403 });
    }
  }

  const ip = getClientIp(req);
  if (!consumeToken(ip)) {
    return new NextResponse('rate limited', {
      status: 429,
      headers: { 'Retry-After': '60' },
    });
  }

  // ─── Auth gate ────────────────────────────────────────────────────────────
  // Block any non-auth-free page or API call without a session cookie.
  // The cookie HMAC is verified server-side in route handlers via getSession();
  // here we only check for presence to redirect early on full-page nav.
  if (!authFree(pathname)) {
    const session = req.cookies.get('aistock_session')?.value;
    if (!session) {
      if (pathname.startsWith('/api/')) {
        return new NextResponse('unauthorized', { status: 401 });
      }
      const url = req.nextUrl.clone();
      url.pathname = '/login';
      url.search = `?next=${encodeURIComponent(pathname)}`;
      return NextResponse.redirect(url);
    }
  }

  if (isRemoteAccessMode() && !isExemptPath(pathname)) {
    const cookie = req.cookies.get(BEARER_COOKIE)?.value;
    const secret = process.env.SETUP_BEARER_HMAC_SECRET!;

    if (!(await verifyBearerCookie(cookie, secret))) {
      if (pathname.startsWith('/api/')) {
        return new NextResponse('setup required', { status: 401 });
      }

      const url = req.nextUrl.clone();
      url.pathname = '/setup';
      url.search = '';
      return NextResponse.redirect(url);
    }
  }

  return NextResponse.next();
}

export const config = {
  matcher: [
    '/((?!_next/static|_next/image|favicon.ico|icon-.*\\.png|sw\\.js|manifest\\.webmanifest).*)',
  ],
};
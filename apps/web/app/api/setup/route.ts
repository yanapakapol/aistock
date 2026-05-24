import { NextResponse } from 'next/server';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export const runtime = 'nodejs';

const BEARER_COOKIE = 'aistock_bearer';
const COOKIE_MAX_AGE_SEC = 60 * 60 * 24 * 90; // 90 days

function constantTimeStringEq(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  try {
    return timingSafeEqual(ab, bb);
  } catch {
    return false;
  }
}

export async function POST(req: Request) {
  const secret = process.env.SETUP_BEARER_HMAC_SECRET;
  if (!secret) {
    return NextResponse.json(
      { ok: false, error: 'setup_disabled' },
      { status: 503 },
    );
  }

  let body: { secret?: string } | null = null;
  try {
    body = (await req.json()) as { secret?: string };
  } catch {
    return NextResponse.json({ ok: false, error: 'invalid_json' }, { status: 400 });
  }

  const provided = body?.secret;
  if (typeof provided !== 'string' || provided.length === 0) {
    return NextResponse.json({ ok: false, error: 'missing_secret' }, { status: 400 });
  }

  // The user-entered secret is the same value used as the HMAC key on the server.
  // We verify by checking the provided value matches `SETUP_BEARER_HMAC_SECRET`
  // in constant time, then mint a signed cookie bound to a random device ID.
  if (!constantTimeStringEq(provided, secret)) {
    return NextResponse.json({ ok: false, error: 'invalid_secret' }, { status: 401 });
  }

  const deviceId = randomBytes(16).toString('base64url');
  const issuedAt = Date.now().toString(36);
  const message = `${deviceId}.${issuedAt}`;
  const sig = createHmac('sha256', secret).update(message).digest('hex');
  const cookieVal = `${message}.${sig}`;

  const res = NextResponse.json({ ok: true });
  res.cookies.set(BEARER_COOKIE, cookieVal, {
    httpOnly: true,
    secure: true,
    sameSite: 'strict',
    path: '/',
    maxAge: COOKIE_MAX_AGE_SEC,
  });
  return res;
}

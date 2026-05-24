import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { sql } from 'drizzle-orm';
import { db } from '@/lib/db/client';
import { pushSubscriptions } from '@/lib/db/schema';
import { getCurrentUser } from '@/lib/auth/session';

export const runtime = 'nodejs';

// Zod-validated PushSubscription payload (the JSON shape that
// `PushSubscription.toJSON()` produces in the browser).
const Body = z.object({
  subscription: z.object({
    endpoint: z.string().url().max(2048),
    keys: z.object({
      p256dh: z.string().min(1).max(512),
      auth: z.string().min(1).max(512),
    }),
  }),
});

function requireSameOrigin(req: NextRequest) {
  const site = req.headers.get('sec-fetch-site');
  // Allow same-origin and the navigation/none case; reject cross-site posts.
  if (site && site !== 'same-origin' && site !== 'none') {
    throw new Response('cross-origin denied', { status: 403 });
  }
}

export async function POST(req: NextRequest) {
  try {
    requireSameOrigin(req);
  } catch (r) {
    return r as Response;
  }

  // Authenticated subscription only — push fan-out filters on user_id so a
  // global (NULL user_id) row would never receive any notification anyway.
  const me = await getCurrentUser().catch(() => null);
  if (!me) {
    return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 });
  }

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: 'invalid_json' }, { status: 400 });
  }
  const parsed = Body.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      { ok: false, error: 'invalid_subscription', detail: parsed.error.flatten() },
      { status: 400 },
    );
  }

  const { endpoint, keys } = parsed.data.subscription;
  const userAgent = req.headers.get('user-agent')?.slice(0, 512) ?? null;

  // Upsert on `endpoint` — refresh keys + clear any prior disable flag so a
  // user re-enabling notifications on the same device immediately gets pushes.
  // Reassign user_id on conflict too: if the same browser is re-subscribed
  // after a sign-out / sign-in into a different account, the row now belongs
  // to the new user (and the previous user stops getting that device's pushes).
  const [row] = await db
    .insert(pushSubscriptions)
    .values({
      userId: me.id,
      endpoint,
      p256dh: keys.p256dh,
      auth: keys.auth,
      userAgent,
    })
    .onConflictDoUpdate({
      target: pushSubscriptions.endpoint,
      set: {
        userId: me.id,
        p256dh: keys.p256dh,
        auth: keys.auth,
        userAgent,
        disabledAt: sql`NULL`,
      },
    })
    .returning({ id: pushSubscriptions.id });

  return NextResponse.json({ ok: true, id: row.id });
}

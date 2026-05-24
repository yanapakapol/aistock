import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { and, eq } from 'drizzle-orm';
import { db } from '@/lib/db/client';
import { pushSubscriptions } from '@/lib/db/schema';
import { getCurrentUser } from '@/lib/auth/session';

export const runtime = 'nodejs';

const Body = z.object({
  endpoint: z.string().url().max(2048),
});

function requireSameOrigin(req: NextRequest) {
  const site = req.headers.get('sec-fetch-site');
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

  // Authenticated unsubscribe — scope to the caller so user A can't disable
  // user B's subscription by guessing its endpoint URL.
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
    return NextResponse.json({ ok: false, error: 'invalid_endpoint' }, { status: 400 });
  }

  await db
    .update(pushSubscriptions)
    .set({ disabledAt: new Date() })
    .where(
      and(
        eq(pushSubscriptions.endpoint, parsed.data.endpoint),
        eq(pushSubscriptions.userId, me.id),
      ),
    );

  return NextResponse.json({ ok: true });
}

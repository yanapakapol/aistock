import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { sql } from 'drizzle-orm';
import { db } from '@/lib/db/client';
import { getCurrentUser } from '@/lib/auth/session';
import { ensureSchema } from '@/lib/db/ensure-schema';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * User-facing cap-increase request flow. A user opens a small modal, enters
 * the new cap they'd like (and optionally a reason), and this endpoint
 * inserts a `cap_requests` row in `pending` status. The admin sees it on
 * /admin/users and can approve (which updates `users.daily_*_cap`) or deny.
 *
 * Rate-limit guard: at most one pending request per user at a time. Avoids
 * spammy stacking and gives the admin a clean queue.
 */

const Body = z
  .object({
    requested_token_cap: z.number().int().positive().max(10_000_000).nullable().optional(),
    requested_usd_cap: z.number().positive().max(9999).nullable().optional(),
    reason: z.string().max(500).optional(),
  })
  .refine(
    (v) => v.requested_token_cap != null || v.requested_usd_cap != null,
    { message: 'must request at least one of token or USD cap' },
  );

export async function POST(req: NextRequest) {
  const site = req.headers.get('sec-fetch-site');
  if (site && site !== 'same-origin' && site !== 'none') {
    return NextResponse.json({ error: 'cross-origin denied' }, { status: 403 });
  }
  await ensureSchema().catch(() => undefined);

  const me = await getCurrentUser().catch(() => null);
  if (!me) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: 'invalid input', issues: parsed.error.issues }, { status: 400 });
  }
  const body = parsed.data;

  // Reject if there's already a pending request from this user.
  const [existing] = (await db.execute(sql`
    select id from cap_requests where user_id = ${me.id} and status = 'pending' limit 1
  `)) as unknown as Array<{ id: number }>;
  if (existing) {
    return NextResponse.json(
      { error: 'you already have a pending request — wait for admin to decide' },
      { status: 409 },
    );
  }

  const tokenCap = body.requested_token_cap ?? null;
  const usdCap =
    body.requested_usd_cap == null ? null : String(body.requested_usd_cap);
  const reason = body.reason?.trim() || null;

  await db.execute(sql`
    insert into cap_requests (user_id, requested_token_cap, requested_usd_cap, reason)
    values (${me.id}, ${tokenCap}, ${usdCap}, ${reason})
  `);

  return NextResponse.json({ ok: true });
}

/**
 * Returns the caller's most recent request (any status) plus their current
 * caps. Used by the in-app "Request more cap" button to show "pending —
 * waiting for admin" instead of letting the user spam-submit.
 */
export async function GET() {
  await ensureSchema().catch(() => undefined);
  const me = await getCurrentUser().catch(() => null);
  if (!me) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  const [caps] = (await db.execute(sql`
    select daily_token_cap, daily_usd_cap::text as daily_usd_cap, role::text as role
    from users where id = ${me.id} limit 1
  `)) as unknown as Array<{
    daily_token_cap: number | null;
    daily_usd_cap: string | null;
    role: string;
  }>;

  const [latest] = (await db.execute(sql`
    select id, requested_token_cap, requested_usd_cap::text as requested_usd_cap,
           reason, status::text as status, created_at, decided_at
    from cap_requests where user_id = ${me.id}
    order by created_at desc limit 1
  `)) as unknown as Array<{
    id: number;
    requested_token_cap: number | null;
    requested_usd_cap: string | null;
    reason: string | null;
    status: 'pending' | 'approved' | 'denied';
    created_at: Date | string;
    decided_at: Date | string | null;
  }>;

  return NextResponse.json({
    current_token_cap: caps?.daily_token_cap ?? null,
    current_usd_cap: caps?.daily_usd_cap == null ? null : Number(caps.daily_usd_cap),
    role: caps?.role ?? null,
    latest: latest
      ? {
          id: latest.id,
          requested_token_cap: latest.requested_token_cap,
          requested_usd_cap:
            latest.requested_usd_cap == null ? null : Number(latest.requested_usd_cap),
          reason: latest.reason,
          status: latest.status,
          created_at: new Date(latest.created_at).toISOString(),
          decided_at: latest.decided_at ? new Date(latest.decided_at).toISOString() : null,
        }
      : null,
  });
}

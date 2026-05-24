import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { sql } from 'drizzle-orm';
import { db } from '@/lib/db/client';
import { getCurrentUser } from '@/lib/auth/session';
import { ensureSchema } from '@/lib/db/ensure-schema';

export const runtime = 'nodejs';

async function requireAdmin(): Promise<{ ok: true; id: number } | { ok: false; res: Response }> {
  await ensureSchema().catch(() => undefined);
  const u = await getCurrentUser().catch(() => null);
  if (!u) return { ok: false, res: NextResponse.json({ error: 'unauthorized' }, { status: 401 }) };
  if (u.isAdmin) return { ok: true, id: u.id };
  const [row] = (await db.execute(
    sql`select role from users where id = ${u.id} limit 1`,
  )) as unknown as Array<{ role: string }>;
  if (!row || row.role !== 'admin') {
    return { ok: false, res: NextResponse.json({ error: 'forbidden' }, { status: 403 }) };
  }
  return { ok: true, id: u.id };
}

const Body = z.object({
  action: z.enum(['approve', 'deny']),
  // Admin can override the requested cap when approving (grant more or less).
  override_token_cap: z.number().int().nonnegative().nullable().optional(),
  override_usd_cap: z.number().nonnegative().max(9999).nullable().optional(),
});

/**
 * Approve or deny a single cap-increase request. On approval, copies the
 * requested (or overridden) values onto the target user's `daily_*_cap`
 * columns in one transaction so the cap takes effect on the user's next
 * request without any further admin step.
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const site = req.headers.get('sec-fetch-site');
  if (site && site !== 'same-origin' && site !== 'none') {
    return NextResponse.json({ error: 'cross-origin denied' }, { status: 403 });
  }
  const auth = await requireAdmin();
  if (!auth.ok) return auth.res;

  const { id: idStr } = await params;
  const reqId = Number.parseInt(idStr, 10);
  if (!Number.isInteger(reqId) || reqId <= 0) {
    return NextResponse.json({ error: 'bad id' }, { status: 400 });
  }
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: 'invalid input', issues: parsed.error.issues }, { status: 400 });
  }
  const body = parsed.data;

  // Pull the request to make sure it still exists and is pending.
  const [r] = (await db.execute(sql`
    select id, user_id, requested_token_cap, requested_usd_cap::text as requested_usd_cap, status
    from cap_requests where id = ${reqId} limit 1
  `)) as unknown as Array<{
    id: number;
    user_id: number;
    requested_token_cap: number | null;
    requested_usd_cap: string | null;
    status: 'pending' | 'approved' | 'denied';
  }>;
  if (!r) return NextResponse.json({ error: 'not found' }, { status: 404 });
  if (r.status !== 'pending') {
    return NextResponse.json({ error: `already ${r.status}` }, { status: 409 });
  }

  if (body.action === 'deny') {
    await db.execute(sql`
      update cap_requests
      set status = 'denied', decided_by_id = ${auth.id}, decided_at = now()
      where id = ${reqId}
    `);
    return NextResponse.json({ ok: true, action: 'denied' });
  }

  // Approve: pick override > requested, fall back to leaving the column alone.
  const newTokenCap =
    body.override_token_cap !== undefined ? body.override_token_cap : r.requested_token_cap;
  const newUsdCap =
    body.override_usd_cap !== undefined
      ? body.override_usd_cap == null
        ? null
        : String(body.override_usd_cap)
      : r.requested_usd_cap;

  // Only update the columns the request actually asks about.
  const updates: string[] = [];
  if (newTokenCap !== null && newTokenCap !== undefined) {
    updates.push(`daily_token_cap = ${Number(newTokenCap)}`);
  }
  if (newUsdCap !== null && newUsdCap !== undefined) {
    // numeric column — quote as a literal.
    updates.push(`daily_usd_cap = ${Number(newUsdCap)}`);
  }
  if (updates.length > 0) {
    // We build the SET list defensively (only numeric literals validated by
    // Zod above; no string interpolation of user-controlled text).
    await db.execute(
      sql.raw(`update users set ${updates.join(', ')} where id = ${r.user_id}`),
    );
  }
  await db.execute(sql`
    update cap_requests
    set status = 'approved', decided_by_id = ${auth.id}, decided_at = now()
    where id = ${reqId}
  `);

  return NextResponse.json({ ok: true, action: 'approved' });
}

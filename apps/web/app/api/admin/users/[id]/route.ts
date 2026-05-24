import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { eq, sql } from 'drizzle-orm';
import { db } from '@/lib/db/client';
import { users } from '@/lib/db/schema';
import { getCurrentUser } from '@/lib/auth/session';

export const runtime = 'nodejs';

interface AdminCheckOk {
  ok: true;
  callerId: number;
}
interface AdminCheckDeny {
  ok: false;
  res: Response;
}
type AdminCheck = AdminCheckOk | AdminCheckDeny;

async function requireAdmin(): Promise<AdminCheck> {
  const u = await getCurrentUser().catch(() => null);
  if (!u) return { ok: false, res: NextResponse.json({ error: 'unauthorized' }, { status: 401 }) };
  const [row] = (await db.execute(
    sql`select role from users where id = ${u.id} limit 1`,
  )) as unknown as Array<{ role: string }>;
  if (!row || row.role !== 'admin') {
    return { ok: false, res: NextResponse.json({ error: 'forbidden' }, { status: 403 }) };
  }
  return { ok: true, callerId: u.id };
}

function requireSameOrigin(req: NextRequest): Response | null {
  const site = req.headers.get('sec-fetch-site');
  if (site && site !== 'same-origin' && site !== 'none') {
    return new NextResponse('cross-origin denied', { status: 403 });
  }
  return null;
}

async function countAdmins(): Promise<number> {
  const [r] = (await db.execute(
    sql`select count(*)::int as count from users where role = 'admin'`,
  )) as unknown as Array<{ count: number }>;
  return Number(r?.count ?? 0);
}

const PatchBody = z
  .object({
    daily_token_cap: z.number().int().nonnegative().nullable().optional(),
    // numeric(8,4) — clamp to a sane range.
    daily_usd_cap: z.number().nonnegative().max(9999).nullable().optional(),
    // ISO timestamp string OR null to clear.
    expires_at: z.string().datetime().nullable().optional(),
    role: z.enum(['admin', 'user', 'guest']).optional(),
  })
  .strict();

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const sameOrigin = requireSameOrigin(req);
  if (sameOrigin) return sameOrigin;

  const auth = await requireAdmin();
  if (!auth.ok) return auth.res;

  const { id: idStr } = await params;
  const targetId = Number.parseInt(idStr, 10);
  if (!Number.isInteger(targetId) || targetId <= 0) {
    return NextResponse.json({ error: 'bad id' }, { status: 400 });
  }

  const parsed = PatchBody.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: 'bad request', issues: parsed.error.issues }, { status: 400 });
  }
  const body = parsed.data;

  // Always-one-admin invariant: caller cannot demote themselves if they are
  // the last admin.
  if (body.role && body.role !== 'admin' && targetId === auth.callerId) {
    const n = await countAdmins();
    if (n <= 1) {
      return NextResponse.json(
        { error: 'cannot remove the last admin role from yourself' },
        { status: 409 },
      );
    }
  }

  const patch: Record<string, unknown> = {};
  if ('daily_token_cap' in body) patch.dailyTokenCap = body.daily_token_cap;
  if ('daily_usd_cap' in body) {
    // numeric column in Drizzle expects string|null.
    patch.dailyUsdCap = body.daily_usd_cap == null ? null : String(body.daily_usd_cap);
  }
  if ('expires_at' in body) {
    patch.expiresAt = body.expires_at == null ? null : new Date(body.expires_at);
  }
  if (body.role) {
    patch.role = body.role;
    // Keep legacy `is_admin` boolean in sync so existing code paths (session
    // payload, /api/auth/me) continue to reflect role accurately.
    patch.isAdmin = body.role === 'admin';
  }

  if (Object.keys(patch).length === 0) {
    return NextResponse.json({ ok: true, noop: true });
  }

  await db.update(users).set(patch).where(eq(users.id, targetId));
  return NextResponse.json({ ok: true });
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const sameOrigin = requireSameOrigin(req);
  if (sameOrigin) return sameOrigin;

  const auth = await requireAdmin();
  if (!auth.ok) return auth.res;

  const { id: idStr } = await params;
  const targetId = Number.parseInt(idStr, 10);
  if (!Number.isInteger(targetId) || targetId <= 0) {
    return NextResponse.json({ error: 'bad id' }, { status: 400 });
  }

  // Refuse to delete the last admin.
  const [target] = (await db.execute(
    sql`select role from users where id = ${targetId} limit 1`,
  )) as unknown as Array<{ role: string }>;
  if (!target) {
    return NextResponse.json({ error: 'not found' }, { status: 404 });
  }
  if (target.role === 'admin') {
    const n = await countAdmins();
    if (n <= 1) {
      return NextResponse.json(
        { error: 'cannot delete the last admin' },
        { status: 409 },
      );
    }
  }

  // FK cascade rules on the schema take care of portfolios/chats/api_keys/etc.
  await db.delete(users).where(eq(users.id, targetId));
  return NextResponse.json({ ok: true });
}

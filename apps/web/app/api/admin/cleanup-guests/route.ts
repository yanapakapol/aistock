import { NextResponse, type NextRequest } from 'next/server';
import { eq } from 'drizzle-orm';
import { db } from '@/lib/db/client';
import { users } from '@/lib/db/schema';
import { getCurrentUser } from '@/lib/auth/session';
import { cleanupExpiredGuestData } from '@/lib/auth/guest-cleanup';

export const runtime = 'nodejs';

/**
 * POST /api/admin/cleanup-guests — admin-only. Wipes data for any guest
 * accounts past their `expires_at` and rolls the window forward 7 days.
 * The scheduler hits this same code path on its daily 03:00 UTC tick.
 */
export async function POST(req: NextRequest) {
  if (req.headers.get('sec-fetch-site') && req.headers.get('sec-fetch-site') !== 'same-origin') {
    return NextResponse.json({ error: 'cross-origin denied' }, { status: 403 });
  }

  const me = await getCurrentUser();
  if (!me) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  // `getCurrentUser()` does not currently surface `role`, so look it up
  // directly. Spec requires `role === 'admin'` (not just the legacy
  // `is_admin` flag).
  const [row] = await db
    .select({ role: users.role })
    .from(users)
    .where(eq(users.id, me.id))
    .limit(1);
  if (!row || row.role !== 'admin') {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }

  try {
    const summary = await cleanupExpiredGuestData();
    return NextResponse.json({ ok: true, ...summary });
  } catch (err) {
    const msg = (err as { message?: string })?.message ?? 'cleanup failed';
    return NextResponse.json({ error: 'cleanup failed', detail: msg }, { status: 500 });
  }
}

import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { and, desc, eq } from 'drizzle-orm';
import { db } from '@/lib/db/client';
import { routineRuns, routines } from '@/lib/db/schema';
import { getCurrentUser } from '@/lib/auth/session';

export const runtime = 'nodejs';

const IdSchema = z.coerce.number().int().positive();

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const me = await getCurrentUser();
  if (!me) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  const { id: idRaw } = await params;
  const idParsed = IdSchema.safeParse(idRaw);
  if (!idParsed.success) return NextResponse.json({ error: 'bad id' }, { status: 400 });
  const routineId = idParsed.data;

  // routine_runs has no user_id of its own — it inherits ownership from the
  // parent routine. Verify ownership BEFORE returning any rows, otherwise a
  // signed-in user can read another user's run output (which is the LLM's
  // raw response and may quote private data) by guessing routine ids.
  const owner = await db
    .select({ id: routines.id })
    .from(routines)
    .where(and(eq(routines.id, routineId), eq(routines.userId, me.id)))
    .limit(1);
  if (owner.length === 0) {
    // Same 404 used by the [id] route to avoid leaking the existence of
    // other users' routine ids.
    return NextResponse.json({ error: 'not found' }, { status: 404 });
  }

  const rows = await db
    .select()
    .from(routineRuns)
    .where(eq(routineRuns.routineId, routineId))
    .orderBy(desc(routineRuns.startedAt))
    .limit(20);

  // neon-http roundtrips Postgres numeric as a string. The client expects a
  // number (calls .toFixed() etc.), so coerce each row.
  const coerced = rows.map((r) => ({
    ...r,
    usdSpent: r.usdSpent == null ? null : Number(r.usdSpent),
  }));

  return NextResponse.json({ runs: coerced });
}

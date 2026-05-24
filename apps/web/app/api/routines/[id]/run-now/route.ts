import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { and, eq } from 'drizzle-orm';
import { db } from '@/lib/db/client';
import { routines, routineRuns } from '@/lib/db/schema';
import { getCurrentUser } from '@/lib/auth/session';
import { getScheduler } from '@/lib/scheduler';
import { runRoutineOnce, type RoutineForRun } from '@/lib/scheduler/run';

export const runtime = 'nodejs';

const IdSchema = z.coerce.number().int().positive();

function requireSameOrigin(req: NextRequest) {
  const site = req.headers.get('sec-fetch-site');
  if (site && site !== 'same-origin') {
    throw new Response('cross-origin denied', { status: 403 });
  }
}

interface SchedulerWithRunNow {
  runNow?: (routineId: number) => Promise<{ routineRunId: number }>;
  reload: (routineId: number) => Promise<void> | void;
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    requireSameOrigin(req);
  } catch (r) {
    return r as Response;
  }

  const me = await getCurrentUser();
  if (!me) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  const { id: idRaw } = await params;
  const idParsed = IdSchema.safeParse(idRaw);
  if (!idParsed.success) return NextResponse.json({ error: 'bad id' }, { status: 400 });
  const routineId = idParsed.data;

  // Owner-scoped load — orphan rows (user_id IS NULL, pre-multitenant) won't
  // match, and another user's routine returns the same 404 to avoid leaking
  // routine ids across tenants.
  const rows = await db
    .select()
    .from(routines)
    .where(and(eq(routines.id, routineId), eq(routines.userId, me.id)))
    .limit(1);
  const routine = rows[0];
  if (!routine) return NextResponse.json({ error: 'not found' }, { status: 404 });

  // Prefer the scheduler's own runNow if it exposes one (so concurrency limits,
  // backoff, and per-provider queues are honored). Fall back to a direct
  // fire-and-forget invocation of runRoutineOnce + a pre-inserted pending row,
  // which is enough for the UI to start polling for results.
  const scheduler = getScheduler() as unknown as SchedulerWithRunNow;
  if (typeof scheduler.runNow === 'function') {
    try {
      const { routineRunId } = await scheduler.runNow(routineId);
      return NextResponse.json({ routineRunId }, { status: 202 });
    } catch (err) {
      return NextResponse.json(
        { error: 'run-now failed', detail: (err as Error).message },
        { status: 500 },
      );
    }
  }

  // Fallback path: pre-insert a pending row so the UI can show "queued",
  // then fire-and-forget the actual run.
  const [pending] = await db
    .insert(routineRuns)
    .values({ routineId, status: 'pending' })
    .returning({ id: routineRuns.id });

  const forRun: RoutineForRun = {
    id: routine.id,
    name: routine.name,
    prompt: routine.prompt,
    model: routine.model,
    fallbackModels: routine.fallbackModels,
    maxUsdPerRun: routine.maxUsdPerRun,
    tz: routine.tz,
  };
  // Fire and forget — caller polls /runs for status.
  void runRoutineOnce(forRun).catch(() => {
    // runRoutineOnce already records 'failed' state; swallow to avoid unhandled rejection.
  });

  return NextResponse.json({ routineRunId: pending.id }, { status: 202 });
}

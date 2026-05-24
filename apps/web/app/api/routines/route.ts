import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { desc, eq } from 'drizzle-orm';
import { CronExpressionParser } from 'cron-parser';
import { db } from '@/lib/db/client';
import { routines } from '@/lib/db/schema';
import { getCurrentUser } from '@/lib/auth/session';
import { getScheduler } from '@/lib/scheduler';

export const runtime = 'nodejs';

const TabEnum = z.enum(['research', 'analysis']);

const CreateBody = z.object({
  name: z.string().min(1).max(120),
  prompt: z.string().min(1).max(8000),
  tab: TabEnum,
  model: z.string().min(1).max(128),
  fallbackModels: z.array(z.string().min(1).max(128)).max(8).optional(),
  cronExpr: z.string().min(1).max(64),
  tz: z.string().min(1).max(64).default('Asia/Bangkok'),
  maxUsdPerRun: z.number().positive().max(100).optional(),
});

function requireSameOrigin(req: NextRequest) {
  const site = req.headers.get('sec-fetch-site');
  if (site && site !== 'same-origin') {
    throw new Response('cross-origin denied', { status: 403 });
  }
}

function validateCron(expr: string, tz: string): string | null {
  try {
    CronExpressionParser.parse(expr, { tz });
    return null;
  } catch (err) {
    return (err as Error).message || 'invalid cron expression';
  }
}

// neon-http roundtrips Postgres numeric as a string. The client expects a
// number (calls .toFixed() etc.), so coerce here. `maxUsdPerRun` is NOT NULL
// in the schema, but tolerate null defensively in case that ever changes.
function coerceRoutine<T extends { maxUsdPerRun: string | number | null }>(r: T) {
  return {
    ...r,
    maxUsdPerRun: r.maxUsdPerRun == null ? null : Number(r.maxUsdPerRun),
  };
}

export async function GET() {
  // Authenticated, per-user list. Rows with NULL user_id (created before the
  // ownership column landed) are orphans and intentionally invisible here.
  const me = await getCurrentUser();
  if (!me) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  const rows = await db
    .select()
    .from(routines)
    .where(eq(routines.userId, me.id))
    .orderBy(desc(routines.createdAt));
  return NextResponse.json({ routines: rows.map(coerceRoutine) });
}

export async function POST(req: NextRequest) {
  try {
    requireSameOrigin(req);
  } catch (r) {
    return r as Response;
  }

  const me = await getCurrentUser();
  if (!me) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  const json = await req.json().catch(() => null);
  const parsed = CreateBody.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'bad request', issues: parsed.error.issues },
      { status: 400 },
    );
  }

  const data = parsed.data;
  const cronErr = validateCron(data.cronExpr, data.tz);
  if (cronErr) {
    return NextResponse.json({ error: 'invalid cron', detail: cronErr }, { status: 400 });
  }

  try {
    const [inserted] = await db
      .insert(routines)
      .values({
        userId: me.id,
        name: data.name,
        prompt: data.prompt,
        tab: data.tab,
        model: data.model,
        fallbackModels: data.fallbackModels ?? [],
        cronExpr: data.cronExpr,
        tz: data.tz,
        // numeric columns take strings in Drizzle
        ...(data.maxUsdPerRun != null
          ? { maxUsdPerRun: data.maxUsdPerRun.toFixed(4) }
          : {}),
      })
      .returning();

    try {
      await getScheduler().reload(inserted.id);
    } catch {
      // Scheduler reload failures are non-fatal at create time; the catch-up
      // path will pick the routine up on next boot.
    }

    return NextResponse.json({ routine: coerceRoutine(inserted) }, { status: 201 });
  } catch (err) {
    return NextResponse.json(
      { error: 'insert failed', detail: (err as Error).message },
      { status: 500 },
    );
  }
}

import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { and, eq } from 'drizzle-orm';
import { CronExpressionParser } from 'cron-parser';
import { db } from '@/lib/db/client';
import { routines } from '@/lib/db/schema';
import { getCurrentUser } from '@/lib/auth/session';
import { getScheduler } from '@/lib/scheduler';

export const runtime = 'nodejs';

const IdSchema = z.coerce.number().int().positive();

const TabEnum = z.enum(['research', 'analysis']);

const PatchBody = z
  .object({
    name: z.string().min(1).max(120).optional(),
    prompt: z.string().min(1).max(8000).optional(),
    tab: TabEnum.optional(),
    model: z.string().min(1).max(128).optional(),
    fallbackModels: z.array(z.string().min(1).max(128)).max(8).optional(),
    cronExpr: z.string().min(1).max(64).optional(),
    tz: z.string().min(1).max(64).optional(),
    enabled: z.boolean().optional(),
    maxUsdPerRun: z.number().positive().max(100).optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: 'no fields to update' });

function requireSameOrigin(req: NextRequest) {
  const site = req.headers.get('sec-fetch-site');
  if (site && site !== 'same-origin') {
    throw new Response('cross-origin denied', { status: 403 });
  }
}

/**
 * Owner-scoped routine fetch. Rows with `user_id IS NULL` (pre-multitenant
 * orphans) are treated as not owned by anyone and won't match this query —
 * exactly the behavior we want from a security-isolation standpoint.
 */
async function loadOwnedRoutine(id: number, userId: number) {
  const rows = await db
    .select()
    .from(routines)
    .where(and(eq(routines.id, id), eq(routines.userId, userId)))
    .limit(1);
  return rows[0] ?? null;
}

export async function PATCH(
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
  const id = idParsed.data;

  const json = await req.json().catch(() => null);
  const parsed = PatchBody.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'bad request', issues: parsed.error.issues },
      { status: 400 },
    );
  }

  // Ownership gate BEFORE any write — never trust the id alone.
  const existing = await loadOwnedRoutine(id, me.id);
  if (!existing) return NextResponse.json({ error: 'not found' }, { status: 404 });

  const data = parsed.data;

  // If either cron or tz is changing, re-validate the resulting pair.
  if (data.cronExpr !== undefined || data.tz !== undefined) {
    const cron = data.cronExpr ?? existing.cronExpr;
    const tz = data.tz ?? existing.tz;
    try {
      CronExpressionParser.parse(cron, { tz });
    } catch (err) {
      return NextResponse.json(
        { error: 'invalid cron', detail: (err as Error).message },
        { status: 400 },
      );
    }
  }

  const update: Record<string, unknown> = {};
  if (data.name !== undefined) update.name = data.name;
  if (data.prompt !== undefined) update.prompt = data.prompt;
  if (data.tab !== undefined) update.tab = data.tab;
  if (data.model !== undefined) update.model = data.model;
  if (data.fallbackModels !== undefined) update.fallbackModels = data.fallbackModels;
  if (data.cronExpr !== undefined) update.cronExpr = data.cronExpr;
  if (data.tz !== undefined) update.tz = data.tz;
  if (data.enabled !== undefined) update.enabled = data.enabled;
  if (data.maxUsdPerRun !== undefined) update.maxUsdPerRun = data.maxUsdPerRun.toFixed(4);

  // Belt-and-braces: the WHERE filters by user_id too, so a TOCTOU race on
  // ownership transfer can't sneak a write past the gate.
  const [updated] = await db
    .update(routines)
    .set(update)
    .where(and(eq(routines.id, id), eq(routines.userId, me.id)))
    .returning();

  try {
    await getScheduler().reload(id);
  } catch {
    // non-fatal
  }

  // neon-http roundtrips Postgres numeric as a string; coerce so the client
  // can call .toFixed() etc. without crashing.
  const coerced = {
    ...updated,
    maxUsdPerRun:
      updated.maxUsdPerRun == null ? null : Number(updated.maxUsdPerRun),
  };

  return NextResponse.json({ routine: coerced });
}

export async function DELETE(
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
  const id = idParsed.data;

  // Ownership filter is baked into the DELETE itself — another user's id
  // (or a NULL-user_id orphan) won't match, so the result.length === 0
  // branch returns the same 404 used for "doesn't exist" to avoid leaking
  // the existence of other users' routine ids.
  const result = await db
    .delete(routines)
    .where(and(eq(routines.id, id), eq(routines.userId, me.id)))
    .returning({ id: routines.id });
  if (result.length === 0) return NextResponse.json({ error: 'not found' }, { status: 404 });

  try {
    await getScheduler().reload(id);
  } catch {
    // non-fatal: scheduler should drop unknown ids gracefully on next reload.
  }

  return NextResponse.json({ ok: true, deletedId: result[0].id });
}

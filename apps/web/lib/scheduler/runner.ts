import 'server-only';
import { eq } from 'drizzle-orm';
import { db } from '../db/client';
import { routines } from '../db/schema';
import { runRoutineOnce, type RoutineForRun } from './run';

/**
 * Entry point invoked by both the live cron tick and the catch-up loop.
 *
 * Loads the routine fresh from the DB each time (so enabled-flag flips and
 * prompt edits take effect without a re-arm) and delegates to
 * `runRoutineOnce`. If the routine has been deleted or disabled between the
 * cron firing and this call, we bail silently — the cron will be cleaned up
 * on the next `reload()`.
 */
export async function runRoutineById(routineId: number): Promise<void> {
  const rows = await db
    .select({
      id: routines.id,
      name: routines.name,
      prompt: routines.prompt,
      model: routines.model,
      fallbackModels: routines.fallbackModels,
      maxUsdPerRun: routines.maxUsdPerRun,
      tz: routines.tz,
      enabled: routines.enabled,
    })
    .from(routines)
    .where(eq(routines.id, routineId))
    .limit(1);

  const row = rows[0];
  if (!row || !row.enabled) return;

  const routine: RoutineForRun = {
    id: row.id,
    name: row.name,
    prompt: row.prompt,
    model: row.model,
    fallbackModels: row.fallbackModels ?? [],
    maxUsdPerRun: row.maxUsdPerRun,
    tz: row.tz,
  };

  await runRoutineOnce(routine);
}

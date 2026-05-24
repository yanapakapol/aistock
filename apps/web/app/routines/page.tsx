import { desc } from 'drizzle-orm';
import { db } from '@/lib/db/client';
import { routines } from '@/lib/db/schema';
import { RoutinesClient, type RoutineDTO } from './routines-client';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

function serializeRoutine(r: typeof routines.$inferSelect): RoutineDTO {
  return {
    id: r.id,
    name: r.name,
    prompt: r.prompt,
    tab: r.tab,
    model: r.model,
    fallbackModels: r.fallbackModels,
    cronExpr: r.cronExpr,
    tz: r.tz,
    enabled: r.enabled,
    maxUsdPerRun: r.maxUsdPerRun,
    lastRunAt: r.lastRunAt ? r.lastRunAt.toISOString() : null,
    lastRunStatus: r.lastRunStatus,
    createdAt: r.createdAt.toISOString(),
  };
}

export default async function RoutinesPage() {
  const rows = await db
    .select()
    .from(routines)
    .orderBy(desc(routines.createdAt))
    .catch(() => []);
  const initial = rows.map(serializeRoutine);

  return (
    <div className="h-full overflow-hidden">
      <RoutinesClient initialRoutines={initial} />
    </div>
  );
}

/**
 * Shared types for the in-process routine scheduler (M5-1).
 *
 * `ScheduledRoutine` is the projection of a `routines` row used by the
 * scheduler runtime. Mirrors the columns defined in
 * `apps/web/lib/db/schema.ts` (`routines` table) but keeps the surface
 * small so the scheduler does not pull the whole Drizzle row shape.
 */
export interface ScheduledRoutine {
  id: number;
  name: string;
  cronExpr: string;
  tz: string;
  lastRunAt: Date | null;
  enabled: boolean;
}

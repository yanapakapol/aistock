/**
 * Next.js calls `register()` once per server process. We use this hook for
 * two things:
 *
 *   1. Schema self-heal (always, on any Node runtime) — kicked off in the
 *      background so the first request after a cold start is fast.
 *   2. Booting the in-process scheduler — ONLY when the host is a
 *      long-running Node process. On Vercel (serverless) the process dies
 *      between requests so `croner` would never tick; routines there are
 *      driven by Vercel Cron Jobs hitting `/api/cron/tick` instead.
 *
 * The `webpackIgnore` magic comment on the scheduler import is essential:
 * without it, Webpack statically follows the import target and tries to
 * bundle the scheduler + its transitive native deps even though the call
 * is gated at runtime.
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;

  // Schema self-heal: kick off the bumps in the background so the first
  // request after a cold start doesn't have to pay for them. Once the DB
  // driver switches to `@neondatabase/serverless` (HTTP, no `net`/`tls`)
  // this is safe to bundle into instrumentation. setImmediate keeps the
  // boot path itself fast — the dynamic import + bump happens on the next
  // tick.
  try {
    setImmediate(async () => {
      try {
        const { ensureSchemaSync } = await import('./lib/db/ensure-schema');
        await ensureSchemaSync();
      } catch (err) {
        console.error('[ensureSchema] boot kickoff failed:', err);
      }
    });
  } catch {
    /* boot path stays clean */
  }

  // In-process cron only fires while a long-running Node process stays
  // alive. On Vercel (and other serverless hosts) the function dies after
  // each request, so `croner` never gets to tick — that's why production
  // routines are driven by Vercel Cron Jobs hitting `/api/cron/tick`
  // instead (see `apps/web/vercel.json`).
  //
  // The in-process scheduler is therefore only started when:
  //   1. We're in local dev (`NODE_ENV !== 'production'`, before this
  //      function early-returns above — note we already returned in that
  //      branch in older versions; that gate is now removed so dev DOES
  //      start it), OR
  //   2. The host operator explicitly opts in with
  //      `AISTOCK_INPROCESS_SCHEDULER=1` (self-hosted long-running Node
  //      where Vercel Cron isn't available).
  // On Vercel (production), neither holds and we skip startup entirely.
  const isLocalDev = process.env.NODE_ENV !== 'production';
  const isExplicitOptIn = process.env.AISTOCK_INPROCESS_SCHEDULER === '1';
  if (!isLocalDev && !isExplicitOptIn) return;
  try {
    const mod = await import(/* webpackIgnore: true */ './lib/scheduler/index.js');
    await mod.getScheduler().start();
  } catch (err) {
    console.error('[scheduler] failed to start:', err);
  }
}

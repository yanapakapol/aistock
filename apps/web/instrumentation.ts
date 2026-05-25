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

  // SCHEDULER BOOT REMOVED. Reasoning:
  //
  // - On Vercel (prod): the serverless function dies between requests, so
  //   an in-process cron would never tick anyway. Vercel Cron Jobs hitting
  //   `/api/cron/tick` are the prod path (see `apps/web/vercel.json`).
  // - On local dev: `import('./lib/scheduler')` made webpack follow the
  //   transitive chain (scheduler → run → mcp/tools/index → searchStocks
  //   → market/yahoo → yahoo-finance2 → @deno/shim-deno → require('tty'))
  //   and FAIL the entire instrumentation bundle. `webpackIgnore: true`
  //   evaded the bundling but then the runtime path didn't resolve under
  //   .next/server/. Either way the scheduler boot from instrumentation
  //   didn't actually start anything.
  //
  // For local dev with cron-driven routines, run a separate process that
  // polls `/api/cron/tick` (cron-job.org, GitHub Actions, or a tiny
  // `setInterval(() => fetch('/api/cron/tick'), 60_000)` script). The
  // routine logic itself (`runRoutineOnce`) is exported and works fine
  // — it's only the in-process trigger that's gone.
}

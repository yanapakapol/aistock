/**
 * Next.js calls `register()` once per server process. We skip in dev so the
 * scheduler chain (which transitively imports yahoo-finance2 + @primno/dpapi
 * + node-gyp-build) is never analyzed by the dev bundler.
 *
 * The `webpackIgnore` magic comment is essential: without it, Webpack
 * statically follows the import target and tries to bundle the scheduler
 * + its transitive native deps even though the call is gated at runtime.
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;
  // Self-heal schema on every cold start (prod + dev). Idempotent — re-runs
  // the IF NOT EXISTS / DO blocks from migrate.ts so the platform doesn't
  // 500 when deployed against a database that hasn't had `db:migrate` run.
  try {
    const { ensureSchema } = await import('./lib/db/ensure-schema');
    await ensureSchema();
  } catch (err) {
    console.error('[ensureSchema] failed at boot:', err);
    // Routes also call ensureSchema() lazily, so don't crash the server here.
  }
  if (process.env.NODE_ENV !== 'production') return;
  try {
    const mod = await import(/* webpackIgnore: true */ './lib/scheduler/index.js');
    await mod.getScheduler().start();
  } catch (err) {
    console.error('[scheduler] failed to start:', err);
  }
}

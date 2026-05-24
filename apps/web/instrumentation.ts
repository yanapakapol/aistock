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

  if (process.env.NODE_ENV !== 'production') return;
  try {
    const mod = await import(/* webpackIgnore: true */ './lib/scheduler/index.js');
    await mod.getScheduler().start();
  } catch (err) {
    console.error('[scheduler] failed to start:', err);
  }
}

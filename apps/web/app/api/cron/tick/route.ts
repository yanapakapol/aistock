import { NextResponse, type NextRequest } from 'next/server';
import { runDueRoutines } from '@/lib/scheduler/run';

/**
 * GET /api/cron/tick — invoked by Vercel Cron Jobs on the schedule declared
 * in `apps/web/vercel.json` (currently `*​/5 * * * *`, the Hobby-plan
 * minimum granularity).
 *
 * Responsibility:
 *   - Run every routine whose next scheduled fire (cron_expr + tz, anchored
 *     at last_run_at) is now-or-past. See `lib/scheduler/run.ts#runDueRoutines`.
 *   - Sweep expired guest accounts (cheap + idempotent so we don't bother
 *     gating it — every-5-min is fine).
 *
 * Auth:
 *   Vercel automatically attaches `Authorization: Bearer ${CRON_SECRET}` to
 *   the request when the cron is declared in `vercel.json`. We require this
 *   header so an attacker hitting the public URL can't fan-out free LLM
 *   calls on user accounts. To configure:
 *     1. Generate a secret: `openssl rand -hex 32` (or any high-entropy value).
 *     2. Vercel dashboard → Project → Settings → Environment Variables →
 *        add `CRON_SECRET` for Production (and Preview if you want to test
 *        crons there). Do NOT expose it to the browser (no NEXT_PUBLIC_).
 *     3. Redeploy. Vercel injects the header automatically on cron
 *        invocations; no client code needs to know the value.
 *
 *   For local manual testing: `curl -H "Authorization: Bearer $CRON_SECRET" \
 *     http://localhost:3000/api/cron/tick`
 *
 *   If `CRON_SECRET` is unset (e.g. preview deploy without the env var),
 *   we DENY all requests — failing closed is safer than open-by-default.
 *
 * Runtime: forced to Node because the scheduler chain transitively imports
 * native modules (yahoo-finance2, optional @primno/dpapi). Edge would
 * crash.
 *
 * Timeout: keep this within Vercel's default function limit (10s Hobby,
 * 60s Pro). `runDueRoutines` already runs routines sequentially with no
 * built-in retry, so worst-case latency is "N due routines × per-routine
 * LLM time". For typical daily / hourly routines, only one will be due
 * per tick.
 */

// Node runtime is required — see comment above. Edge cannot import the
// scheduler graph (cron-parser is fine, but the run path pulls in MCP tool
// adapters that use Node-only deps).
export const runtime = 'nodejs';

// Disable any Next.js caching layer for this route. Cron MUST execute each
// time it's hit, not serve a stale 200 from the CDN.
export const dynamic = 'force-dynamic';

// Cap the function timeout. Vercel Hobby maxes at 10s for serverless
// functions; Pro at 60s. We request 60s and Vercel will clamp on Hobby.
// If you have lots of due routines per tick and start hitting timeouts,
// the right fix is to shard work across multiple cron paths, not bump
// this — but the knob is here.
export const maxDuration = 60;

export async function GET(req: NextRequest) {
  // Fail closed if the secret is missing: better a broken cron than a
  // publicly invokable endpoint that costs the user money.
  const expected = process.env.CRON_SECRET;
  if (!expected) {
    // eslint-disable-next-line no-console
    console.error('[cron-tick] CRON_SECRET is not set; refusing all requests');
    return NextResponse.json(
      { error: 'cron not configured' },
      { status: 503 },
    );
  }

  const auth = req.headers.get('authorization');
  // Vercel always sends `Bearer <secret>`. We do a constant-prefix compare
  // (timing here is not critical since the secret comes from a trusted
  // upstream, but the strict equality keeps the check simple).
  if (auth !== `Bearer ${expected}`) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  try {
    const result = await runDueRoutines();
    return NextResponse.json({
      ok: true,
      runRoutines: result.ranRoutines,
      ranRoutineIds: result.ranRoutineIds,
      skippedRoutines: result.skippedRoutines,
      cleanedGuests: result.cleanedGuests,
      cleanedGuestRows: result.cleanedGuestRows,
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[cron-tick] unhandled:', err);
    return NextResponse.json(
      {
        ok: false,
        error: 'tick failed',
        detail: (err as { message?: string })?.message ?? String(err),
      },
      { status: 500 },
    );
  }
}

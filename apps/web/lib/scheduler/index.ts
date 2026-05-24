import 'server-only';
import { Cron } from 'croner';
import { eq } from 'drizzle-orm';
import { db } from '../db/client';
import { routines } from '../db/schema';
import { computeCatchupBatch, enumerateMissedFires } from './catchup';
import { runRoutineById } from './runner';
import type { ScheduledRoutine } from './types';

// Backoff sequence (ms) between catch-up fires, per the M5 plan.
const CATCHUP_BACKOFF_MS = [15_000, 45_000, 120_000];

function log(...args: unknown[]) {
  // eslint-disable-next-line no-console
  console.log('[scheduler]', ...args);
}

function logError(...args: unknown[]) {
  // eslint-disable-next-line no-console
  console.error('[scheduler]', ...args);
}

/**
 * In-process routine scheduler.
 *
 * One instance lives on `globalThis.__aistockScheduler` so Next.js HMR
 * (which re-evaluates modules but preserves the global) does not spawn
 * duplicate Cron jobs. Boot from `instrumentation.ts#register`.
 */
export class Scheduler {
  /** Arm of live cron jobs, keyed by routine id. */
  private jobs = new Map<number, Cron>();
  /** Set true after first start() so subsequent reload()s work without re-running catch-up. */
  private started = false;

  /**
   * Boot the scheduler: catch up on missed fires for each enabled routine
   * sequentially (per-provider concurrency=1 enforced by running them in a
   * single async loop with backoff), then arm a live cron for each.
   *
   * Safe to call twice — second call is a no-op.
   */
  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;

    const all = await this.loadEnabledRoutines();
    log(`starting with ${all.length} enabled routines`);

    // 1. Catch-up phase, sequential across all routines.
    const now = new Date();
    for (const r of all) {
      try {
        await this.catchUpRoutine(r, now);
      } catch (err) {
        logError(`catch-up failed for routine ${r.id} (${r.name}):`, err);
      }
    }

    // 2. Arm live crons.
    for (const r of all) {
      this.arm(r);
    }
  }

  /** Stop every armed cron. Safe to call multiple times. */
  stop(): void {
    for (const [, job] of this.jobs) {
      try {
        job.stop();
      } catch (err) {
        logError('error stopping cron:', err);
      }
    }
    this.jobs.clear();
    this.started = false;
  }

  /**
   * Re-read one routine from the DB and (re)arm its cron. Used by the
   * /api/routines mutating endpoints after create/update/delete/toggle.
   */
  async reload(routineId: number): Promise<void> {
    // Stop any existing job first.
    const existing = this.jobs.get(routineId);
    if (existing) {
      try {
        existing.stop();
      } catch (err) {
        logError(`error stopping cron for routine ${routineId}:`, err);
      }
      this.jobs.delete(routineId);
    }

    const rows = await db
      .select({
        id: routines.id,
        name: routines.name,
        cronExpr: routines.cronExpr,
        tz: routines.tz,
        lastRunAt: routines.lastRunAt,
        enabled: routines.enabled,
      })
      .from(routines)
      .where(eq(routines.id, routineId))
      .limit(1);

    const r = rows[0];
    if (!r || !r.enabled) return;
    this.arm({
      id: r.id,
      name: r.name,
      cronExpr: r.cronExpr,
      tz: r.tz,
      lastRunAt: r.lastRunAt,
      enabled: r.enabled,
    });
  }

  // ──────────────────────────────────────────────────────────────────────
  // internals
  // ──────────────────────────────────────────────────────────────────────

  private async loadEnabledRoutines(): Promise<ScheduledRoutine[]> {
    const rows = await db
      .select({
        id: routines.id,
        name: routines.name,
        cronExpr: routines.cronExpr,
        tz: routines.tz,
        lastRunAt: routines.lastRunAt,
        enabled: routines.enabled,
      })
      .from(routines)
      .where(eq(routines.enabled, true));
    return rows;
  }

  private arm(r: ScheduledRoutine): void {
    try {
      const job = new Cron(
        r.cronExpr,
        {
          timezone: r.tz,
          // `protect: true` makes croner skip a tick if the previous one is
          // still running — important because our run is async and can
          // outlive the cron interval on slow LLM calls.
          protect: true,
          catch: (err) => logError(`cron error for routine ${r.id} (${r.name}):`, err),
        },
        () => {
          runRoutineById(r.id).catch((err) =>
            logError(`runRoutineById threw for routine ${r.id}:`, err),
          );
        },
      );
      this.jobs.set(r.id, job);
      log(`armed routine ${r.id} (${r.name}) cron='${r.cronExpr}' tz=${r.tz}`);
    } catch (err) {
      logError(`failed to arm routine ${r.id} (${r.name}):`, err);
    }
  }

  private async catchUpRoutine(r: ScheduledRoutine, now: Date): Promise<void> {
    // No last_run_at → treat as "no missed fires" (fresh routine, just arm).
    if (!r.lastRunAt) return;

    const missed = enumerateMissedFires(r.cronExpr, r.tz, r.lastRunAt, now);
    if (missed.length === 0) return;

    const { runToday, skip } = computeCatchupBatch(missed, r.tz, now);
    if (skip.length > 0) {
      log(`routine ${r.id} (${r.name}): skipping ${skip.length} cross-day/over-cap fires`);
    }
    if (runToday.length === 0) return;

    log(`routine ${r.id} (${r.name}): catching up ${runToday.length} same-day fires`);

    // Sequential execution with exponential-style backoff between fires.
    // First fire goes immediately; subsequent fires wait 15s / 45s / 2m.
    for (let i = 0; i < runToday.length; i++) {
      if (i > 0) {
        const delay = CATCHUP_BACKOFF_MS[Math.min(i - 1, CATCHUP_BACKOFF_MS.length - 1)];
        await sleep(delay);
      }
      try {
        await runRoutineById(r.id);
      } catch (err) {
        logError(`catch-up fire ${i + 1}/${runToday.length} failed for routine ${r.id}:`, err);
        // Per the plan, 429/5xx-style errors must NOT be marked
        // completed-failed in a way that prevents retry. runRoutineOnce
        // already records 'failed' on the run row; we just stop the
        // catch-up chain here so the next reboot can resume.
        break;
      }
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms));
}

declare global {
  // eslint-disable-next-line no-var
  var __aistockScheduler: Scheduler | undefined;
}

/**
 * Get the process-wide singleton scheduler. Survives Next.js HMR because
 * `globalThis` is preserved across module re-evaluation.
 */
export function getScheduler(): Scheduler {
  if (!globalThis.__aistockScheduler) {
    globalThis.__aistockScheduler = new Scheduler();
  }
  return globalThis.__aistockScheduler;
}

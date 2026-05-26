import 'server-only';
import { eq } from 'drizzle-orm';
import { streamText, type ModelMessage } from 'ai';

import { db } from '../db/client';
import { routineRuns, routines, users } from '../db/schema';

import { PROVIDERS, type Provider } from '../llm/providers';
import { loadApiKey } from '../llm/keys';
import { listModels } from '../llm/models';
import { clientFor } from '../llm/clientFor';

// CRITICAL — DO NOT static-import `../mcp/tools` here.
// The mcp/tools barrel re-exports createRoutine, which (transitively, via
// lib/scheduler/index → runner → THIS FILE) would circle back to the barrel
// while createRoutine.ts is still mid-init. Result on Vercel's prod webpack
// minified bundle: `ReferenceError: Cannot access 'm' before initialization
// at Module.createRoutine` — surfacing as /api/chat returning empty-body 500
// for every request, because the chat route's lazy-tool loader transitively
// hits this barrel.
//
// Lazy-import TOOLS inside runRoutineOnce instead. Scheduler is a privileged
// cron caller — a small extra await at run-time has zero observable cost.
import { toAiSdkTool } from '../mcp/adapters/aiSdk';
import type { ToolHandler } from '../mcp/types';

import { meter } from '../cost/meter';
import { addSpend, checkBudgetOrThrow } from '../cost/ledger';
import { getProviderDailyCap } from '../cost/limits';
import { scrubSecrets, sanitizeError } from '../security/scrub';

import { CronExpressionParser } from 'cron-parser';
import { cleanupExpiredGuestData } from '../auth/guest-cleanup';

/**
 * A routine row loaded from the DB, narrowed to what runRoutineOnce needs.
 * Kept loose to avoid coupling to the full Drizzle row type.
 */
export interface RoutineForRun {
  id: number;
  name: string;
  prompt: string;
  model: string;
  fallbackModels: string[];
  maxUsdPerRun: string | number;
  tz: string;
  /**
   * Role of the routine's owner. Used to bypass the per-provider DAILY cap
   * for admin-owned routines (same rule as the chat route: admins set their
   * own caps, so a global ceiling shouldn't preempt them).
   * Null when the routine pre-dates the user_id column (orphan).
   */
  ownerRole?: 'admin' | 'user' | 'guest' | null;
}

// Heuristic token estimate: 1 token ~= 4 chars. Matches the cap used at the
// chat-route layer for pre-flight budgeting.
const CHARS_PER_TOKEN = 4;
const PLANNED_TOKENS_OUT = 4000;
const MAX_TOOL_STEPS = 8;

/** Errors we treat as "transient, try the next fallback model". */
function isRetryable(err: unknown): boolean {
  const e = err as { status?: number; code?: string; name?: string; message?: string } | null;
  if (!e || typeof e !== 'object') return false;
  if (typeof e.status === 'number' && (e.status === 429 || e.status >= 500)) return true;
  const code = (e.code ?? '').toString().toLowerCase();
  if (code.includes('timeout') || code === 'etimedout' || code === 'econnreset') return true;
  if ((e.name ?? '').toLowerCase().includes('timeout')) return true;
  const msg = (e.message ?? '').toLowerCase();
  if (msg.includes('timeout') || msg.includes('socket hang up')) return true;
  return false;
}

/** Budget-exceeded errors must abort the whole run, not trigger a fallback. */
function isBudgetExceeded(err: unknown): boolean {
  const e = err as { code?: string } | null;
  return !!e && typeof e === 'object' && e.code === 'budget_exceeded';
}

/**
 * Look up which provider owns a given model id.
 *
 * Order:
 *   1. Static `models.json` registry (covers the hardcoded fallback list).
 *   2. Each provider's `listModels()` lazily (uses the Postgres cache + a live
 *      `/v1/models` fetch when an API key is saved). Stops at the first hit.
 *
 * Returns `null` if nothing matches — caller fails the run with
 * `"model X not registered"`.
 */
async function resolveProvider(modelId: string): Promise<Provider | null> {
  // 1) Static registry — dynamic import so we don't pin pricing into the bundle
  //    if/when this is split out.
  // NOTE: do NOT use `{ with: { type: 'json' } }` — Vercel's bundler
  // silently drops the route bundle when that ES2025 attribute is present.
  // Plain dynamic import works everywhere.
  const mod = (await import('../llm/models.json')) as unknown as {
    default: Record<string, { models: Array<{ id: string }> }>;
  };
  const registry = mod.default;
  for (const provider of PROVIDERS) {
    const entry = registry[provider];
    if (entry?.models?.some((m) => m.id === modelId)) return provider;
  }

  // 2) Lazy per-provider live lookup. Only providers with a saved key will
  //    return anything beyond the static list, so failures here are silent.
  for (const provider of PROVIDERS) {
    try {
      const models = await listModels(provider);
      if (models.some((m) => m.id === modelId)) return provider;
    } catch {
      // listModels is already tolerant; ignore and try the next provider.
    }
  }
  return null;
}

interface AttemptOutcome {
  modelId: string;
  provider: Provider | null;
  ok: boolean;
  /** Sanitized error code/message for the failure report. */
  error?: string;
  text?: string;
  usdSpent?: number;
}

/**
 * Execute a routine exactly once, end-to-end:
 *   1. Insert a `routine_runs` row with status='running'.
 *   2. Resolve the primary model's provider, build the tool set, walk the
 *      fallback chain on retryable errors. Each attempt is pre-flight budget
 *      checked against `maxUsdPerRun`; budget rejection aborts the whole run.
 *   3. On the first success: scrub the output, meter actual usage, persist as
 *      `output_md` / `usd_spent`, `status='completed'`, update
 *      `routines.last_run_at` + `last_run_status='completed'`, charge the
 *      ledger via `addSpend` for that attempt only.
 *   4. If every attempt fails (no key / not retryable / all fallbacks exhausted)
 *      the run is marked 'failed' with a sanitized per-attempt error list as
 *      `output_md`. The function does NOT re-throw in this case — failure is
 *      already a terminal state for this run.
 *   5. Budget-exceeded and "model not registered" abort the run too, again
 *      without re-throwing.
 *
 * Any *unexpected* throw (e.g. DB failure) is re-raised after marking the run
 * 'failed' so the caller (scheduler / catch-up loop) can apply backoff.
 */
export async function runRoutineOnce(routine: RoutineForRun): Promise<void> {
  const [run] = await db
    .insert(routineRuns)
    .values({
      routineId: routine.id,
      status: 'running',
    })
    .returning({ id: routineRuns.id });

  try {
    // Two separate constraints, each with its own meaning:
    //   - `perRunCapUsd` is the routine OWNER's self-imposed per-run cost
    //     ceiling. NOT a daily cap. We enforce it inline against the
    //     planned cost of THIS run only.
    //   - `dailyCapUsd` is the env-driven global per-provider daily ceiling,
    //     compared against the budget ledger. Admins bypass via opts.isAdmin.
    // Previously these were conflated and `maxUsdPerRun` was passed to
    // checkBudgetOrThrow, which meant the daily ledger filling past the
    // per-run cap caused EVERY routine to fail — that bug is gone now.
    const perRunCapUsd = Number(routine.maxUsdPerRun) || 0;
    const ownerIsAdmin = routine.ownerRole === 'admin';
    // Lazy-load TOOLS to break the static import cycle through
    // mcp/tools/index → createRoutine → @/lib/scheduler. See top-of-file
    // comment for the full chain. The await here is a no-op after the
    // first call (Node's module cache resolves it instantly).
    const { TOOLS } = (await import('../mcp/tools')) as {
      TOOLS: Array<ToolHandler<unknown, unknown>>;
    };
    const tools = Object.fromEntries(TOOLS.map((t) => [t.name, toAiSdkTool(t)]));
    const messages: ModelMessage[] = [{ role: 'user', content: routine.prompt }];
    const tokensInEst = Math.ceil(routine.prompt.length / CHARS_PER_TOKEN);

    // Resolve provider from the primary model first; that's also the provider
    // we *assume* fallback models belong to unless they resolve elsewhere.
    const primaryProvider = await resolveProvider(routine.model);
    if (!primaryProvider) {
      await failRun(run.id, routine.id, `model ${routine.model} not registered`);
      return;
    }

    const candidates: string[] = [routine.model, ...(routine.fallbackModels ?? [])];
    const attempts: AttemptOutcome[] = [];
    let success: AttemptOutcome | null = null;

    for (const modelId of candidates) {
      const provider =
        modelId === routine.model ? primaryProvider : await resolveProvider(modelId);

      if (!provider) {
        attempts.push({
          modelId,
          provider: null,
          ok: false,
          error: `model ${modelId} not registered`,
        });
        continue;
      }

      const apiKey = await loadApiKey(provider);
      if (!apiKey) {
        attempts.push({
          modelId,
          provider,
          ok: false,
          error: 'no key for provider',
        });
        continue;
      }

      // Pre-flight budget gate. Use the meter to translate token estimates into
      // USD against this specific model's pricing.
      const plannedUsd = meter({
        provider,
        modelId,
        tokensIn: tokensInEst,
        tokensOut: PLANNED_TOKENS_OUT,
      });

      // Per-run cap (owner-set on the routine). Independent of the daily
      // ledger — even an admin should respect their own per-run cap since
      // they set it themselves. No bypass here.
      if (perRunCapUsd > 0 && plannedUsd > perRunCapUsd) {
        const err = new Error(
          `per-run budget exceeded for ${provider}/${modelId}: ` +
            `$${plannedUsd.toFixed(4)} planned > $${perRunCapUsd.toFixed(2)} max_usd_per_run`,
        ) as Error & { status?: number; code?: string };
        err.status = 429;
        err.code = 'budget_exceeded';
        const detail = sanitizeError(err);
        await failRun(
          run.id,
          routine.id,
          `per-run budget exceeded: ${detail.message}`,
        );
        return;
      }

      try {
        await checkBudgetOrThrow(provider, plannedUsd, getProviderDailyCap(provider), {
          isAdmin: ownerIsAdmin,
        });
      } catch (err) {
        if (isBudgetExceeded(err)) {
          // Budget is a global concern — do not fall back to a cheaper model
          // silently, because the cap was set deliberately. Fail the run.
          const detail = sanitizeError(err);
          await failRun(
            run.id,
            routine.id,
            `budget exceeded: ${detail.message}`,
          );
          return;
        }
        throw err;
      }

      try {
        const model = await clientFor(provider, modelId, apiKey);
        const result = streamText({
          model,
          messages,
          tools,
          stopWhen: ({ steps }: { steps: unknown[] }) => steps.length >= MAX_TOOL_STEPS,
        });

        // AI SDK v6 exposes the final assembled text and usage as promises on
        // the StreamTextResult. Awaiting them drives the stream to completion.
        const text = await result.text;
        const usage = await result.usage;

        const tokensIn =
          (usage as { inputTokens?: number; promptTokens?: number } | undefined)?.inputTokens ??
          (usage as { promptTokens?: number } | undefined)?.promptTokens ??
          0;
        const tokensOut =
          (usage as { outputTokens?: number; completionTokens?: number } | undefined)
            ?.outputTokens ??
          (usage as { completionTokens?: number } | undefined)?.completionTokens ??
          0;
        const usdSpent = meter({ provider, modelId, tokensIn, tokensOut });

        success = { modelId, provider, ok: true, text, usdSpent };
        attempts.push(success);
        break;
      } catch (err) {
        const detail = sanitizeError(err);
        const label = detail.code ?? (detail.status ? `http_${detail.status}` : 'error');
        attempts.push({
          modelId,
          provider,
          ok: false,
          error: `${label}: ${detail.message}`,
        });
        if (!isRetryable(err)) {
          // Non-retryable (auth, invalid request, etc.) — still walk the chain,
          // since a different provider might just work. The error is recorded
          // either way. This matches the spirit of "try each fallback".
          continue;
        }
        // Retryable → loop continues to the next fallback.
      }
    }

    const finishedAt = new Date();
    if (success) {
      const outputMd = scrubSecrets(success.text ?? '') as string;
      const usd = success.usdSpent ?? 0;

      await db
        .update(routineRuns)
        .set({
          status: 'completed',
          outputMd,
          usdSpent: usd.toFixed(4),
          finishedAt,
        })
        .where(eq(routineRuns.id, run.id));

      await db
        .update(routines)
        .set({
          lastRunAt: finishedAt,
          lastRunStatus: 'completed',
        })
        .where(eq(routines.id, routine.id));

      // Charge only the successful attempt — pre-flight failures and retryable
      // errors didn't actually consume budget on the provider side.
      if (success.provider) {
        await addSpend(success.provider, usd);
      }

      // PUSH_HOOK_INSERT — call notifyRoutineDone(routine, outputMd) here when wiring lands
      // (import from '../push/notify'). Must be awaited and any thrown error swallowed
      // so push misconfiguration (missing VAPID env) never marks the run failed.
      return;
    }

    // All attempts exhausted.
    const summary = attempts
      .map((a, i) => `- attempt ${i + 1} (${a.provider ?? '?'}/${a.modelId}): ${a.error ?? 'unknown'}`)
      .join('\n');
    const outputMd = `All ${attempts.length} attempts failed.\n\n${summary}`;
    await failRun(run.id, routine.id, outputMd, finishedAt);
  } catch (err) {
    // Unexpected throw (DB error, programmer mistake). Mark failed + re-raise
    // so the scheduler can apply backoff.
    const finishedAt = new Date();
    const detail = sanitizeError(err);
    await db
      .update(routineRuns)
      .set({
        status: 'failed',
        outputMd: detail.message,
        finishedAt,
      })
      .where(eq(routineRuns.id, run.id));
    await db
      .update(routines)
      .set({
        lastRunAt: finishedAt,
        lastRunStatus: 'failed',
      })
      .where(eq(routines.id, routine.id));
    throw err;
  }
}

// ──────────────────────────────────────────────────────────────────────
// Serverless tick entry points (used by /api/cron/tick on Vercel).
// These functions are stateless and re-entrant: every invocation re-queries
// the DB, so they are safe to call from a short-lived request handler that
// dies seconds later.
// ──────────────────────────────────────────────────────────────────────

/**
 * Shape returned by `runDueRoutines` so the cron tick endpoint can surface
 * counts to logs / monitoring without exposing routine internals.
 */
export interface DueTickResult {
  /** Number of routines that were due and executed during this tick. */
  ranRoutines: number;
  /** Routine ids that ran (handy when debugging from the response body). */
  ranRoutineIds: number[];
  /** Number of routines considered but skipped (not yet due / disabled mid-tick). */
  skippedRoutines: number;
  /** Guest accounts whose data was reset during this tick. */
  cleanedGuests: number;
  /** Total rows wiped during guest cleanup (chats, portfolios, keys, …). */
  cleanedGuestRows: number;
}

/**
 * Compute the next scheduled fire for a routine, given its cron + tz + last
 * fire. We treat `lastRunAt` as the "base"; if it's null (never run) we use
 * `now` so the very first tick after creation only fires when the cron's
 * normal next time arrives — i.e. we do NOT backfill the moment a routine
 * is created.
 *
 * Returns `null` if the cron expression is invalid (caller skips the routine).
 */
function nextFireAfter(
  cronExpr: string,
  tz: string,
  base: Date,
): Date | null {
  try {
    const iter = CronExpressionParser.parse(cronExpr, {
      currentDate: base,
      tz,
    });
    return iter.next().toDate();
  } catch {
    return null;
  }
}

/**
 * Per-tick entry point for serverless cron (Vercel Cron Jobs hitting
 * `/api/cron/tick`). Loads every enabled routine, runs the ones whose next
 * scheduled fire (from `lastRunAt` + `cronExpr` + `tz`) is at or before
 * `now`, and also runs the cheap-idempotent guest-data cleanup sweep.
 *
 * SECURITY NOTE: this function is a *privileged system caller* — the cron
 * tick endpoint is the system, not a user, so it deliberately iterates ALL
 * enabled routines regardless of `routines.user_id`. Do NOT add a user-id
 * filter here; the per-user gating happens at the HTTP route layer
 * (`/api/routines/*` filter by session user, `create_routine` MCP tool
 * requires `ctx.userId`). `routines.user_id` is nullable in the schema for
 * backfill safety on pre-multitenant orphan rows; orphans still execute
 * here because the cron treats them as system routines, but they're
 * invisible to every user route and so cannot be edited, listed, or
 * deleted from the UI.
 *
 * Design notes:
 *   - Each routine that's due is executed sequentially in chronological order
 *     of its earliest due fire. This bounds tail latency of a single tick on
 *     a free serverless function (default 10s / max 60s on Vercel Hobby).
 *   - We only fire ONCE per routine per tick — if 3 fires were missed, the
 *     scheduler ran them sequentially in the in-process implementation but
 *     on serverless that risks blowing the function timeout. The next tick
 *     5 minutes later will catch the next missed fire, and so on. For typical
 *     daily / hourly routines this is indistinguishable from real-time.
 *   - We swallow per-routine errors (logged) so a single bad routine cannot
 *     poison the rest of the tick — `runRoutineOnce` already persists 'failed'
 *     state on the run row.
 *   - Guest cleanup runs every tick because the query is indexed by
 *     `expires_at` and returns 0 rows in the common case. Cheap, idempotent.
 */
export async function runDueRoutines(
  now: Date = new Date(),
): Promise<DueTickResult> {
  const enabled = await db
    .select({
      id: routines.id,
      name: routines.name,
      prompt: routines.prompt,
      model: routines.model,
      fallbackModels: routines.fallbackModels,
      maxUsdPerRun: routines.maxUsdPerRun,
      cronExpr: routines.cronExpr,
      tz: routines.tz,
      lastRunAt: routines.lastRunAt,
      // Left-joined so admin-owned routines can bypass the per-provider
      // DAILY cap (see RoutineForRun.ownerRole). Orphan rows (user_id IS
      // NULL, pre-multitenant) get null → behave like a normal user.
      ownerRole: users.role,
    })
    .from(routines)
    .leftJoin(users, eq(routines.userId, users.id))
    .where(eq(routines.enabled, true));

  // Bucket into "due now" vs "future". `lastRunAt` null means the routine
  // has never fired; we still want it to fire if its cron's next-from-creation
  // is now-or-past, so we base it on `routines.createdAt` would be ideal, but
  // we don't carry that field here. Using `epoch 0` as the base would cause
  // a brand-new "0 8 * * *" routine created at 09:00 to immediately fire
  // (because 08:00 today is past). To avoid that surprise we treat null
  // `lastRunAt` as "schedule from now" — the first real fire will be the
  // next 08:00 after creation.
  const due: typeof enabled = [];
  for (const r of enabled) {
    const base = r.lastRunAt ?? now;
    const next = nextFireAfter(r.cronExpr, r.tz, base);
    if (!next) continue; // invalid cron — skip silently
    if (next <= now) due.push(r);
  }

  // Oldest-due first so a routine that's been waiting longer doesn't get
  // starved by one created later.
  due.sort((a, b) => {
    const ax = (a.lastRunAt ?? new Date(0)).getTime();
    const bx = (b.lastRunAt ?? new Date(0)).getTime();
    return ax - bx;
  });

  const ranRoutineIds: number[] = [];
  for (const r of due) {
    try {
      await runRoutineOnce({
        id: r.id,
        name: r.name,
        prompt: r.prompt,
        model: r.model,
        fallbackModels: r.fallbackModels ?? [],
        maxUsdPerRun: r.maxUsdPerRun,
        tz: r.tz,
        ownerRole: r.ownerRole ?? null,
      });
      ranRoutineIds.push(r.id);
    } catch (err) {
      // runRoutineOnce already marked the run failed; just log here.
      // eslint-disable-next-line no-console
      console.error(`[cron-tick] routine ${r.id} threw:`, err);
    }
  }

  // Guest cleanup: idempotent and cheap (indexed SELECT, 0 rows in steady
  // state). Run every tick instead of gating on a 24h heuristic — the gate
  // would require a `system_kv` round trip anyway, and module-level state
  // does not persist between serverless invocations.
  let cleanedGuests = 0;
  let cleanedGuestRows = 0;
  try {
    const summary = await cleanupExpiredGuestData(now);
    cleanedGuests = summary.usersReset;
    cleanedGuestRows = summary.rowsDeleted;
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[cron-tick] guest cleanup failed:', err);
  }

  return {
    ranRoutines: ranRoutineIds.length,
    ranRoutineIds,
    skippedRoutines: enabled.length - ranRoutineIds.length,
    cleanedGuests,
    cleanedGuestRows,
  };
}

async function failRun(
  runId: number,
  routineId: number,
  outputMd: string,
  finishedAt: Date = new Date(),
): Promise<void> {
  await db
    .update(routineRuns)
    .set({
      status: 'failed',
      outputMd,
      finishedAt,
    })
    .where(eq(routineRuns.id, runId));
  await db
    .update(routines)
    .set({
      lastRunAt: finishedAt,
      lastRunStatus: 'failed',
    })
    .where(eq(routines.id, routineId));
}

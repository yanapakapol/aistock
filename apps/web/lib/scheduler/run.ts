import 'server-only';
import { eq } from 'drizzle-orm';
import { streamText, type ModelMessage } from 'ai';

import { db } from '../db/client';
import { routineRuns, routines } from '../db/schema';

import { PROVIDERS, type Provider } from '../llm/providers';
import { loadApiKey } from '../llm/keys';
import { listModels } from '../llm/models';
import { clientFor } from '../llm/clientFor';

import { TOOLS } from '../mcp/tools';
import { toAiSdkTool } from '../mcp/adapters/aiSdk';

import { meter } from '../cost/meter';
import { addSpend, checkBudgetOrThrow } from '../cost/ledger';
import { scrubSecrets, sanitizeError } from '../security/scrub';

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
  const mod = (await import('../llm/models.json', { with: { type: 'json' } })) as unknown as {
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
    const capUsd = Number(routine.maxUsdPerRun) || 0;
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
      try {
        await checkBudgetOrThrow(provider, plannedUsd, capUsd);
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
        const model = clientFor(provider, modelId, apiKey);
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

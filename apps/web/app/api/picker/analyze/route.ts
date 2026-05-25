import { type NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { and, eq } from 'drizzle-orm';
import { generateObject } from 'ai';

import { db } from '@/lib/db/client';
import { pickerJobs } from '@/lib/db/schema';

import { getCurrentUser } from '@/lib/auth/session';
import { sanitizeError } from '@/lib/security/scrub';
import { loadApiKey } from '@/lib/llm/keys';
import { clientFor } from '@/lib/llm/clientFor';
import type { Provider } from '@/lib/llm/providers';

// REUSE everything from the shared helper so the prompt / schema / provider
// chain are LITERALLY the same as the scan side — no duplication, no drift.
// The helper lives in lib/picker (NOT in a route module) because Next.js
// route files only allow specific named exports.
import {
  PROVIDER_CHAIN,
  PROVIDER_HOST,
  RISK_MIN_PROTECTION,
  ResultSchema,
  buildPickerPrompt,
  recordAudit,
  resolveMarketLabel,
  sseDone,
  sseFormat,
  type Article,
  type RiskTolerance,
  type SseEmitter,
  type StockCard,
  type StockType,
} from '@/lib/picker/shared';

export const runtime = 'nodejs';
// Hobby plan ceiling. This route runs the slow Mistral Medium generateObject
// call against the FULL article context the scan step saved — typically
// 30-50s. 55s watchdog below fires before Vercel's terse 504.
export const maxDuration = 60;
export const dynamic = 'force-dynamic';
export const revalidate = 0;

// ---------- Request body ----------

const AnalyzeBody = z.object({
  jobId: z.number().int().positive(),
});

// ---------- Row shape (params is jsonb so we have to assert) ----------

// What scan/route.ts writes into params. Underscored fields are the resolved
// market label and exchange whitelist — we store them so we don't have to
// re-run autoPickMarket (which is a billable LLM call) on this side.
interface JobParams {
  market?: string | null;
  customCountries?: string[];
  autoPickMarket?: boolean;
  sectors: string[];
  stockTypes?: StockType[];
  riskTolerance?: RiskTolerance;
  _primaryMarketLabel?: string;
  _allowedExchanges?: string[];
}

// ---------- Handler ----------

export async function POST(req: NextRequest) {
  let phase = 'init';

  try {
    const sfs = req.headers.get('sec-fetch-site');
    if (sfs && sfs !== 'same-origin' && sfs !== 'none') {
      return NextResponse.json({ error: 'cross-site blocked' }, { status: 403 });
    }

    phase = 'auth';
    const user = await getCurrentUser().catch(() => null);
    if (!user) {
      return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
    }

    phase = 'parse-body';
    const json = (await req.json().catch(() => null)) as unknown;
    const parsed = AnalyzeBody.safeParse(json);
    if (!parsed.success) {
      return NextResponse.json(
        { error: 'invalid request', issues: parsed.error.issues },
        { status: 400 },
      );
    }
    const { jobId } = parsed.data;
    const userId = user.id;

    // ---- Build SSE stream ----
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        let closed = false;
        const send = (chunk: string) => {
          if (closed) return;
          try {
            controller.enqueue(encoder.encode(chunk));
          } catch {
            /* controller already torn down */
          }
        };
        const emitter: SseEmitter = {
          phase: (name, detail, extra) =>
            send(sseFormat('phase', { name, detail, ...(extra ?? {}) })),
          result: (data) => send(sseFormat('result', data)),
          error: (message, errPhase, kind) =>
            send(sseFormat('error', { message, phase: errPhase, kind })),
          end: () => {
            if (closed) return;
            send(sseDone());
            closed = true;
            try {
              controller.close();
            } catch {
              /* ignore */
            }
          },
        };

        // Watchdog: same 55s pattern as scan. If we trip it, the articles
        // are still on the picker_jobs row, so the client can retry POST
        // /api/picker/analyze with the same jobId — no Tavily re-spend.
        const WATCHDOG_MS = 55_000;
        let watchdog: ReturnType<typeof setTimeout> | null = null;
        const timeoutPromise = new Promise<'timeout'>((resolve) => {
          watchdog = setTimeout(() => resolve('timeout'), WATCHDOG_MS);
        });
        try {
          const result = await Promise.race([
            runAnalyze({ jobId, userId, emitter }).then(() => 'done' as const),
            timeoutPromise,
          ]);
          if (result === 'timeout') {
            console.error(`[picker/analyze] watchdog 55s fired in phase=${phase}`);
            // Mark the job so the client knows it's resumable.
            await markJobError(
              jobId,
              userId,
              'analyzing timed out (>55s) — articles preserved; retry POST /api/picker/analyze with the same jobId',
            ).catch(() => undefined);
            emitter.error(
              'Analysis took too long (>55s). Articles are saved — click "Retry analysis" to resume on the same job (no Tavily re-spend).',
              phase,
              'watchdog_timeout',
            );
          }
        } catch (err) {
          const msg =
            err instanceof Error
              ? err.message || err.name || 'unknown error'
              : typeof err === 'string'
                ? err
                : 'unknown error';
          console.error(`[picker/analyze] uncaught in phase=${phase}: ${msg}`);
          await markJobError(jobId, userId, msg).catch(() => undefined);
          emitter.error(msg, phase, 'server_exception');
        } finally {
          if (watchdog) clearTimeout(watchdog);
          emitter.end();
        }
      },
      cancel() {
        /* client disconnect — no cleanup required */
      },
    });

    return new Response(stream, {
      status: 200,
      headers: {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
      },
    });
  } catch (err) {
    let message = 'unknown error';
    if (err instanceof Error) message = err.message || err.name || 'unknown error';
    else if (typeof err === 'string') message = err;
    console.error(`[picker/analyze] uncaught pre-stream in phase=${phase}: ${message}`);
    return new NextResponse(
      JSON.stringify({ error: message, phase, kind: 'server_exception' }),
      {
        status: 500,
        headers: { 'content-type': 'application/json; charset=utf-8' },
      },
    );
  }

  // ---- Inner pipeline ----
  async function runAnalyze(args: {
    jobId: number;
    userId: number;
    emitter: SseEmitter;
  }): Promise<void> {
    const { jobId, userId, emitter } = args;

    // ---- Load + ownership-check the job ----
    phase = 'load-job';
    emitter.phase('load-job', `Loading job #${jobId} from storage...`);
    const rows = await db
      .select()
      .from(pickerJobs)
      .where(and(eq(pickerJobs.id, jobId), eq(pickerJobs.userId, userId)))
      .limit(1);
    const job = rows[0];
    if (!job) {
      emitter.error(
        `Job #${jobId} not found (or not yours). Re-run the scan.`,
        'load-job',
        'job_not_found',
      );
      return;
    }

    // Already done? Return the cached cards — no second LLM spend.
    if (job.status === 'done' && job.cards && job.sources) {
      emitter.phase('cache-hit', `Job already analyzed; returning cached cards.`);
      emitter.result({
        cards: job.cards as StockCard[],
        sources: job.sources as string[],
      });
      return;
    }

    const articles = (job.articles ?? []) as Article[];
    if (!Array.isArray(articles) || articles.length === 0) {
      emitter.error(
        'No articles on this job. Re-run the scan to repopulate.',
        'load-job',
        'no_articles',
      );
      return;
    }

    const params = (job.params ?? {}) as JobParams;
    const sectors = params.sectors ?? [];
    if (sectors.length === 0) {
      emitter.error(
        'Job params missing sectors. Re-run the scan.',
        'load-job',
        'bad_params',
      );
      return;
    }
    const stockTypes: StockType[] = params.stockTypes ?? [];
    const riskTolerance: RiskTolerance = params.riskTolerance ?? 'medium';
    const minRiskProtection = RISK_MIN_PROTECTION[riskTolerance];

    // Prefer the resolved fields scan stored; fall back to deriving from
    // the user's raw inputs if they're somehow missing (older rows).
    const primaryMarketLabel =
      params._primaryMarketLabel ??
      (params.market
        ? resolveMarketLabel(params.market).label
        : (params.customCountries?.join(', ') ?? 'global markets'));
    const allowedExchanges = params._allowedExchanges ?? [];

    // ---- Mark the row analyzing so polling via /api/picker/job/:id sees it ----
    await db
      .update(pickerJobs)
      .set({ status: 'analyzing', updatedAt: new Date(), error: null })
      .where(eq(pickerJobs.id, jobId))
      .catch((err) => {
        console.error('[picker/analyze] status update failed:', sanitizeError(err));
      });

    // ---- Load LLM keys (parallel) ----
    phase = 'discover-keys';
    const [mistralKey, openaiKey, anthropicKey] = await Promise.all([
      loadApiKey('mistral').catch(() => null),
      loadApiKey('openai').catch(() => null),
      loadApiKey('anthropic').catch(() => null),
    ]);
    const keyByProvider: Record<Provider, string | null> = {
      mistral: mistralKey,
      openai: openaiKey,
      anthropic: anthropicKey,
      google: null,
      moonshot: null,
      deepseek: null,
    };

    // ---- Build prompt (shared helper — identical wording to the old
    //      single-shot scan route, so quality regressions are impossible) ----
    phase = 'build-prompt';
    const { systemPrompt, userPrompt } = buildPickerPrompt({
      articles,
      sectors,
      stockTypes,
      riskTolerance,
      primaryMarketLabel,
      allowedExchanges,
    });

    // ---- LLM with provider fallback ----
    phase = 'llm';
    emitter.phase(
      'llm-start',
      `Analyzing ${articles.length} articles with Mistral Medium...`,
      { articleCount: articles.length },
    );

    const articleUrlSet = new Set(articles.map((a) => a.url.toLowerCase()));
    let lastErr: unknown = null;

    for (const attempt of PROVIDER_CHAIN) {
      const key = keyByProvider[attempt.provider];
      if (!key) continue;

      emitter.phase(
        'llm-streaming',
        `Calling ${attempt.provider} (${attempt.modelId})...`,
        { provider: attempt.provider, model: attempt.modelId },
      );

      const llmStart = Date.now();
      try {
        const model = await clientFor(attempt.provider, attempt.modelId, key);
        const { object } = await generateObject({
          model,
          schema: ResultSchema,
          system: systemPrompt,
          prompt: userPrompt,
        });

        recordAudit(
          `picker.analyze.${attempt.provider}`,
          PROVIDER_HOST[attempt.provider],
          200,
          Date.now() - llmStart,
        ).catch(() => undefined);

        // ---- Post-LLM validation (same rules as the old scan route) ----
        const filtered: StockCard[] = [];
        for (const card of object.cards) {
          const cleanSources = card.sources.filter((u) =>
            articleUrlSet.has(u.toLowerCase()),
          );
          if (cleanSources.length === 0) {
            console.warn(
              `[picker/analyze] dropping ${card.symbol}: all sources outside article list`,
            );
            continue;
          }
          if (card.riskProtection < minRiskProtection) continue;
          filtered.push({ ...card, sources: cleanSources });
        }

        if (filtered.length === 0) {
          await markJobError(
            jobId,
            userId,
            'model returned cards but all were filtered by evidence + risk-tolerance gates',
          ).catch(() => undefined);
          emitter.error(
            'The model returned cards but none passed evidence + risk-tolerance filters. Try a broader risk tolerance or different sectors.',
            'llm',
            'all_cards_filtered',
          );
          return;
        }

        const sources = Array.from(new Set(articles.map((a) => a.url))).slice(0, 20);

        // ---- Persist + emit done event ----
        emitter.phase('llm-done', `Got ${filtered.length} cards back.`, {
          cardCount: filtered.length,
        });
        await db
          .update(pickerJobs)
          .set({
            status: 'done',
            cards: filtered,
            sources,
            error: null,
            updatedAt: new Date(),
          })
          .where(eq(pickerJobs.id, jobId))
          .catch((err) => {
            // DB write failure shouldn't lose the user's result — emit
            // anyway. They lose the "resume" capability for this job but
            // the cards are in their hands.
            console.error(
              '[picker/analyze] result persist failed:',
              sanitizeError(err),
            );
          });

        emitter.result({ cards: filtered, sources });
        return;
      } catch (err) {
        const status =
          (err as { status?: number; statusCode?: number })?.status ??
          (err as { statusCode?: number })?.statusCode ??
          500;
        lastErr = err;
        recordAudit(
          `picker.analyze.${attempt.provider}`,
          PROVIDER_HOST[attempt.provider],
          status,
          Date.now() - llmStart,
        ).catch(() => undefined);
        console.error(
          `[picker/analyze] ${attempt.provider}/${attempt.modelId} failed:`,
          sanitizeError(err),
        );
        emitter.phase(
          'llm-streaming',
          `${attempt.provider} failed (HTTP ${status}); trying next provider...`,
          { provider: attempt.provider, status },
        );
        continue;
      }
    }

    // No provider had a key OR every attempt threw.
    if (!lastErr) {
      await markJobError(jobId, userId, 'no LLM key configured').catch(() => undefined);
      emitter.error(
        'No LLM key configured. Add a Mistral, OpenAI, or Anthropic key in Settings → LLM API keys.',
        'llm',
        'no_llm_key',
      );
      return;
    }
    const msg = sanitizeError(lastErr).message;
    await markJobError(jobId, userId, msg).catch(() => undefined);
    emitter.error(msg, 'llm', 'llm_failed');
  }
}

// Helper — best-effort write of an error message to the job row so
// /api/picker/job/:id surfaces it to the client even when the SSE stream
// has already torn down (e.g. mid-watchdog timeout the client navigated
// away from).
async function markJobError(
  jobId: number,
  userId: number,
  message: string,
): Promise<void> {
  await db
    .update(pickerJobs)
    .set({
      status: 'failed',
      error: message.slice(0, 1000),
      updatedAt: new Date(),
    })
    .where(and(eq(pickerJobs.id, jobId), eq(pickerJobs.userId, userId)));
}

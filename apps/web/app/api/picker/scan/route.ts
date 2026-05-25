import { type NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { generateObject } from 'ai';

import { db } from '@/lib/db/client';
import { pickerJobs, NEWS_PROVIDERS } from '@/lib/db/schema';

import { getCurrentUser } from '@/lib/auth/session';
import { sanitizeError } from '@/lib/security/scrub';
import { loadApiKey } from '@/lib/llm/keys';
import { clientFor } from '@/lib/llm/clientFor';
import type { Provider } from '@/lib/llm/providers';

import { searchNewsViaTavily, type TavilyResult } from '@/lib/news/tavily';
import { loadNewsKey } from '@/lib/news/keys';

import {
  BodySchema,
  PROVIDER_CHAIN,
  PROVIDER_HOST,
  buildQueries,
  recordAudit,
  resolveMarketLabel,
  sseDone,
  sseFormat,
  type Article,
  type PickerScanBody,
  type SseEmitter,
} from '@/lib/picker/shared';

export const runtime = 'nodejs';
// Hobby plan ceiling. The split-job design moves the slow LLM call to
// /api/picker/analyze so this side now only does Tavily fan-out + a DB
// insert — typically <15s. The 60s budget + 55s watchdog stay as
// defense-in-depth against a nightly Tavily stall.
export const maxDuration = 60;
export const dynamic = 'force-dynamic';
export const revalidate = 0;

// ---------- Tavily fan-out ----------

interface QueryFanoutResult {
  query: string;
  ok: boolean;
  count: number;
}

async function runOneTavily(
  q: string,
): Promise<{ articles: Article[]; ok: boolean }> {
  try {
    const res = await searchNewsViaTavily(q, {
      topic: 'news',
      searchDepth: 'advanced',
      maxResults: 6,
      days: 60,
    });
    const articles = res.results.map(
      (r: TavilyResult): Article => ({
        url: r.url,
        title: r.title,
        // 1000-char excerpt — canonical store. Analyze reads this back and
        // feeds it straight into the prompt with no further truncation, so
        // we keep the FULL context the user asked for.
        content: (r.content ?? '').slice(0, 1000),
        publishedDate: r.publishedDate,
      }),
    );
    return { articles, ok: true };
  } catch (err) {
    console.error('[picker/scan] tavily query failed:', q, sanitizeError(err));
    return { articles: [], ok: false };
  }
}

function dedupeByUrl(articles: Article[], cap: number): Article[] {
  const seen = new Set<string>();
  const out: Article[] = [];
  for (const a of articles) {
    if (!a.url) continue;
    const key = a.url.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(a);
    if (out.length >= cap) break;
  }
  return out;
}

// ---------- Auto-pick market ----------

interface AutoMarketPick {
  markets: string[];
  reasoning?: string;
}

const AutoMarketSchema = z.object({
  markets: z
    .array(z.string().min(1).max(40))
    .min(1)
    .max(3)
    .describe(
      'Market codes (US, HK, CN, TH, JP, KR, UK, DE, FR, TW) or country names like "India", "Singapore".',
    ),
  reasoning: z.string().min(10).max(400).describe('Brief macro/sector rationale.'),
});

async function autoPickMarkets(
  keyByProvider: Record<Provider, string | null>,
): Promise<AutoMarketPick | null> {
  for (const attempt of PROVIDER_CHAIN) {
    const key = keyByProvider[attempt.provider];
    if (!key) continue;
    const t0 = Date.now();
    try {
      const model = await clientFor(attempt.provider, attempt.modelId, key);
      const { object } = await generateObject({
        model,
        schema: AutoMarketSchema,
        system:
          'You are a global macro strategist. Reply ONLY with the requested JSON shape. Be specific and concise.',
        prompt:
          'Given current 2026 macro conditions, which 2 stock markets globally are most likely to see broad-based booms in the next 6 months? ' +
          'Reply with a JSON array of market codes (US, HK, CN, TH, JP, KR, UK, DE, FR, TW, or country names like "India", "Singapore"). ' +
          'Be specific and cite reasoning briefly.',
      });
      recordAudit(
        `picker.scan.auto.${attempt.provider}`,
        PROVIDER_HOST[attempt.provider],
        200,
        Date.now() - t0,
      ).catch(() => undefined);
      return object;
    } catch (err) {
      const status =
        (err as { status?: number; statusCode?: number })?.status ??
        (err as { statusCode?: number })?.statusCode ??
        500;
      recordAudit(
        `picker.scan.auto.${attempt.provider}`,
        PROVIDER_HOST[attempt.provider],
        status,
        Date.now() - t0,
      ).catch(() => undefined);
      console.error(
        `[picker/scan] auto-pick ${attempt.provider} failed:`,
        sanitizeError(err),
      );
      continue;
    }
  }
  return null;
}

// ---------- Handler ----------

export async function POST(req: NextRequest) {
  // Phase is tracked outside the stream so the top-level catch can report it.
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
    const parsed = BodySchema.safeParse(json);
    if (!parsed.success) {
      return NextResponse.json(
        { error: 'invalid request', issues: parsed.error.issues },
        { status: 400 },
      );
    }
    const body = parsed.data;
    const userId = user.id;

    // ---- Build the SSE stream ----
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

        // 55s watchdog — kept as defense-in-depth even though this side
        // is now fast (~10-15s). If a Tavily night spikes we still want a
        // structured error event rather than Vercel's terse 504.
        const WATCHDOG_MS = 55_000;
        let watchdog: ReturnType<typeof setTimeout> | null = null;
        const timeoutPromise = new Promise<'timeout'>((resolve) => {
          watchdog = setTimeout(() => resolve('timeout'), WATCHDOG_MS);
        });
        try {
          const result = await Promise.race([
            runScan({ body, userId, emitter }).then(() => 'done' as const),
            timeoutPromise,
          ]);
          if (result === 'timeout') {
            console.error(`[picker/scan] watchdog 55s fired in phase=${phase}`);
            emitter.error(
              'Search took too long (>55s). Try fewer custom countries, narrower sectors, or rerun — the Tavily nightly backlog sometimes spikes.',
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
          console.error(`[picker/scan] uncaught in phase=${phase}: ${msg}`);
          emitter.error(msg, phase, 'server_exception');
        } finally {
          if (watchdog) clearTimeout(watchdog);
          emitter.end();
        }
      },
      cancel() {
        /* client disconnected — no cleanup required */
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
    console.error(`[picker/scan] uncaught pre-stream in phase=${phase}: ${message}`);
    return new NextResponse(
      JSON.stringify({ error: message, phase, kind: 'server_exception' }),
      {
        status: 500,
        headers: { 'content-type': 'application/json; charset=utf-8' },
      },
    );
  }

  // ---- Inner async pipeline ----
  async function runScan(params: {
    body: PickerScanBody;
    userId: number;
    emitter: SseEmitter;
  }): Promise<void> {
    const { body, userId, emitter } = params;

    // ---- Discover provider keys (LLMs needed for autoPickMarket; news for Tavily) ----
    phase = 'discover-keys';
    emitter.phase('discover-keys', 'Loading API keys from the encrypted vault...');
    const [mistralKey, openaiKey, anthropicKey, tavilyKey, newsProviderKeys] =
      await Promise.all([
        loadApiKey('mistral').catch(() => null),
        loadApiKey('openai').catch(() => null),
        loadApiKey('anthropic').catch(() => null),
        loadNewsKey('tavily').catch(() => null),
        Promise.all(
          NEWS_PROVIDERS.map(async (p) => ({
            p,
            key: await loadNewsKey(p).catch(() => null),
          })),
        ),
      ]);

    const keyByProvider: Record<Provider, string | null> = {
      mistral: mistralKey,
      openai: openaiKey,
      anthropic: anthropicKey,
      google: null,
      moonshot: null,
      deepseek: null,
    };

    // ---- Resolve target markets ----
    phase = 'resolve-markets';
    const targets: Array<{ label: string; exchanges: string[] }> = [];

    if (body.autoPickMarket) {
      emitter.phase(
        'resolve-markets',
        'Asking the AI to pick the most likely booming markets...',
      );
      const picked = await autoPickMarkets(keyByProvider);
      if (!picked || picked.markets.length === 0) {
        const fallback =
          body.market ?? (body.customCountries?.[0] as string | undefined) ?? 'US';
        const resolved = resolveMarketLabel(fallback);
        targets.push(resolved);
        emitter.phase(
          'resolve-markets',
          `Auto-pick unavailable; falling back to ${resolved.label}.`,
          { markets: [resolved.label], autoPicked: false },
        );
      } else {
        for (const m of picked.markets.slice(0, 2)) {
          targets.push(resolveMarketLabel(m));
        }
        emitter.phase(
          'resolve-markets',
          `AI picked: ${targets.map((t) => t.label).join(', ')}.`,
          {
            markets: targets.map((t) => t.label),
            autoPicked: true,
            reasoning: picked.reasoning,
          },
        );
      }
    } else if (body.customCountries && body.customCountries.length > 0) {
      for (const c of body.customCountries.slice(0, 3)) {
        targets.push(resolveMarketLabel(c));
      }
      emitter.phase(
        'resolve-markets',
        `Scanning ${targets.map((t) => t.label).join(', ')}.`,
        { markets: targets.map((t) => t.label) },
      );
    } else if (body.market) {
      targets.push(resolveMarketLabel(body.market));
      emitter.phase(
        'resolve-markets',
        `Scanning ${targets[0]!.label}.`,
        { markets: [targets[0]!.label] },
      );
    }

    if (targets.length === 0) {
      emitter.error(
        'No market resolved. Pick a market, enter a country, or enable auto-pick.',
        'resolve-markets',
        'no_market',
      );
      return;
    }

    const primaryMarketLabel = targets.map((t) => t.label).join(' / ');
    const allowedExchanges = Array.from(
      new Set(targets.flatMap((t) => t.exchanges)),
    );

    // ---- Web search fan-out ----
    phase = 'tavily-search';
    const haveTavily = !!(tavilyKey || process.env.TAVILY_API_KEY);
    if (!haveTavily) {
      const configured = newsProviderKeys.filter((x) => x.key).map((x) => x.p);
      emitter.error(
        'No web-search provider configured. Add a Tavily key in Settings → News & data API keys. ' +
          (configured.length
            ? `(Configured: ${configured.join(', ')} — these are ticker-scoped, not open web search.)`
            : ''),
        'tavily-search',
        'no_search_key',
      );
      return;
    }

    const queries = buildQueries(primaryMarketLabel, body.sectors);
    emitter.phase(
      'search',
      `Running ${queries.length} web searches via Tavily...`,
      { totalQueries: queries.length },
    );

    // Emit per-query progress events optimistically up-front (so the UI sees
    // the search list immediately) and again as each settles with real
    // counts.
    const articles: Article[] = [];
    const queryResults: QueryFanoutResult[] = [];
    const tStart = Date.now();
    for (let i = 0; i < queries.length; i++) {
      const q = queries[i]!;
      emitter.phase('search', `Tavily: ${q}`, {
        query: i + 1,
        of: queries.length,
        q,
      });
    }
    const settled = await Promise.allSettled(
      queries.map((q) => runOneTavily(q)),
    );
    for (let i = 0; i < settled.length; i++) {
      const q = queries[i]!;
      const s = settled[i]!;
      if (s.status === 'fulfilled') {
        articles.push(...s.value.articles);
        queryResults.push({ query: q, ok: s.value.ok, count: s.value.articles.length });
      } else {
        queryResults.push({ query: q, ok: false, count: 0 });
      }
    }
    const deduped = dedupeByUrl(articles, 12);
    recordAudit(
      'picker.scan.tavily',
      'api.tavily.com',
      deduped.length > 0 ? 200 : 204,
      Date.now() - tStart,
    ).catch(() => undefined);

    emitter.phase(
      'sources',
      `${deduped.length} unique articles aggregated`,
      { count: deduped.length, queries: queryResults },
    );

    if (deduped.length === 0) {
      emitter.error(
        'Web search returned no usable articles for this market+sector combination. Try broader sectors or a different market.',
        'tavily-search',
        'no_articles',
      );
      return;
    }

    // ---- Persist to picker_jobs ----
    // Analyze step will SELECT this row, hydrate articles, and run Mistral
    // Medium against the FULL context. Storing the resolved market label
    // + allowed exchanges in `params` so analyze doesn't have to re-run
    // autoPickMarket (a billable LLM call).
    phase = 'persist-job';
    let jobId: number;
    try {
      const inserted = await db
        .insert(pickerJobs)
        .values({
          userId,
          status: 'searched',
          params: {
            ...body,
            _primaryMarketLabel: primaryMarketLabel,
            _allowedExchanges: allowedExchanges,
          },
          articles: deduped,
        })
        .returning({ id: pickerJobs.id });
      jobId = inserted[0]!.id;
    } catch (err) {
      console.error('[picker/scan] picker_jobs insert failed:', sanitizeError(err));
      emitter.error(
        'Failed to persist scan results. Try again in a moment.',
        'persist-job',
        'db_insert_failed',
      );
      return;
    }

    // ---- Done. Client receives jobId + article count; immediately POSTs
    //      to /api/picker/analyze with the same jobId to run the LLM step.
    emitter.result({
      jobId,
      articleCount: deduped.length,
      queries: queryResults,
    });
  }
}

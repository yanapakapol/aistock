import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { streamText, generateText, convertToModelMessages, type ModelMessage } from 'ai';

import { db } from '@/lib/db/client';
import { chats, chatMessages, outboundAudit, portfolios, stocks, users, type messageRoleEnum } from '@/lib/db/schema';
import { and, eq } from 'drizzle-orm';

import { PROVIDERS, LLM_HOSTS, type Provider } from '@/lib/llm/providers';
import { loadApiKey } from '@/lib/llm/keys';
import { clientFor } from '@/lib/llm/clientFor';

// Cross-team modules — interfaces only; concrete code lives in other agents' PRs.
import { getToolsByNames, allToolNames } from '@/lib/mcp/tools/lazy';
import { toAiSdkTool } from '@/lib/mcp/adapters/aiSdk';
import { scrubSecrets, sanitizeError } from '@/lib/security/scrub';
import { meter } from '@/lib/cost/meter';
import { addSpend, checkBudgetOrThrow } from '@/lib/cost/ledger';
import { getUserDailyUsage, addUserDailyUsage } from '@/lib/cost/userUsage';
import { getCurrentUser } from '@/lib/auth/session';

export const runtime = 'nodejs';
// Long-running streams. Vercel Hobby caps at 60s, Pro at 300s. Netlify free
// caps at 10s, Pro at 26s — Netlify free WILL kill Deep Research mid-stream.
export const maxDuration = 300;

// ---------- Request schema ----------

// AI SDK v6 client sends UIMessage shape: {role, parts: [{type, text?, ...}]}.
// Older flat-content shape is accepted too for forwards-compat.
const MessageSchema = z.object({
  id: z.string().optional(),
  role: z.enum(['user', 'assistant', 'system', 'tool']),
  content: z.string().optional(),
  parts: z
    .array(
      z
        .object({
          type: z.string(),
          text: z.string().optional(),
        })
        .passthrough(),
    )
    .optional(),
}).passthrough();

const FallbackEntrySchema = z.object({
  provider: z.enum(PROVIDERS),
  modelId: z.string().min(1),
});

const BodySchema = z.object({
  messages: z.array(MessageSchema).min(1),
  modelId: z.string().min(1),
  provider: z.enum(PROVIDERS),
  stockId: z.number().int().positive().optional(),
  tab: z.enum(['research', 'analysis']),
  chatId: z.number().int().positive().optional(),
  sessionId: z.string().max(128).optional(),
  maxToolIterations: z.number().int().min(1).max(64).optional(),
  maxUsdPerTurn: z.number().positive().max(10).optional(),
  /** UI-side heaviness preset; server expands to concrete caps + reasoning. */
  effort: z.enum(['low', 'medium', 'high', 'max']).optional(),
  /** Research tab only: when true, unlocks DB read tools (defaults to off). */
  dbMode: z.boolean().optional(),
  /**
   * Optional ordered fallback chain. Tried after the primary (provider,
   * modelId) fails at stream START with a retriable error (HTTP 429 / 5xx
   * / network timeout). Mid-stream errors are NOT recoverable — the
   * response body has already begun and the client owns it.
   *
   * Total attempts (primary + fallbacks) is capped at MAX_ATTEMPTS.
   */
  fallbackModels: z.array(FallbackEntrySchema).optional(),
});

// ---------- System preamble fragments (module-scoped, parsed once) ----------

// Research-tab workflow text. Long, so kept out of the request handler.
// {DB_HINT} placeholder is substituted per-request based on the dbMode flag.
const RESEARCH_EXTRA_TEMPLATE = `

RESEARCH TAB WORKFLOW:
  - {DB_HINT}
  - upsert_event / upsert_future_event / upsert_business_context persist immediately to Postgres. You MUST actually call them — describing them is not enough. Every search_news article with a usable date must be persisted via upsert_event before you write prose.
  - End every reply with a single marker line, no other text: "[[SAVED:E=4,F=1,C=1]]" (E=events, F=future_events, C=1 if business_context updated else 0). If nothing saved: "[[SAVED:E=0,F=0,C=0]]". The UI renders it as a badge.
  - Mention the top-right "DB" panel for inspection.

AUTO-SAVE ALGORITHM (every research turn, no permission needed):
  1. PAST EVENT — upsert_event for any search_news article with non-null published_date that mentions the active stock. Fields: stock_id, event_date=published_date, title (<=120 chars), summary_md (2-4 sentences in your words), source_url, sentiment_label in {bull,bear,neutral}, sentiment_score in [-1,1].
  2. FUTURE EVENT — upsert_future_event for any dated upcoming catalyst (earnings, FDA, trial, CMD, expiry, regulatory). Fields: expected_date, title, description_md, probability_positive + probability_negative in [0,1] summing <=1 (null if unknown), expected_impact_pct, source_urls.
  3. BUSINESS CONTEXT — at end of session, call upsert_business_context once per section (summary | timeline | future_outlook) with merged patch_md (<1500 chars each).
  4. event_date order: (a) explicit date in article body; (b) published_date; (c) today. Never invent dates or URLs — skip and report the gap instead.
  5. DEDUPE — Research tab cannot call get_events; rely on consolidate_events at the end.
  6. FINAL STEP — call consolidate_events({stock_id, dry_run:false}) ONCE after upserts; include returned deleted count in the [[SAVED:...]] marker.`;

const RESEARCH_DB_HINT_ON =
  'DB MODE ON: you may call get_events, get_business_context, get_future_events, get_prices to consult existing rows and avoid duplicates.';
const RESEARCH_DB_HINT_OFF =
  'DB MODE OFF: DB read tools are not available. Use search_news + reasoning, then write findings via upsert tools.';

const ANALYSIS_EXTRA = `

ANALYSIS TAB WORKFLOW (in order):
  1. Read DB first: get_business_context, get_events (limit 20), get_future_events, get_prices (last 90d).
  2. Identify gaps; only then call search_news to fill them.
  3. Cite DB events inline as [event #ID]; cite news as [source: hostname]. Include full URLs in a final "Citations" section as markdown links ("- [event #N — title](url)" or "- [news: hostname](url)"). If none: "Citations: (none)".`;

const SYSTEM_PREAMBLE_BASE =
  `You are a stock-research assistant inside the aistock platform. ` +
  `If you need the current date, call get_current_datetime — never guess. ` +
  `You have MCP tools for DB reads/writes and news search. ` +
  `Rules: (1) Never fabricate news/events/prices — only report what tools return. ` +
  `(2) If a tool returns "NEWS SEARCH UNAVAILABLE" or "no_keys_configured", relay verbatim and stop. ` +
  `(3) Cite event IDs and source URLs when summarizing events. ` +
  `(4) Be concise; no ornamental separators (---, ***, ===). If you announce a tool call, execute it the same turn. ` +
  `(5) Tabular data: GFM pipe tables. Charts: fenced \`chart\` block with JSON {type:'line'|'bar', title?, xLabel?, yLabel?, data:[{x,y}]}. ` +
  `Example upsert_event input: {"stock_id":123,"event_date":"2025-03-14","title":"Q1 beat","summary_md":"...","source_url":"https://...","sentiment_label":"bull","sentiment_score":0.6}`;

// ---------- Fallback policy ----------

const MAX_ATTEMPTS = 3;

/**
 * Reported host per provider so the audit row has a meaningful value even
 * though the AI SDK never lets us see the actual request URL.
 */
const PROVIDER_HOST: Record<Provider, string> = {
  openai: 'api.openai.com',
  anthropic: 'api.anthropic.com',
  google: 'generativelanguage.googleapis.com',
  mistral: 'api.mistral.ai',
  moonshot: 'api.moonshot.ai',
  deepseek: 'api.deepseek.com',
};
// Reference LLM_HOSTS so allowlist drift surfaces in this file too.
void LLM_HOSTS;

/**
 * Classify an error thrown synchronously from `streamText(...)` (or surfaced
 * while we're awaiting the first chunk to commit to the response). Returns
 * true if the next chain entry, if any, should be tried.
 *
 * Retriable:
 *   - HTTP 429 (rate limit)
 *   - HTTP 5xx (server error)
 *   - Network errors / aborts / timeouts (ETIMEDOUT, ECONNRESET, ENOTFOUND,
 *     AbortError, TimeoutError, undici socket errors)
 *
 * Non-retriable:
 *   - HTTP 4xx other than 429 — auth / bad request / not-found, the next
 *     provider would just be a different rejection of the same payload.
 */
function isRetriableStartError(e: unknown): boolean {
  if (!e || typeof e !== 'object') return false;
  const err = e as { status?: number; statusCode?: number; code?: string; name?: string };
  const status = err.status ?? err.statusCode;
  if (typeof status === 'number') {
    if (status === 429) return true;
    if (status >= 500 && status < 600) return true;
    if (status >= 400 && status < 500) return false;
  }
  const code = err.code ?? '';
  if (
    code === 'ETIMEDOUT' ||
    code === 'ECONNRESET' ||
    code === 'ECONNREFUSED' ||
    code === 'ENOTFOUND' ||
    code === 'EAI_AGAIN' ||
    code === 'UND_ERR_SOCKET' ||
    code === 'UND_ERR_CONNECT_TIMEOUT' ||
    code === 'AbortError'
  ) {
    return true;
  }
  const name = err.name ?? '';
  if (name === 'AbortError' || name === 'TimeoutError') return true;
  return false;
}

/** Extract an HTTP-ish status code from a thrown error, defaulting to 500. */
function statusFromError(e: unknown): number {
  if (!e || typeof e !== 'object') return 500;
  const err = e as { status?: number; statusCode?: number };
  return err.status ?? err.statusCode ?? 500;
}

async function recordAttemptAudit(
  provider: Provider,
  status: number,
  latencyMs: number,
): Promise<void> {
  try {
    await db.insert(outboundAudit).values({
      kind: 'chat.attempt',
      host: PROVIDER_HOST[provider],
      status: status || null,
      latencyMs,
    });
  } catch (err) {
    // Audit must never break the request path.
    console.error('[chat] audit insert failed:', sanitizeError(err));
  }
}

// ---------- Handler ----------

export async function POST(req: NextRequest) {
  // Tiny per-phase wall-clock log so production slowness becomes diagnosable
  // from Vercel logs without having to attach a profiler. Each phase fires
  // once per request; the cumulative time tells us which step is the actual
  // hot-path dominator (cold-start bundle, DB warmup, LLM first-byte, etc.).
  const t0 = Date.now();
  let lastT = t0;
  const phase = (name: string) => {
    const now = Date.now();
    // eslint-disable-next-line no-console
    console.log(`[chat] +${now - lastT}ms / ${now - t0}ms total → ${name}`);
    lastT = now;
  };

  // CSRF: only allow same-origin browser calls.
  const sfs = req.headers.get('sec-fetch-site');
  if (sfs && sfs !== 'same-origin' && sfs !== 'none') {
    return NextResponse.json({ error: 'cross-site blocked' }, { status: 403 });
  }

  // ---- AuthN + per-user daily cap gate ----
  // getCurrentUser() returns the trimmed projection (id/username/isAdmin); we
  // do a second tiny select to pick up the per-user caps that the schema
  // owner added (daily_token_cap, daily_usd_cap). NULL on either means
  // "unlimited for this user".
  //
  // PERF: Body JSON read, session lookup, and the models.json import are all
  // independent of one another — fan them out in parallel so the pre-stream
  // round-trip is dominated by the slowest single call instead of the sum.
  const bodyJsonP = req.json().catch((e) => ({ __err: e as unknown }));
  const sessionUserP = getCurrentUser();
  // models.json is needed later when building the fallback chain; importing
  // it now overlaps the dynamic-import cost with the network/DB I/O above.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const registryP = import('@/lib/llm/models.json', { with: { type: 'json' } }) as unknown as Promise<{
    default: Record<string, { models?: Array<{ id: string }> }>;
  }>;

  const sessionUser = await sessionUserP;
  phase('session loaded');
  if (!sessionUser) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  // userCaps + daily usage are both keyed on sessionUser.id and are
  // independent of each other (and of body parsing) — run all three in
  // parallel. We always need usage when caps are set; speculatively fetching
  // it costs one extra cheap roll-up read on the unlimited path, which is
  // dwarfed by the latency we save on the common capped path.
  const userCapsP = db
    .select({
      id: users.id,
      role: users.role,
      dailyTokenCap: users.dailyTokenCap,
      dailyUsdCap: users.dailyUsdCap,
    })
    .from(users)
    .where(eq(users.id, sessionUser.id))
    .limit(1);
  const usedP = getUserDailyUsage(sessionUser.id).catch((e) => {
    // Don't fail the request on a usage-read error; treat as zero usage and
    // let the request through (caps will simply not gate this turn).
    console.error('[chat] getUserDailyUsage failed:', sanitizeError(e));
    return { tokens_in: 0, tokens_out: 0, cost_usd: 0 };
  });

  const [[userCaps], used, bodyJsonRaw] = await Promise.all([userCapsP, usedP, bodyJsonP]);
  phase('caps + usage + body parsed');
  if (!userCaps) {
    // Session pointed at a now-deleted user. Treat as logged-out.
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  const userId = userCaps.id;
  const capTokens =
    userCaps.dailyTokenCap != null && Number.isFinite(Number(userCaps.dailyTokenCap))
      ? Number(userCaps.dailyTokenCap)
      : null;
  const capUsd =
    userCaps.dailyUsdCap != null && Number.isFinite(Number(userCaps.dailyUsdCap))
      ? Number(userCaps.dailyUsdCap)
      : null;
  if (capTokens != null || capUsd != null) {
    const usedTokens = used.tokens_in + used.tokens_out;
    if (capTokens != null && usedTokens >= capTokens) {
      return NextResponse.json(
        { error: 'daily token cap reached', usedTokens, capTokens },
        { status: 429 },
      );
    }
    if (capUsd != null && used.cost_usd >= capUsd) {
      return NextResponse.json(
        { error: 'daily USD cap reached', usedUsd: used.cost_usd, capUsd },
        { status: 429 },
      );
    }
  }

  let body: z.infer<typeof BodySchema>;
  {
    const errored =
      bodyJsonRaw && typeof bodyJsonRaw === 'object' && '__err' in (bodyJsonRaw as object);
    if (errored) {
      const e = (bodyJsonRaw as { __err: unknown }).__err;
      console.error('[chat] body parse failed:', e);
      return NextResponse.json(
        { error: 'invalid request', detail: sanitizeError(e) },
        { status: 400 },
      );
    }
    const json = bodyJsonRaw as unknown;
    const parsed = BodySchema.safeParse(json);
    if (!parsed.success) {
      console.error('[chat] body validation failed:', parsed.error.issues);
      console.error('[chat] received body keys:', Object.keys((json ?? {}) as object));
      return NextResponse.json(
        { error: 'invalid request', issues: parsed.error.issues },
        { status: 400 },
      );
    }
    body = parsed.data;
  }

  const {
    messages,
    modelId,
    provider,
    stockId,
    tab,
    chatId: chatIdIn,
    sessionId: sessionIdIn,
    maxToolIterations,
    maxUsdPerTurn,
    effort,
    dbMode,
    fallbackModels,
  } = body;

  // Effort preset → concrete caps. Explicit numeric overrides win. The `iter`
  // figure is the TOOL-call budget; we add a +2 buffer when passing to
  // stopWhen so the model always has room for a final text synthesis step
  // after the last tool call (without this it can end on a tool call and
  // emit no assistant text at all).
  const EFFORT_PRESETS = {
    low: { iter: 3, usd: 0.05, maxOutputTokens: 1500, reasoning: 'low' as const },
    medium: { iter: 6, usd: 0.15, maxOutputTokens: 4000, reasoning: 'medium' as const },
    high: { iter: 12, usd: 0.4, maxOutputTokens: 8000, reasoning: 'high' as const },
    max: { iter: 30, usd: 1.0, maxOutputTokens: 16000, reasoning: 'high' as const },
  };
  const preset = EFFORT_PRESETS[effort ?? 'medium'];
  const effectiveIter = maxToolIterations ?? preset.iter;
  const effectiveUsd = maxUsdPerTurn ?? preset.usd;
  // Log the effective caps so the user can verify the picker is wired up.
  // Output tokens are no longer capped — only tool-iteration count and USD
  // budget control runaway. This prevents mid-sentence halts.
  console.log(
    `[chat] tab=${tab} effort=${effort ?? 'medium'} iter=${effectiveIter} usdCap=${effectiveUsd}`,
  );

  // PERF: chat-row resolution, the stock-context lookup, and the
  // provider-key discovery scan are independent of each other AND of the
  // tools/system-preamble assembly below. Fire them all off now and await
  // their results just before they're needed.
  const chatIdP = resolveChatId({
    chatIdIn,
    sessionIdIn,
    tab,
    stockId,
    modelId,
  });

  // Per-provider `loadApiKey` calls each hit a DB row + decrypt; running the
  // PROVIDERS array sequentially used to add ~6× one row-trip of latency.
  // Promise.all collapses that to a single round-trip.
  const providerKeysP = Promise.all(
    PROVIDERS.map(async (p) => ({ p, key: await loadApiKey(p) })),
  );

  // Stock-context select (ownership-scoped). Only runs when stockId was
  // supplied. We launch it before the system-preamble assembly so the result
  // is already in hand by the time we splice it in.
  const stockCtxP: Promise<string> = stockId
    ? (async () => {
        try {
          // Ownership-scoped: only build stockCtx if the stock belongs to
          // this user. Without the portfolios JOIN, a malicious client
          // could pass another user's stockId in the request body and the
          // model would happily run all its tools against that stock_id.
          const [s] = await db
            .select({ id: stocks.id, symbol: stocks.symbol, exchange: stocks.exchange, name: stocks.name })
            .from(stocks)
            .innerJoin(portfolios, eq(portfolios.id, stocks.portfolioId))
            .where(and(eq(stocks.id, stockId), eq(portfolios.userId, sessionUser.id)))
            .limit(1);
          if (!s) return '';
          return (
            `Active stock: stock_id=${s.id}, symbol=${s.symbol}, exchange=${s.exchange}, name="${s.name}". ` +
            `Use stock_id=${s.id} for every DB tool call (get_events, get_prices, get_business_context, search_news, upsert_*). ` +
            `DO NOT call search_stocks for this stock — it is already in the database.`
          );
        } catch {
          /* non-fatal */
          return '';
        }
      })()
    : Promise.resolve('');

  // Research = forward-looking, never reads DB; Analysis = DB-first with news fill.
  // Whitelist the relevant tool subset per tab so the model can't "cheat" by
  // pulling from DB during research (which would dilute fresh-research signal).
  const RESEARCH_TOOL_ALLOW = new Set([
    'search_stocks',
    'search_news',
    'upsert_event',
    'upsert_future_event',
    'upsert_business_context',
    'create_routine',
    'consolidate_events',
    'get_current_datetime',
  ]);
  const allowedNames =
    tab === 'research' && !dbMode ? Array.from(RESEARCH_TOOL_ALLOW) : allToolNames();
  const toolsList = await getToolsByNames(allowedNames);
  // Pass the authenticated user's id into every tool's ctx. Stock-scoped
  // tools use this to refuse access to data outside the caller's portfolio.
  const tools = Object.fromEntries(
    toolsList.map((t) => [t.name, toAiSdkTool(t, { userId: sessionUser.id })]),
  );

  // Build a small system preamble so the model already knows the active stock
  // (avoids it calling search_stocks for a stock that's already in the DB),
  // along with a hard rule against fabricating data. The select was kicked
  // off above (stockCtxP); we just await it here.
  const stockCtx = await stockCtxP;
  const researchExtra =
    tab === 'research'
      ? RESEARCH_EXTRA_TEMPLATE.replace(
          '{DB_HINT}',
          dbMode ? RESEARCH_DB_HINT_ON : RESEARCH_DB_HINT_OFF,
        )
      : '';
  const analysisExtra = tab === 'analysis' ? ANALYSIS_EXTRA : '';
  const budgetBrief =
    `BUDGET (this turn only, resets each user message; earlier-turn tool calls don't count): ` +
    `${effectiveIter} tool calls, $${effectiveUsd.toFixed(2)} cap. ` +
    `LAST step must be plain text — never end on a tool call. Stop calling tools by iteration ${Math.max(1, effectiveIter - 1)} and write the answer with what you have.`;

  const systemPreamble =
    SYSTEM_PREAMBLE_BASE +
    ' ' +
    budgetBrief +
    (stockCtx ? `\n\n${stockCtx}` : '') +
    analysisExtra +
    researchExtra;

  const lastUserMessageRaw = [...messages].reverse().find((m) => m.role === 'user');
  // v6 UIMessage may carry text in `parts: [{type:'text', text}]` or legacy `content`.
  const lastUserText = lastUserMessageRaw
    ? (lastUserMessageRaw as { content?: string; parts?: Array<{ type: string; text?: string }> })
        .parts?.filter((p) => p.type === 'text').map((p) => p.text ?? '').join('') ||
      (lastUserMessageRaw as { content?: string }).content ||
      ''
    : '';
  const lastUserMessage = lastUserMessageRaw
    ? { role: 'user' as const, content: lastUserText }
    : null;

  // Persist the user message IMMEDIATELY so a mid-stream crash, network drop,
  // or early stop still leaves the turn in history. Was previously inside
  // onFinish — which silently dropped chats that errored or never finished.
  // We need chatId here for the first time, so await the resolveChatId
  // promise we kicked off earlier.
  const chatId = await chatIdP;
  let userMessagePersisted = false;
  if (lastUserMessageRaw) {
    const userParts = (lastUserMessageRaw as { parts?: unknown[] }).parts ?? [
      { type: 'text', text: lastUserText },
    ];
    try {
      await insertMessage(
        chatId,
        'user',
        String(scrubSecrets(lastUserText)),
        undefined,
        undefined,
        undefined,
        null,
        scrubObject(userParts),
      );
      userMessagePersisted = true;
    } catch (err) {
      console.error('[chat] failed to persist user message:', sanitizeError(err));
    }
  }

  // Accumulator for the assistant message. Updated on every step so we can
  // flush partial progress if the stream is interrupted (onError, abort).
  const accumulatedParts: Array<Record<string, unknown>> = [];
  let accumulatedText = '';
  let accumulatedUsage: {
    inputTokens?: number;
    outputTokens?: number;
    promptTokens?: number;
    completionTokens?: number;
  } | null = null;
  let assistantPersisted = false;

  function pushStepParts(step: {
    text?: string;
    toolCalls?: Array<{ toolCallId?: string; toolName?: string; input?: unknown; args?: unknown }>;
    toolResults?: Array<{ toolCallId?: string; toolName?: string; output?: unknown; result?: unknown }>;
  }) {
    if (step.text) {
      accumulatedParts.push({ type: 'text', text: step.text });
      accumulatedText += (accumulatedText ? '\n\n' : '') + step.text;
    }
    const results = (step.toolResults ?? []) as Array<{
      toolCallId?: string;
      output?: unknown;
      result?: unknown;
    }>;
    const resultById = new Map<string, unknown>();
    for (const r of results) {
      if (r.toolCallId) resultById.set(r.toolCallId, r.output ?? r.result);
    }
    for (const c of step.toolCalls ?? []) {
      accumulatedParts.push({
        type: `tool-${c.toolName ?? 'unknown'}`,
        toolName: c.toolName,
        toolCallId: c.toolCallId,
        input: c.input ?? c.args,
        output: c.toolCallId ? (resultById.get(c.toolCallId) ?? null) : null,
      });
    }
  }

  async function persistAssistant(reason: 'finish' | 'error' | 'abort') {
    if (assistantPersisted) return;
    assistantPersisted = true;
    try {
      const u = accumulatedUsage;
      const tokensIn = u?.inputTokens ?? u?.promptTokens ?? 0;
      const tokensOut = u?.outputTokens ?? u?.completionTokens ?? 0;
      const costUsd = meter({
        provider, // primary; per-attempt provider would be ideal but this fires from any scope
        modelId,
        tokensIn,
        tokensOut,
      });
      const partsToWrite =
        accumulatedParts.length > 0
          ? accumulatedParts
          : [{ type: 'text', text: accumulatedText || `(stream ${reason} — no content)` }];
      await insertMessage(
        chatId,
        'assistant',
        String(scrubSecrets(accumulatedText || `(stream ${reason})`)),
        tokensIn,
        tokensOut,
        costUsd,
        null,
        scrubObject(partsToWrite),
      );
      if (costUsd > 0) await addSpend(provider, costUsd);
      // Per-user daily roll-up. Runs alongside the global per-provider
      // budget_ledger above; that one caps the provider key, this one caps
      // the user. Both must exist.
      try {
        await addUserDailyUsage(userId, provider, tokensIn, tokensOut, costUsd);
      } catch (err) {
        console.error(
          `[chat] failed to upsert user_token_usage (${reason}):`,
          sanitizeError(err),
        );
      }
    } catch (err) {
      console.error(`[chat] failed to persist assistant (${reason}):`, sanitizeError(err));
    }
  }

  // Best-effort flush if the HTTP request itself is aborted (e.g. the user
  // navigates away or hits stop). The AI SDK passes our abort signal through
  // to the model; we hook it here so the partial transcript still lands.
  req.signal?.addEventListener('abort', () => {
    void persistAssistant('abort');
  });

  // Build attempt chain — primary + explicit fallbacks, then auto-rescue with
  // ANY other provider that has a saved key so the user never gets
  // "Invalid model" just because their localStorage default points at a
  // provider they never configured.
  const rawChain: Array<{ provider: Provider; modelId: string }> = [
    { provider, modelId },
    ...(fallbackModels ?? []),
  ];

  // Discover every provider with a saved key (so we can auto-fill the chain).
  // `loadApiKey` resolves the effective user internally via `getCurrentUser()`
  // and, for role='guest', transparently falls back to the admin's encrypted
  // row — so guest sessions can chat using inherited keys without us threading
  // anything explicit through this route.
  //
  // PERF: both the key scan (providerKeysP) and the models.json import
  // (registryP) were kicked off above; await them together here. We also
  // build a key map so the per-attempt `loadApiKey` call becomes a synchronous
  // Map.get instead of another DB+decrypt round-trip.
  const [providerKeyEntries, registryModule] = await Promise.all([
    providerKeysP,
    registryP,
  ]);
  phase('keys + registry resolved');
  const apiKeyByProvider = new Map<Provider, string>();
  const providersWithKeys: Provider[] = [];
  for (const { p, key } of providerKeyEntries) {
    if (key) {
      apiKeyByProvider.set(p, key);
      providersWithKeys.push(p);
    }
  }
  const registry: Record<string, { models?: Array<{ id: string }> }> = registryModule.default;

  // Append every key-having provider's first model, deduped against the chain.
  const seen = new Set(rawChain.map((e) => `${e.provider}/${e.modelId}`));
  for (const p of providersWithKeys) {
    const def = registry[p]?.models?.[0]?.id;
    if (!def) continue;
    const key = `${p}/${def}`;
    if (seen.has(key)) continue;
    seen.add(key);
    rawChain.push({ provider: p, modelId: def });
  }
  // Auto-rescue: drop entries whose provider has no key so we don't waste
  // attempts on definite 400s.
  const chain = rawChain
    .filter((e) => providersWithKeys.includes(e.provider))
    .slice(0, MAX_ATTEMPTS);
  if (chain.length === 0) {
    return NextResponse.json(
      {
        error: {
          message:
            'No usable LLM provider — add at least one API key in Settings (OpenAI, Anthropic, Google, Mistral, Moonshot, or DeepSeek).',
        },
      },
      { status: 400 },
    );
  }

  const usdCap = effectiveUsd;
  let lastError: unknown = null;
  let lastStatus = 500;

  for (let i = 0; i < chain.length; i++) {
    const attempt = chain[i]!;
    const start = Date.now();
    const isLast = i + 1 >= chain.length;

    // --- Per-attempt: key load ------------------------------------------------
    // PERF: keys were fetched in parallel during discovery above and cached
    // in `apiKeyByProvider`. Reuse the cached value rather than hitting the
    // DB again for every attempt (this used to add one extra round-trip on
    // the hot first-attempt path).
    const apiKey = apiKeyByProvider.get(attempt.provider) ?? null;
    if (!apiKey) {
      lastStatus = 400;
      lastError = new Error(`no api key saved for ${attempt.provider}`);
      void recordAttemptAudit(attempt.provider, lastStatus, Date.now() - start);
      // Different provider next in the chain → continue. If this was the
      // primary and no fallbacks were provided, fall through to the 400.
      if (!isLast) continue;
      return NextResponse.json({ error: sanitizeError(lastError) }, { status: lastStatus });
    }

    // --- Per-attempt: budget check (per-provider bucket) ----------------------
    try {
      await checkBudgetOrThrow(attempt.provider, 0, usdCap);
    } catch (e) {
      lastStatus = 429;
      lastError = e;
      void recordAttemptAudit(attempt.provider, lastStatus, Date.now() - start);
      // Budget is per-provider; the next chain entry is a different
      // provider with its own bucket, so try it.
      if (!isLast) continue;
      return NextResponse.json({ error: sanitizeError(e) }, { status: lastStatus });
    }

    const model = await clientFor(attempt.provider, attempt.modelId, apiKey);
    phase(`clientFor(${attempt.provider}) loaded`);
    const attemptProvider = attempt.provider;
    const attemptModelId = attempt.modelId;

    // --- Per-attempt: open the stream -----------------------------------------
    // streamText's tool typing is incompatible with our generic ToolSet shape;
    // cast result loosely since we only use `.toUIMessageStreamResponse()`.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let result: any;
    try {
      // convertToModelMessages is async in this SDK version — must await.
      const modelMessages = (await convertToModelMessages(messages as never)) as ModelMessage[];
      phase('messages converted, calling streamText');
      result = streamText({
        model,
        system: systemPreamble,
        messages: modelMessages,
        tools: tools as never,
        // No `maxOutputTokens` cap — that was the only way to halt mid-sentence.
        // The effort preset still controls reasoning depth, tool iterations,
        // and the per-turn USD budget below.
        // Reasoning effort for providers that support it (OpenAI o-series,
        // Anthropic extended thinking, Gemini thinking_level). Unknown
        // providers ignore the keys.
        providerOptions: {
          openai: { reasoningEffort: preset.reasoning },
          anthropic: {
            thinking: {
              type: 'enabled',
              // Thinking budget is independent of the (now removed)
              // maxOutputTokens cap. Scale with effort.
              budgetTokens:
                preset.reasoning === 'low' ? 1024 : preset.reasoning === 'medium' ? 4096 : 16384,
            },
          },
          google: {
            thinkingConfig: {
              thinkingBudget:
                preset.reasoning === 'low' ? 0 : preset.reasoning === 'medium' ? 2048 : 8192,
            },
          },
        } as never,
        // +5 step buffer so the model has plenty of room for a final text
        // synthesis after the last tool call. Hard cap stays bounded.
        stopWhen: ({ steps }: { steps: unknown[] }) =>
          steps.length >= effectiveIter + 5,
        // Incremental: capture every step so partial transcripts survive errors.
        onStepFinish: (step: {
          text?: string;
          toolCalls?: Array<{ toolCallId?: string; toolName?: string; input?: unknown; args?: unknown }>;
          toolResults?: Array<{ toolCallId?: string; toolName?: string; output?: unknown; result?: unknown }>;
          usage?: unknown;
        }) => {
          accumulatedUsage = (step.usage as never) ?? accumulatedUsage;
          pushStepParts(step);
        },
        onFinish: async (event: {
          usage?: unknown;
          text?: string;
          toolCalls?: unknown;
          steps?: Array<{ text?: string; toolCalls?: unknown; toolResults?: unknown }>;
        }) => {
          // If onStepFinish didn't fire (some providers), reconstruct from steps.
          if (accumulatedParts.length === 0 && Array.isArray(event.steps)) {
            for (const s of event.steps) pushStepParts(s as never);
          }
          if (event.text && !accumulatedText.includes(event.text)) {
            accumulatedText = event.text;
            if (!accumulatedParts.some((p) => p.type === 'text' && p.text === event.text)) {
              accumulatedParts.push({ type: 'text', text: event.text });
            }
          }
          accumulatedUsage = (event.usage as never) ?? accumulatedUsage;

          // GUARANTEED SYNTHESIS: if the loop ended without any assistant
          // text, force a one-shot generateText pass with NO tools so the
          // model is forced to produce prose from whatever tool results we
          // gathered. This guarantees the answer card is never empty.
          const hasText = accumulatedParts.some(
            (p) => p.type === 'text' && typeof p.text === 'string' && (p.text as string).trim().length > 0,
          );
          if (!hasText) {
            try {
              // Build a synthesis prompt that includes the tool results.
              const toolSummary = accumulatedParts
                .filter((p) => (p.type as string).startsWith('tool-'))
                .map((p) => {
                  const out = (p as { output?: unknown }).output;
                  const txt =
                    typeof out === 'string'
                      ? out.slice(0, 1500)
                      : JSON.stringify(out ?? null).slice(0, 1500);
                  return `### ${(p as { toolName?: string }).toolName ?? p.type}\n${txt}`;
                })
                .join('\n\n');
              const synth = await generateText({
                model,
                messages: [
                  ...modelMessages,
                  {
                    role: 'user',
                    content:
                      `You called the following tools and got these results. ` +
                      `Write a complete, well-formatted answer to my original question using them. ` +
                      `Cite event IDs and source URLs from the tool outputs. End with the [[SAVED:E=…,F=…,C=…]] marker.\n\n` +
                      toolSummary,
                  },
                ],
              });
              const synthText = String(scrubSecrets(synth.text ?? '')) || '(model returned no text on synthesis pass)';
              accumulatedParts.push({ type: 'text', text: synthText });
              accumulatedText = (accumulatedText ? accumulatedText + '\n\n' : '') + synthText;
              // Also fold synth usage into the meter so cost is accurate.
              const su = synth.usage as unknown as {
                inputTokens?: number;
                outputTokens?: number;
                promptTokens?: number;
                completionTokens?: number;
              };
              const prev = accumulatedUsage as
                | { inputTokens?: number; outputTokens?: number }
                | null;
              accumulatedUsage = {
                inputTokens:
                  (prev?.inputTokens ?? 0) + (su?.inputTokens ?? su?.promptTokens ?? 0),
                outputTokens:
                  (prev?.outputTokens ?? 0) + (su?.outputTokens ?? su?.completionTokens ?? 0),
              } as never;
            } catch (err) {
              const msg = `_(synthesis pass failed: ${(sanitizeError(err) as { message?: string }).message ?? 'unknown'}. Send a follow-up like "summarize what you found".)_`;
              accumulatedParts.push({ type: 'text', text: msg });
              accumulatedText = (accumulatedText ? accumulatedText + '\n\n' : '') + msg;
            }
          }
          await persistAssistant('finish');
        },
        onError: async ({ error }: { error: unknown }) => {
          console.error(
            `[chat] streamed error on ${attemptProvider}/${attemptModelId}:`,
            sanitizeError(error),
          );
          // Append the error itself as a part so the user can see it in history.
          accumulatedParts.push({
            type: 'text',
            text: `_[stream error: ${(sanitizeError(error) as { message?: string }).message ?? 'unknown'}]_`,
          });
          await persistAssistant('error');
        },
      });
    } catch (e) {
      const status = statusFromError(e);
      lastStatus = status;
      lastError = e;
      void recordAttemptAudit(attempt.provider, status, Date.now() - start);
      if (!isLast && isRetriableStartError(e)) continue;
      return NextResponse.json({ error: sanitizeError(e) }, { status: status || 500 });
    }

    // streamText returned without throwing — commit. Audit success and
    // hand the body to the client. Note we audit BEFORE returning so the
    // row's latency reflects "time to first byte", not the full stream.
    void recordAttemptAudit(attempt.provider, 200, Date.now() - start);
    phase('streamText returned — handing off');
    // v6 messageMetadata signature is `({part}) => unknown` and only emits when
    // the return value is defined. Emit on the finish part only.
    return result.toUIMessageStreamResponse({
      messageMetadata: ({ part }: { part: { type: string } }) => {
        if (part.type === 'finish') {
          return { chatId, provider: attemptProvider, modelId: attemptModelId };
        }
        return undefined;
      },
    });
  }

  // Unreachable when chain.length > 0 — every branch above either continues
  // or returns. Defensive fallthrough kept so a future refactor can't
  // accidentally hang the request.
  return NextResponse.json(
    { error: sanitizeError(lastError ?? new Error('all providers failed')) },
    { status: lastStatus || 502 },
  );
}

// ---------- DB helpers ----------

async function createChat(
  tab: 'research' | 'analysis',
  stockId: number | undefined,
  modelId: string,
  sessionId?: string | null,
): Promise<number> {
  const [row] = await db
    .insert(chats)
    .values({
      tab,
      stockId: stockId ?? null,
      model: modelId,
      sessionId: sessionId ?? null,
    })
    .returning({ id: chats.id });
  return row.id;
}

async function resolveChatId(args: {
  chatIdIn: number | undefined;
  sessionIdIn: string | undefined;
  tab: 'research' | 'analysis';
  stockId: number | undefined;
  modelId: string;
}): Promise<number> {
  const { chatIdIn, sessionIdIn, tab, stockId, modelId } = args;

  if (chatIdIn != null) {
    const [existing] = await db
      .select({ id: chats.id })
      .from(chats)
      .where(eq(chats.id, chatIdIn))
      .limit(1);
    if (existing) return existing.id;
    // Stale or rotated id from the client — silently fall through to
    // session/insert behaviour rather than 4xx, which would derail an
    // otherwise-valid turn.
  }

  if (sessionIdIn) {
    const [existing] = await db
      .select({ id: chats.id })
      .from(chats)
      .where(eq(chats.sessionId, sessionIdIn))
      .limit(1);
    if (existing) return existing.id;
    return createChat(tab, stockId, modelId, sessionIdIn);
  }

  return createChat(tab, stockId, modelId, null);
}

type Role = (typeof messageRoleEnum.enumValues)[number];

async function insertMessage(
  chatId: number,
  role: Role,
  contentMd: string,
  tokensIn?: number,
  tokensOut?: number,
  costUsd?: number,
  toolCalls?: unknown,
  parts?: unknown,
) {
  try {
    await db.insert(chatMessages).values({
      chatId,
      role,
      contentMd,
      toolCalls: (toolCalls ?? null) as never,
      parts: (parts ?? null) as never,
      tokensIn: tokensIn ?? null,
      tokensOut: tokensOut ?? null,
      costUsd: costUsd != null ? costUsd.toFixed(6) : null,
    });
  } catch (err) {
    // Tolerate the `parts` column not yet existing (user hasn't re-run
    // db:migrate). Retry without it so the message still persists.
    const msg = (err as { message?: string }).message ?? '';
    if (!/parts|column.*does not exist/i.test(msg)) throw err;
    console.warn('[chat] `parts` column missing — run db:migrate. Persisting without parts.');
    await db.insert(chatMessages).values({
      chatId,
      role,
      contentMd,
      toolCalls: (toolCalls ?? null) as never,
      tokensIn: tokensIn ?? null,
      tokensOut: tokensOut ?? null,
      costUsd: costUsd != null ? costUsd.toFixed(6) : null,
    });
  }
}

function scrubObject<T>(obj: T): T {
  try {
    return JSON.parse(String(scrubSecrets(JSON.stringify(obj)))) as T;
  } catch {
    return obj;
  }
}

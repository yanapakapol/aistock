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
import { getProviderDailyCap } from '@/lib/cost/limits';
import { getUserDailyUsage, addUserDailyUsage } from '@/lib/cost/userUsage';
import { getCurrentUser } from '@/lib/auth/session';

export const runtime = 'nodejs';
// Long-running streams. Vercel Hobby caps at 60s, Pro at 300s. Netlify free
// caps at 10s, Pro at 26s — Netlify free WILL kill Deep Research mid-stream.
export const maxDuration = 300;
// `dynamic = 'force-dynamic'` + `revalidate = 0` so Next.js never caches the
// route handler. We had the symptom of a stale `/api/chat` λ serving even
// after several pushes — research suggests build-payload cache skipped the
// re-upload because hashes were close enough. These exports change the route
// metadata and guarantee the bundle hash differs.
export const dynamic = 'force-dynamic';
export const revalidate = 0;
// BUILD STAMP — bumped on every deploy where we need to force Vercel to
// rebuild the function payload. Adding a NEW HTTP method (OPTIONS) below
// gives the bundle's exports list a genuinely new shape so Vercel CANNOT
// reuse the cached function payload. This was the only thing left to try
// after 13+ commits failed to update the route.
const __BUILD_STAMP__ = 'chat-route-2026-05-25T02-15-00Z-rev5-options-handler';
void __BUILD_STAMP__;

// ---------- Orphan-tool-call sanitizer ----------
//
// AI SDK v6 rejects message histories where an assistant message has a
// tool-call (or dynamic-tool-call) `part` whose `toolCallId` doesn't have
// a matching tool-result `part` later in the stream:
//   "Tool results are missing for tool calls X, Y, Z"
//
// This happens whenever a previous turn was interrupted between emitting
// the tool-call and persisting the tool-result — Vercel 60s timeout,
// browser close, watchdog fire, provider 500 mid-stream. The assistant
// row lands in chat_messages.parts with tool-call parts but no matching
// tool-result. On the next turn the client hydrates the chat history,
// POSTs the malformed array, and convertToModelMessages throws.
//
// Fix: walk the messages and PAIR every tool-call with either its real
// tool-result (already in the history) or a synthetic "aborted" stub.
// Synthetic stubs are preferred over dropping the tool-call entirely so
// the assistant's reasoning chain stays intact for the model to read.
//
// Idempotent — running on already-clean histories is a no-op.
type ChatPart = {
  type: string;
  toolCallId?: string;
  state?: string;
  [k: string]: unknown;
};
type ChatMessage = {
  role: 'user' | 'assistant' | 'system' | 'tool';
  content?: string;
  parts?: ChatPart[];
  [k: string]: unknown;
};

function isToolCallPart(p: ChatPart): boolean {
  // v6 emits 'tool-call' for static tools and 'dynamic-tool-call' for
  // MCP / dynamic tools. UIMessage format uses 'tool-<name>' for parts
  // with a `state` field — we treat any of those as tool calls too.
  if (p.type === 'tool-call' || p.type === 'dynamic-tool-call') return true;
  if (typeof p.type === 'string' && p.type.startsWith('tool-') && p.toolCallId) {
    // 'tool-<name>' parts can be either side (input-* / output-*).
    // Treat them as a tool-call when there's no output present.
    const s = String(p.state ?? '');
    return s.startsWith('input-') || s === 'call';
  }
  return false;
}
function isToolResultPart(p: ChatPart): boolean {
  if (p.type === 'tool-result' || p.type === 'dynamic-tool-result') return true;
  if (typeof p.type === 'string' && p.type.startsWith('tool-') && p.toolCallId) {
    const s = String(p.state ?? '');
    return s.startsWith('output-') || s === 'result';
  }
  return false;
}

function sanitizeOrphanToolCalls<M extends ChatMessage>(messages: M[]): M[] {
  // Pass 1: collect every toolCallId that HAS a result anywhere in history.
  const resultIds = new Set<string>();
  for (const m of messages) {
    for (const p of m.parts ?? []) {
      if (isToolResultPart(p) && typeof p.toolCallId === 'string') {
        resultIds.add(p.toolCallId);
      }
    }
  }

  // Pass 2: for each assistant message, find tool-calls with no matching
  // result and inject a synthetic tool-result for them in the SAME message.
  // We add it as a sibling part so the AI SDK sees the pair on conversion.
  const out: M[] = [];
  for (const m of messages) {
    if (!m.parts || m.parts.length === 0) {
      out.push(m);
      continue;
    }
    const newParts: ChatPart[] = [...m.parts];
    const seenIds = new Set<string>();
    for (const p of m.parts) {
      if (!isToolCallPart(p) || typeof p.toolCallId !== 'string') continue;
      if (seenIds.has(p.toolCallId)) continue;
      seenIds.add(p.toolCallId);
      if (resultIds.has(p.toolCallId)) continue; // real result exists somewhere
      // Inject synthetic stub — uses the same toolCallId so the SDK can pair.
      const stubName =
        (p as { toolName?: string }).toolName ??
        (typeof p.type === 'string' && p.type.startsWith('tool-')
          ? p.type.slice(5)
          : 'unknown_tool');
      newParts.push({
        type: 'tool-result',
        toolCallId: p.toolCallId,
        toolName: stubName,
        result: { __aborted: true, reason: 'previous turn interrupted before result' },
        output: { __aborted: true, reason: 'previous turn interrupted before result' },
      });
      resultIds.add(p.toolCallId); // don't double-inject in later messages
    }
    out.push({ ...m, parts: newParts });
  }

  return out;
}

/**
 * OPTIONS /api/chat — CORS preflight + bundle-shape changer.
 *
 * Two purposes:
 * 1. Real CORS preflight support for if anyone ever embeds the chat from a
 *    different origin (today same-origin only, but harmless to declare).
 * 2. CRITICAL — adding a brand-new exported HTTP handler changes the route
 *    module's export shape. Vercel's per-route function-payload cache keys
 *    on the bundle's exports + content hash; with a new export present, the
 *    cache cannot reuse the prior /api/chat function bundle. This forces a
 *    fresh λ upload, picking up the TDZ fix from d82f9db that was otherwise
 *    stuck behind the cache.
 */
export async function OPTIONS() {
  return new NextResponse(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': 'same-origin',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'content-type, cookie',
      'Access-Control-Max-Age': '600',
    },
  });
}

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
// HARD RULE: research is INVENTORY-FIRST, not Q&A. Every turn = inventory → gap → upsert → report.
const RESEARCH_EXTRA_TEMPLATE = `

RESEARCH TAB WORKFLOW — DO NOT answer in Q&A mode. Always: inventory → gap → upsert → report.
{DB_HINT}

PHASE 1 — INVENTORY (mandatory; first action every turn when DB mode is ON):
  - Call get_business_context(stock_id), get_events(stock_id, limit:50), get_future_events(stock_id) IN PARALLEL.
  - Open the reply with this exact block (fill from tool results; omit fields with no data):
    📊 Already in DB for \${symbol}:
      • Business context: <which of summary / timeline / future_outlook are populated> (updated <relative-age> each, or "missing")
      • Events: <N> past events (<X> bull, <Y> neutral, <Z> bear). Latest: <YYYY-MM-DD> "<title>" (event #<id>). Top 3-5 relevant titles by recency/sentiment.
      • Future events: <N> upcoming. Next 3 dated catalysts: <date> "<title>" (probability <p>).

PHASE 2 — GAP IDENTIFICATION:
  - Compare the user's question (or the implicit "research this stock" intent) against the inventory.
  - Output a "🎯 Gaps to fill" block listing: drivers not yet covered; past events from last N days missing from DB; forward catalysts within next 90 days not tracked; business_context sections empty or >7 days stale.

PHASE 3 — SEARCH + DEDUPE-AWARE UPSERT:
  - For each gap, call search_news with a targeted query.
  - Classify EVERY returned article and act:
      🆕 NEW       → dated event not in DB → upsert_event
      ✏️ UPDATE    → matches existing event by (stock_id, event_date, fuzzy title) but article adds richer summary/correction → upsert_event with same date+title (overwrites)
      ✅ EXISTS    → already in DB, article adds nothing → DO NOT write
  - Forward catalysts: same logic via upsert_future_event.
  - Business_context: upsert_business_context only at end of turn, once per section (summary | timeline | future_outlook), patch_md <1500 chars each.
  - Date order for event_date: (a) explicit date in article body; (b) published_date; (c) today. Never invent dates or URLs.

PHASE 4 — FINAL REPORT (mandatory; replaces the bare marker):
  📝 This turn:
    • Saved <E> new events: #<id>-#<id>
    • Updated <U> existing: #<id> (reason), ...
    • Skipped <S> already-known articles
    • Added <F> future catalysts: #f<id> "<title> <date>"
    • Updated business_context.<section> (if any)
  [[SAVED:E=<new-events>,F=<new-future>,C=<1-if-context-bumped-else-0>,U=<updates>,S=<skipped>]]

After upserts, call consolidate_events({stock_id, dry_run:false}) ONCE. Mention the top-right "DB" panel for inspection.
Example upsert_event input: {"stock_id":123,"event_date":"2025-03-14","title":"Q1 beat","summary_md":"...","source_url":"https://...","sentiment_label":"bull","sentiment_score":0.6}`;

const RESEARCH_DB_HINT_ON =
  'DB MODE ON: you MUST call get_events, get_business_context, get_future_events FIRST every turn — see PHASE 1.';
const RESEARCH_DB_HINT_OFF =
  'DB MODE OFF: skip PHASE 1; go directly to search and upsert. Your replies will not have an inventory block.';

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
  // TRACE marker (echoed in headers): bump this string on every diagnostic
  // commit so we can curl-verify the deploy actually landed. If the response
  // doesn't include `x-chat-trace`, prod is serving a stale build.
  const TRACE = 'v10-rejection-catch';
  // ABSOLUTE TOP guard: if `?trace=1` is in the URL, short-circuit with a
  // synchronous JSON response that proves the handler is being invoked and
  // the deployed code is the latest. Avoids any DB / parsing / import paths
  // so a module-init crash elsewhere can't mask the trace.
  if (req.nextUrl.searchParams.get('trace') === '1') {
    return new NextResponse(
      JSON.stringify({ ok: true, trace: TRACE, ts: new Date().toISOString() }),
      {
        status: 200,
        headers: {
          'content-type': 'application/json; charset=utf-8',
          'x-chat-trace': TRACE,
        },
      },
    );
  }
  // Tiny per-phase wall-clock log so production slowness becomes diagnosable
  // from Vercel logs without having to attach a profiler. Each phase fires
  // once per request; the cumulative time tells us which step is the actual
  // hot-path dominator (cold-start bundle, DB warmup, LLM first-byte, etc.).
  const t0 = Date.now();
  let lastT = t0;
  // `currentPhase` is also used by the top-level catch to attach a `phase`
  // field to the JSON error response — invaluable for diagnosing prod 500s
  // because Vercel's default behavior for an unhandled throw is an empty
  // body, leaving the client with only the status code.
  let currentPhase = 'init';
  const phase = (name: string) => {
    const now = Date.now();
    currentPhase = name;
    // eslint-disable-next-line no-console
    console.log(`[chat] +${now - lastT}ms / ${now - t0}ms total → ${name}`);
    lastT = now;
  };

  try {

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
  //
  // NOTE: We previously used `import(..., { with: { type: 'json' } })` (the
  // ES2025 import-attributes syntax). Vercel's bundler silently failed to
  // compile this route when that syntax was present — old function bundle
  // kept serving while 5 commits in a row "succeeded" with zero diagnostic.
  // Plain dynamic import works on every Node version we support.
  const registryP = import('@/lib/llm/models.json') as unknown as Promise<{
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
  // `iter` is a SAFETY NET ONLY — it caps runaway infinite tool-call loops
  // but is set high enough (200) that the model never realistically hits it.
  // Per-user explicit guidance was removed (was: 3/6/12/30 with the model
  // being told "you have N tool calls"). The model now decides when it has
  // enough information based on the per-user USD cap + the per-provider
  // daily cap, not a hardcoded iteration ceiling.
  //
  // `usd` is the per-turn USD budget that the model SEES in the prompt; it
  // still scales with effort to give the user a slider for "how deep should
  // this dig go". `maxOutputTokens` is the synthesis cap on the FINAL answer.
  const EFFORT_PRESETS = {
    low: { iter: 200, usd: 0.05, maxOutputTokens: 1500, reasoning: 'low' as const },
    medium: { iter: 200, usd: 0.15, maxOutputTokens: 4000, reasoning: 'medium' as const },
    high: { iter: 200, usd: 0.4, maxOutputTokens: 8000, reasoning: 'high' as const },
    max: { iter: 200, usd: 1.0, maxOutputTokens: 16000, reasoning: 'high' as const },
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
  //
  // CRITICAL: each loadApiKey is wrapped in its own try/catch. A throw from
  // ANY single provider (decryption failure on a stale ciphertext, DB hiccup,
  // etc.) would otherwise reject the Promise.all — and if the rejection
  // landed before a `catch` handler was attached, Node 20's default
  // `--unhandled-rejections=throw` would kill the function with no body
  // → the "empty 500" prod bug. Per-provider catch keeps one bad row from
  // taking down the whole chat.
  const providerKeysP = Promise.all(
    PROVIDERS.map(async (p) => {
      try {
        const key = await loadApiKey(p);
        return { p, key };
      } catch (err) {
        console.error(`[chat] loadApiKey(${p}) failed:`, sanitizeError(err));
        return { p, key: null };
      }
    }),
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
  // Budget brief no longer mentions a tool-call iteration count — the iter
  // ceiling is now a safety net (200) the model shouldn't ever hit. Only
  // the USD budget steers depth. The "end on plain text" rule stays so we
  // never emit a turn that's only tool calls with no synthesis.
  const budgetBrief =
    `BUDGET (this turn only, resets each user message; earlier-turn tool calls don't count): ` +
    `$${effectiveUsd.toFixed(2)} cap. ` +
    `LAST step must be plain text — never end on a tool call. Synthesize a final answer once you have enough evidence.`;

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
    persistAssistant('abort').catch(() => undefined);
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
      recordAttemptAudit(attempt.provider, lastStatus, Date.now() - start).catch(() => undefined);
      // Different provider next in the chain → continue. If this was the
      // primary and no fallbacks were provided, fall through to the 400.
      if (!isLast) continue;
      return NextResponse.json({ error: sanitizeError(lastError) }, { status: lastStatus });
    }

    // --- Per-attempt: budget check (per-provider DAILY bucket) ----------------
    // We compare today's accumulated spend for this provider against the
    // env-driven daily cap (PROVIDER_DAILY_USD_CAP_<PROVIDER>, default $50).
    // The earlier code passed the per-turn `usdCap` ($0.15 at medium effort)
    // here — that's a different axis and meant ALL chats failed once daily
    // spend crossed the per-turn budget. Admins bypass entirely.
    try {
      await checkBudgetOrThrow(
        attempt.provider,
        0,
        getProviderDailyCap(attempt.provider),
        { isAdmin: sessionUser.isAdmin },
      );
    } catch (e) {
      lastStatus = 429;
      lastError = e;
      recordAttemptAudit(attempt.provider, lastStatus, Date.now() - start).catch(() => undefined);
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
      // Sanitize first: pair every assistant tool-call with either its real
      // tool-result or a synthetic "aborted" stub so convertToModelMessages
      // doesn't reject the history with "Tool results are missing for tool
      // calls X, Y, Z". See sanitizeOrphanToolCalls at top of file.
      const cleanMessages = sanitizeOrphanToolCalls(messages as never as ChatMessage[]);
      // convertToModelMessages is async in this SDK version — must await.
      const modelMessages = (await convertToModelMessages(
        cleanMessages as never,
      )) as ModelMessage[];
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
      recordAttemptAudit(attempt.provider, status, Date.now() - start).catch(() => undefined);
      if (!isLast && isRetriableStartError(e)) continue;
      return NextResponse.json({ error: sanitizeError(e) }, { status: status || 500 });
    }

    // streamText returned without throwing — commit. Audit success and
    // hand the body to the client. Note we audit BEFORE returning so the
    // row's latency reflects "time to first byte", not the full stream.
    recordAttemptAudit(attempt.provider, 200, Date.now() - start).catch(() => undefined);
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
  } catch (err) {
    // LAST-LINE BACKSTOP. Bulletproof: build the body manually so no helper
    // can render it empty. Sanitize-fail and JSON-stringify-fail are both
    // wrapped with their own try/catch so an unhappy `detail` object can
    // never collapse to a Content-Length:0 response again (the bug that
    // surfaced as "chat returns empty 500" on prod).
    let message = 'unknown error';
    let stack: string | undefined;
    try {
      if (err instanceof Error) {
        message = err.message || err.name || 'unknown error';
        stack = err.stack;
      } else if (typeof err === 'string') {
        message = err;
      } else if (err && typeof err === 'object') {
        message = String((err as { message?: unknown }).message ?? JSON.stringify(err));
      }
    } catch {
      /* fall back to defaults */
    }
    // eslint-disable-next-line no-console
    console.error(`[chat] uncaught in phase=${currentPhase}: ${message}${stack ? '\n' + stack : ''}`);
    let body: string;
    try {
      body = JSON.stringify({
        error: message,
        phase: currentPhase,
        // Helpful flag so the client UI can show "this was a server bug, not
        // user error" — never trust empty 500s again.
        kind: 'server_exception',
      });
    } catch {
      body = '{"error":"chat failed","phase":"unknown","kind":"server_exception"}';
    }
    return new NextResponse(body, {
      status: 500,
      headers: { 'content-type': 'application/json; charset=utf-8' },
    });
  }
}

// ---------- DB helpers ----------

async function createChat(
  tab: 'research' | 'analysis',
  stockId: number | undefined,
  modelId: string,
  sessionId?: string | null,
  userId?: number | null,
): Promise<number> {
  const [row] = await db
    .insert(chats)
    .values({
      tab,
      stockId: stockId ?? null,
      // True per-user owner. Pass-through from the route's authenticated
      // session — without this, deleting a stock orphans the chat forever
      // (the stock_id FK is ON DELETE SET NULL). Optional so legacy
      // call-sites that haven't been threaded with the session userId yet
      // still compile; those produce orphan rows the cleanup pass can't
      // reach, so callers should always supply userId in new code.
      userId: userId ?? null,
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
  /** Optional — passed through to createChat so new chats are owned. */
  userId?: number | null;
}): Promise<number> {
  const { chatIdIn, sessionIdIn, tab, stockId, modelId, userId } = args;

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
    return createChat(tab, stockId, modelId, sessionIdIn, userId);
  }

  return createChat(tab, stockId, modelId, null, userId);
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

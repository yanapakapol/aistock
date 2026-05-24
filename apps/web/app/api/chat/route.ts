import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { streamText, generateText, convertToModelMessages, type ModelMessage } from 'ai';

import { db } from '@/lib/db/client';
import { chats, chatMessages, outboundAudit, stocks, type messageRoleEnum } from '@/lib/db/schema';
import { eq } from 'drizzle-orm';

import { PROVIDERS, LLM_HOSTS, type Provider } from '@/lib/llm/providers';
import { loadApiKey } from '@/lib/llm/keys';
import { clientFor } from '@/lib/llm/clientFor';

// Cross-team modules — interfaces only; concrete code lives in other agents' PRs.
import { TOOLS } from '@/lib/mcp/tools';
import { toAiSdkTool } from '@/lib/mcp/adapters/aiSdk';
import { scrubSecrets, sanitizeError } from '@/lib/security/scrub';
import { meter } from '@/lib/cost/meter';
import { addSpend, checkBudgetOrThrow } from '@/lib/cost/ledger';

export const runtime = 'nodejs';
// Long-running streams shouldn't be capped by default vercel limits.
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
  // CSRF: only allow same-origin browser calls.
  const sfs = req.headers.get('sec-fetch-site');
  if (sfs && sfs !== 'same-origin' && sfs !== 'none') {
    return NextResponse.json({ error: 'cross-site blocked' }, { status: 403 });
  }

  let body: z.infer<typeof BodySchema>;
  try {
    const json = await req.json();
    const parsed = BodySchema.safeParse(json);
    if (!parsed.success) {
      console.error('[chat] body validation failed:', parsed.error.issues);
      console.error('[chat] received body keys:', Object.keys(json ?? {}));
      return NextResponse.json(
        { error: 'invalid request', issues: parsed.error.issues },
        { status: 400 },
      );
    }
    body = parsed.data;
  } catch (e) {
    console.error('[chat] body parse failed:', e);
    return NextResponse.json(
      { error: 'invalid request', detail: sanitizeError(e) },
      { status: 400 },
    );
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

  // Find-or-create chat row up-front so onFinish (on whichever attempt wins)
  // persists into a stable id.
  const chatId = await resolveChatId({
    chatIdIn,
    sessionIdIn,
    tab,
    stockId,
    modelId,
  });

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
  const toolsList =
    tab === 'research' && !dbMode
      ? TOOLS.filter((t) => RESEARCH_TOOL_ALLOW.has(t.name))
      : TOOLS;
  const tools = Object.fromEntries(toolsList.map((t) => [t.name, toAiSdkTool(t)]));

  // Build a small system preamble so the model already knows the active stock
  // (avoids it calling search_stocks for a stock that's already in the DB),
  // along with a hard rule against fabricating data.
  let stockCtx = '';
  if (stockId) {
    try {
      const [s] = await db
        .select({ id: stocks.id, symbol: stocks.symbol, exchange: stocks.exchange, name: stocks.name })
        .from(stocks)
        .where(eq(stocks.id, stockId))
        .limit(1);
      if (s) {
        stockCtx =
          `Active stock: stock_id=${s.id}, symbol=${s.symbol}, exchange=${s.exchange}, name="${s.name}". ` +
          `Use stock_id=${s.id} for every DB tool call (get_events, get_prices, get_business_context, search_news, upsert_*). ` +
          `DO NOT call search_stocks for this stock — it is already in the database.`;
      }
    } catch {
      /* non-fatal */
    }
  }
  const researchExtra =
    tab === 'research'
      ? [
          '',
          '',
          'RESEARCH TAB WORKFLOW:',
          dbMode
            ? '  • DB MODE ON: you may also call get_events, get_business_context, get_future_events, get_prices, etc. to consult existing DB rows before writing new ones (use it to avoid duplicating known events).'
            : '  • DB MODE OFF: you CANNOT read from the database (get_events, get_business_context, get_prices etc. are deliberately not in your toolset). Do everything via search_news + your own reasoning, then WRITE the findings.',
          '  • Whenever you call upsert_event, upsert_future_event, or upsert_business_context the row is persisted to Postgres immediately.',
          '  • CRITICAL: you MUST actually CALL the upsert tools (not just describe them). Every article search_news returns with a usable date MUST be persisted via upsert_event before you write any prose. Failure to call the tool when warranted is a violation of these instructions.',
          '  • At the END of every assistant response, append a SINGLE TINY marker on its own line, no other text: "[[SAVED:E=4,F=1,C=1]]" where E=events upserted, F=future_events upserted, C=1 if business_context was updated else 0. If nothing was saved, write "[[SAVED:E=0,F=0,C=0]]". The UI converts this marker into a small green badge — do not write a full sentence.',
          '  • Tell the user they can open the DB panel (top-right "DB" button) to inspect every stored row.',
          '',
          'AUTO-SAVE ALGORITHM (apply on every research turn, do not ask permission):',
          '  1. PAST EVENT — call upsert_event whenever search_news returns an article that BOTH (a) has a non-null published_date AND (b) materially relates to the active stock (mentions ticker/company in title or content). Required fields: stock_id, event_date=published_date, title=article title (≤120 chars), summary_md=2-4 sentence excerpt rewritten in your own words, source_url=URL, sentiment_label∈{bull,bear,neutral}, sentiment_score∈[-1,1] (your judgement).',
          '  2. FUTURE EVENT — call upsert_future_event whenever an article or your prior context implies a dated upcoming catalyst (earnings, FDA decision, trial readout, capital markets day, expiration, election, regulatory deadline). Required: expected_date (best-guess ISO date or month), title, description_md, probability_positive and probability_negative as decimals in [0,1] summing to ≤1 (assign your best estimate; if unknown leave both null), expected_impact_pct (best-guess price impact in pct), source_urls.',
          '  3. BUSINESS CONTEXT — at the END of every research session, before the footer, call upsert_business_context once per section (summary | timeline | future_outlook) with a merged patch_md that integrates findings from THIS session with whatever the tool already has. Keep each section under 1500 chars.',
          '  4. NEVER fabricate a date or URL. If a relevant article lacks a date, SKIP the upsert and report the gap in your reply.',
          '  5. DEDUPE — before upserting, call get_events with the same date window; if a row with matching title already exists, skip rather than insert a duplicate. (Research tab cannot call get_events; rely on consolidate_events at the end instead.)',
          '  6. DATE FALLBACK — when upserting an event, choose event_date in this strict order:',
          '       (a) explicit event date from the article body if stated;',
          '       (b) else the source article\'s published_date;',
          '       (c) else today\'s date (the date the search was performed). NEVER invent a fake earlier date.',
          '  7. CONSOLIDATE — AT THE VERY END of every research turn (after all upserts), call consolidate_events({stock_id, dry_run:false}) ONCE. It groups near-duplicate titles, keeps the row with the newest event_date and the longest insightful summary, and deletes the rest. Then include the returned `deleted` count in the [[SAVED:…]] footer marker.',
        ].join('\n')
      : '';
  const analysisExtra =
    tab === 'analysis'
      ? [
          '',
          '',
          'ANALYSIS TAB WORKFLOW (mandatory order, do not skip):',
          '  Step 1 — Read what we already know from Postgres FIRST: call get_business_context, get_events (limit 20), get_future_events, and get_prices (last 90 days) for the active stock.',
          '  Step 2 — Identify gaps. Only THEN call search_news to fill gaps; do not search news without first checking the DB.',
          '  Step 3 — When you cite a DB event, write [event #ID] inline; when you cite a news article, write [source: hostname]. Always include the full URL in the citations list.',
          '  Step 4 — End every answer with a "Citations" section listing every event_id and source URL you used, as clickable markdown links: "- [event #N — title](source_url)" or "- [news: hostname](url)". If you cited nothing, write "Citations: (none)".',
        ].join('\n')
      : '';
  const budgetBrief =
    `BUDGET (this turn ONLY — resets every new user message; tool calls from earlier turns in the conversation DO NOT count against this budget): ` +
    `tool calls = ${effectiveIter} this turn (one search_news = 1 call; one upsert_event = 1 call), ` +
    `USD cap = $${effectiveUsd.toFixed(2)} this turn. ` +
    `If you see tool-call results in earlier assistant messages, those are HISTORY and free. Your budget here is for NEW tool calls you make in THIS turn. ` +
    `Plan accordingly BEFORE you start: small budget (≤3) → ONE focused search, save 1-2 best events, write a brief answer. ` +
    `Large budget (≥12) → multiple searches across drivers, save many events, write a thorough answer. ` +
    `ABSOLUTE RULE — your VERY LAST step in this turn MUST be a plain text response (no tool call). Never end on a tool call. Reserve at least 2 steps purely for synthesizing the answer. If you would otherwise hit the cap, STOP calling tools at iteration ${Math.max(1, effectiveIter - 1)} and write the answer with what you have. Empty responses are forbidden.`;

  const systemPreamble =
    `You are a stock-research assistant inside the aistock platform. ` +
    budgetBrief +
    ` ` +
    `If you need the current date for any reason (validating "recent", computing "last 6 months", checking if an article is in the future), CALL the get_current_datetime tool — never guess from your training data. The real wall-clock date may be later than what you remember. ` +
    `You have MCP tools for DB reads/writes and news search. ` +
    `Rules: (1) NEVER fabricate, simulate, or hypothesise news/events/prices — only report what tools return. ` +
    `(2) If a tool returns "NEWS SEARCH UNAVAILABLE" or any "no_keys_configured" hint, tell the user verbatim and stop. ` +
    `(3) Always cite event IDs and source URLs when summarizing events. ` +
    `(4) Be concise; avoid ornamental separators (---, ***, ===). Never write "I will now…" or "Proceeding with…" then stop — if you announce a tool call you MUST execute it in the same turn. ` +
    `(5) For tabular data use GFM pipe tables (| col | col |\\n|---|---|\\n| a | b |). ` +
    `For time-series or comparison plots, emit a fenced block tagged \`chart\` with JSON ` +
    `{type:'line'|'bar', title?, xLabel?, yLabel?, data:[{x,y}]} — the UI renders it as SVG.` +
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
  const providersWithKeys: Provider[] = [];
  for (const p of PROVIDERS) {
    const k = await loadApiKey(p);
    if (k) providersWithKeys.push(p);
  }

  // Pull each provider's default model from the fallback registry.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const registry: Record<string, { models?: Array<{ id: string }> }> = (
    (await import('@/lib/llm/models.json', { with: { type: 'json' } })) as unknown as { default: Record<string, { models?: Array<{ id: string }> }> }
  ).default;

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
    const apiKey = await loadApiKey(attempt.provider);
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

    const model = clientFor(attempt.provider, attempt.modelId, apiKey);
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

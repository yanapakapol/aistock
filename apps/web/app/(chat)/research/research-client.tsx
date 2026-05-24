'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useChat } from '@ai-sdk/react';
import { DefaultChatTransport } from 'ai';
import { useRouter, usePathname } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Select } from '@/components/ui/select';
import { HistoryPanel } from '@/components/chat/history-panel';
import { DbSnapshotPanel } from '@/components/chat/db-snapshot-panel';
import { EffortPicker, getStoredEffort, type Effort } from '@/components/chat/effort-picker';
import { MessageList } from '@/components/chat/message-list';
import { Composer } from '@/components/chat/composer';
import { CostPill } from '@/components/chat/cost-pill';
import { useChatCost } from '@/components/chat/use-chat-cost';
import { useChatSession } from '@/components/chat/use-chat-session';
import { useChatPersistence } from '@/components/chat/use-persisted-chat';
import { usePendingChatLoad } from '@/components/chat/use-pending-load';

interface StockLite {
  id: number;
  symbol: string;
  exchange: string;
  name: string;
}

interface Selection {
  provider: string;
  modelId: string;
}

const LS_KEY = 'aistock:model:research';
const DEFAULT_SEL: Selection = { provider: 'anthropic', modelId: 'claude-sonnet-4-6' };

const PLAN_PROMPT_TEMPLATE = (s: StockLite) =>
  `Build a research plan for ${s.symbol} (${s.exchange}) — ${s.name}. ` +
  `List 5–8 primary drivers, then for each driver: search recent news, ` +
  `extract dated events with sources via upsert_event, and note any forward-looking ` +
  `catalysts via upsert_future_event. Cap your tool iterations and summarize when done.`;

const DEEP_RESEARCH_PROMPT = (s: StockLite) =>
  [
    `DEEP RESEARCH PASS for ${s.symbol} (${s.exchange}) — ${s.name}.`,
    `Goal: fully populate every DB section we have. Work systematically; do NOT skip categories.`,
    ``,
    `STRICT EXECUTION RULES (read before doing anything):`,
    `  • Do NOT write a multi-phase plan and stop. Plans without actions are USELESS — execute every phase in this same turn.`,
    `  • Do NOT announce what you "will" do — JUST CALL THE TOOLS. The user sees every tool call as a live chip; that IS the progress report.`,
    `  • Only write prose AFTER all tool work is done, and keep it short. The chip strip already shows the journey.`,
    `  • If you find yourself typing "I will now…" or "Proceeding with…", STOP TYPING and CALL THE NEXT TOOL instead.`,
    ``,
    `Phase 1 — Inventory: call get_business_context, get_events (limit 50), get_future_events. (Skip get_prices unless you actually need it.)`,
    ``,
    `Phase 2 — Drivers: enumerate 6–10 distinct price drivers internally — do NOT list them in prose yet.`,
    ``,
    `Phase 3 — For EACH driver, in the same turn:`,
    `  (a) search_news with a driver-specific query (last 18 months). Multiple calls per driver if first query is thin.`,
    `  (b) For every relevant returned article: upsert_event NOW (do not batch the description, call the tool).`,
    `  (c) Identify forward catalysts → upsert_future_event NOW.`,
    ``,
    `Phase 4 — Synthesize: call upsert_business_context for each of {summary, timeline, future_outlook}.`,
    ``,
    `Phase 5 — Call consolidate_events({stock_id: ${s.id}, dry_run: false}) once.`,
    ``,
    `Phase 6 — Final reply: 5–10 bullet summary citing event IDs and source URLs, then the [[SAVED:E=…,F=…,C=…]] marker.`,
    ``,
    `Budget: up to 40 tool calls. If you hit the limit, stop cleanly with what you have.`,
  ].join('\n');

export function ResearchClient({ stock }: { stock: StockLite | null }) {
  const [sel, setSel] = useState<Selection>(DEFAULT_SEL);
  const [hydrated, setHydrated] = useState(false);
  const [input, setInput] = useState('');
  const [portfolio, setPortfolio] = useState<StockLite[]>([]);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [dbOpen, setDbOpen] = useState(false);
  const effortRef = useRef<Effort>('medium');
  const [dbMode, setDbMode] = useState<boolean>(false);
  // Persist per stock so each stock remembers its own DB-mode preference.
  useEffect(() => {
    const k = `aistock:dbMode:research:${stock?.id ?? 'global'}`;
    try {
      const raw = localStorage.getItem(k);
      setDbMode(raw === '1');
    } catch {
      /* ignore */
    }
  }, [stock?.id]);
  function toggleDbMode() {
    setDbMode((v) => {
      const next = !v;
      try {
        localStorage.setItem(
          `aistock:dbMode:research:${stock?.id ?? 'global'}`,
          next ? '1' : '0',
        );
      } catch {
        /* ignore */
      }
      return next;
    });
  }
  const router = useRouter();
  const pathname = usePathname();

  // Load portfolio for the in-header stock switcher.
  useEffect(() => {
    void fetch('/api/portfolio')
      .then((r) => r.json() as Promise<{ stocks: StockLite[] }>)
      .then((j) => {
        const list = j.stocks ?? [];
        setPortfolio(list);
        // Auto-select last-used stock if no ?stock= in URL.
        if (!stock && list.length > 0) {
          let id: number | undefined;
          try {
            const raw = localStorage.getItem('aistock:lastStock:research');
            if (raw) id = Number(raw);
          } catch {
            /* ignore */
          }
          const picked = (id && list.find((s) => s.id === id)) || list[0];
          if (picked) {
            router.replace(`${pathname}?stock=${picked.id}` as never);
          }
        }
      })
      .catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Remember the active stock so a future visit auto-selects it.
  useEffect(() => {
    if (stock?.id == null) return;
    try {
      localStorage.setItem('aistock:lastStock:research', String(stock.id));
    } catch {
      /* ignore */
    }
  }, [stock?.id]);

  useEffect(() => {
    try {
      const raw = localStorage.getItem(LS_KEY);
      if (raw) setSel(JSON.parse(raw) as Selection);
    } catch {
      /* ignore */
    }
    setHydrated(true);
  }, []);

  const { sessionId, chatId, setChatId, reset: resetSession } = useChatSession();

  // Hydrate effort on mount.
  useEffect(() => {
    effortRef.current = getStoredEffort('research');
  }, []);

  // Keep body in a ref so the transport instance stays stable across renders.
  // Recreating transport on every prop change makes useChat thrash and the
  // page can freeze.
  const bodyRef = useRef<Record<string, unknown>>({
    provider: sel.provider,
    modelId: sel.modelId,
    tab: 'research' as const,
    stockId: stock?.id,
    sessionId,
    chatId: chatId ?? undefined,
    effort: effortRef.current,
    dbMode,
  });
  bodyRef.current = {
    provider: sel.provider,
    modelId: sel.modelId,
    tab: 'research' as const,
    stockId: stock?.id,
    sessionId,
    chatId: chatId ?? undefined,
    effort: effortRef.current,
    dbMode,
  };

  const transport = useMemo(
    () =>
      new DefaultChatTransport({
        api: '/api/chat',
        prepareSendMessagesRequest: ({ messages: msgs }) => {
          // Read live refs at SEND time — bodyRef is rebuilt every render but
          // EffortPicker changes don't re-render the parent, so we always
          // sync effort directly from effortRef here.
          const b: Record<string, unknown> = {
            ...bodyRef.current,
            effort: effortRef.current,
          };
          if (!b.sessionId) delete b.sessionId;
          if (b.chatId == null) delete b.chatId;
          if (b.stockId == null) delete b.stockId;
          return { body: { messages: msgs, ...b } };
        },
      }),
    [],
  );

  const { messages, sendMessage, status, setMessages, stop } = useChat({ transport });

  // History load via ?loadChat=<id> URL param (most reliable restore path).
  usePendingChatLoad({
    onApply: (id, msgs) => {
      setChatId(id);
      setMessages(msgs as never);
    },
  });

  // Persistence: restore on mount + scope change, save on every update.
  const { hydrated: persistHydrated, initial, persist, clear } = useChatPersistence({
    tab: 'research',
    scope: stock?.id ?? null,
  });
  const restoredRef = useRef(false);
  useEffect(() => {
    if (!persistHydrated || restoredRef.current) return;
    restoredRef.current = true;
    if (initial?.chatId != null) setChatId(initial.chatId);
    if (initial?.messages && initial.messages.length > 0) {
      setMessages(initial.messages as never);
    }
  }, [persistHydrated, initial, setChatId, setMessages]);
  // Persist whenever messages or chatId change.
  useEffect(() => {
    if (!persistHydrated) return;
    persist({
      sessionId,
      chatId,
      messages: messages as unknown as Array<Record<string, unknown>>,
    });
  }, [messages, chatId, sessionId, persist, persistHydrated]);

  const streaming = status === 'streaming' || status === 'submitted';
  const { tokensIn, tokensOut, usd } = useChatCost(messages as never[]);

  useEffect(() => {
    if (chatId != null) return;
    for (const raw of messages) {
      const md = (raw as { metadata?: { chatId?: number } } | undefined)?.metadata;
      if (md?.chatId != null) {
        setChatId(md.chatId);
        return;
      }
    }
  }, [messages, chatId, setChatId]);

  function startResearchPlan() {
    if (!stock || streaming) return;
    void sendMessage({ text: PLAN_PROMPT_TEMPLATE(stock) });
  }

  function startDeepResearch() {
    if (!stock || streaming) return;
    // Deep research needs headroom. Force effort=max for THIS turn so the
    // server unlocks 30 tool calls + 16K output tokens. (User's manual
    // selection in the picker stays unchanged for follow-up turns.)
    bodyRef.current = { ...bodyRef.current, effort: 'max' };
    void sendMessage({ text: DEEP_RESEARCH_PROMPT(stock) });
    // Restore the user's effort selection for the next turn (after a tick).
    setTimeout(() => {
      bodyRef.current = { ...bodyRef.current, effort: effortRef.current };
    }, 0);
  }

  function saveToDb() {
    if (!stock || streaming) return;
    void sendMessage({
      text:
        `Review every concrete finding from this conversation and PERSIST it to the database now. ` +
        `For each candidate event: (1) call consolidate_events first to see what's already stored and avoid duplicates; ` +
        `(2) if a near-duplicate exists, MERGE by upserting the more insightful summary onto the keeper's event_date; ` +
        `(3) if it's new, upsert_event with date fallback (explicit → published → today); ` +
        `(4) flag any forward-looking catalysts via upsert_future_event; ` +
        `(5) finish with upsert_business_context (summary, timeline, future_outlook) merging this session into the prior context; ` +
        `(6) call consolidate_events({stock_id: ${stock.id}, dry_run: false}) one last time. ` +
        `Reply with a short bulleted list of what was written / merged / skipped + the [[SAVED:...]] footer.`,
    });
  }


  function newChat() {
    setMessages([]);
    resetSession();
    setInput('');
    clear();
  }

  function submitInput(text: string) {
    void sendMessage({ text });
    setInput('');
  }

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center justify-between gap-3 border-b border-border px-6 py-3">
        <div className="flex min-w-0 items-center gap-3">
          <div className="text-sm font-semibold tracking-tight">Research</div>
          <Select
            className="w-72"
            value={stock ? String(stock.id) : ''}
            onChange={(e) => {
              const id = e.target.value;
              if (!id) return;
              router.replace(`${pathname}?stock=${encodeURIComponent(id)}` as never);
            }}
          >
            <option value="" disabled>
              {portfolio.length === 0 ? 'No stocks — add in Portfolio' : 'Select a stock…'}
            </option>
            {portfolio.map((s) => (
              <option key={s.id} value={String(s.id)}>
                {s.symbol} · {s.exchange} — {s.name}
              </option>
            ))}
          </Select>
          <div className="truncate text-xs text-muted-foreground">
            {sel.provider} · {sel.modelId}
          </div>
        </div>
        <div className="flex items-center gap-2">
          {stock && messages.length === 0 ? (
            <Button size="sm" onClick={startResearchPlan} disabled={!hydrated}>
              Quick plan
            </Button>
          ) : null}
          {stock ? (
            <Button
              size="sm"
              variant="outline"
              onClick={startDeepResearch}
              disabled={!hydrated || streaming}
              title="Run a full multi-pass research loop that populates every DB section (events, future events, business context)."
            >
              Deep research
            </Button>
          ) : null}
          {stock && messages.length > 0 ? (
            <Button
              size="sm"
              variant="outline"
              onClick={saveToDb}
              disabled={streaming}
              title="Force the AI to persist current findings: dedupe, merge, upsert events / future events / business context."
            >
              Save to DB
            </Button>
          ) : null}
          {messages.length > 0 ? (
            <Button size="sm" variant="outline" onClick={newChat} disabled={streaming}>
              New chat
            </Button>
          ) : null}
          <EffortPicker
            tab="research"
            onChange={(e) => {
              effortRef.current = e;
            }}
          />
          <button
            type="button"
            onClick={toggleDbMode}
            title={
              dbMode
                ? 'DB read tools are AVAILABLE this turn. Click to disable.'
                : 'Research is DB-blind (default). Click to allow the AI to read existing DB rows.'
            }
            className={
              dbMode
                ? 'inline-flex items-center gap-1 rounded-md border border-green-500/50 bg-green-500/15 px-2 py-0.5 text-[10px] font-semibold text-green-300'
                : 'inline-flex items-center gap-1 rounded-md border border-border bg-muted/30 px-2 py-0.5 text-[10px] font-medium text-muted-foreground hover:text-foreground'
            }
          >
            <span className="inline-block h-1.5 w-1.5 rounded-full bg-current" />
            DB {dbMode ? 'on' : 'off'}
          </button>
          <Button size="sm" variant="outline" onClick={() => setHistoryOpen(true)}>
            History
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => setDbOpen(true)}
            disabled={!stock}
            title={stock ? 'Inspect raw Postgres rows for this stock' : 'Select a stock first'}
          >
            DB
          </Button>
        </div>
      </header>
      <DbSnapshotPanel stockId={stock?.id} open={dbOpen} onClose={() => setDbOpen(false)} />
      <HistoryPanel
        tab="research"
        stockId={stock?.id ?? null}
        open={historyOpen}
        onClose={() => setHistoryOpen(false)}
        onLoad={(id, msgs) => {
          setChatId(id);
          setMessages(msgs as never[]);
        }}
      />

      <div className="flex-1 overflow-y-auto">
        {messages.length === 0 ? (
          <EmptyState hasStock={!!stock} />
        ) : (
          <MessageList messages={messages as never[]} streaming={streaming} />
        )}
      </div>

      <Composer
        value={input}
        onChange={setInput}
        onSubmit={submitInput}
        onStop={stop}
        isLoading={streaming}
        disabled={!hydrated}
        placeholder={stock ? `Ask about ${stock.symbol}…` : 'Ask anything…'}
      />

      <CostPill tokensIn={tokensIn} tokensOut={tokensOut} usd={usd} />
    </div>
  );
}

function EmptyState({ hasStock }: { hasStock: boolean }) {
  return (
    <div className="mx-auto flex h-full max-w-2xl flex-col items-center justify-center px-6 text-center">
      <div className="text-sm font-medium">
        {hasStock ? 'Start a research session' : 'No stock selected'}
      </div>
      <div className="mt-1 max-w-md text-xs text-muted-foreground">
        {hasStock
          ? 'Click "Create research plan" to let the AI generate a driver checklist and run a tool-driven research loop, or just ask a question below.'
          : 'Open the Portfolio tab, add a stock, then return here.'}
      </div>
    </div>
  );
}

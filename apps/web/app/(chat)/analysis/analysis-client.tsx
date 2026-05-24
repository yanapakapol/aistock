'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useChat } from '@ai-sdk/react';
import { DefaultChatTransport } from 'ai';
import bubblesData from '@/lib/bubbles.json';
import { BubbleStrip, type Bubble } from '@/components/chat/bubble-strip';
import { StockSwitcher } from '@/components/chat/stock-switcher';
import { MessageList } from '@/components/chat/message-list';
import { Composer } from '@/components/chat/composer';
import { CostPill } from '@/components/chat/cost-pill';
import { useChatCost } from '@/components/chat/use-chat-cost';
import { useChatSession } from '@/components/chat/use-chat-session';
import { useChatPersistence } from '@/components/chat/use-persisted-chat';
import { usePendingChatLoad } from '@/components/chat/use-pending-load';
import { EffortPicker, getStoredEffort, type Effort } from '@/components/chat/effort-picker';
import { Button } from '@/components/ui/button';
import { HistoryPanel } from '@/components/chat/history-panel';
import { DbSnapshotPanel } from '@/components/chat/db-snapshot-panel';

const BUBBLES: Bubble[] = bubblesData as Bubble[];
const LS_MODEL_KEY = 'aistock:model:analysis';

interface ModelSelection {
  provider: string;
  modelId: string;
}

interface PortfolioStock {
  id: number;
  symbol: string;
  exchange: string;
  name: string;
}

interface Props {
  initialSymbol: string | null;
}

function renderPrompt(
  template: string,
  stock: { symbol: string; exchange?: string; name?: string },
) {
  return template
    .replaceAll('{{symbol}}', stock.symbol)
    .replaceAll('{{exchange}}', stock.exchange ?? '')
    .replaceAll('{{name}}', stock.name ?? '');
}

export function AnalysisClient({ initialSymbol }: Props) {
  const [symbol, setSymbol] = useState<string | null>(initialSymbol);
  const [stockMeta, setStockMeta] = useState<PortfolioStock | null>(null);
  const [model, setModel] = useState<ModelSelection | null>(null);
  const [input, setInput] = useState('');
  const [historyOpen, setHistoryOpen] = useState(false);
  const [dbOpen, setDbOpen] = useState(false);
  const effortRef = useRef<Effort>('medium');
  useEffect(() => {
    effortRef.current = getStoredEffort('analysis');
  }, []);

  useEffect(() => {
    try {
      const raw = localStorage.getItem(LS_MODEL_KEY);
      if (raw) setModel(JSON.parse(raw) as ModelSelection);
    } catch {
      /* ignore */
    }
  }, []);

  useEffect(() => {
    setSymbol(initialSymbol);
  }, [initialSymbol]);

  useEffect(() => {
    let cancelled = false;
    void fetch('/api/portfolio')
      .then((r) => r.json() as Promise<{ stocks: PortfolioStock[] }>)
      .then((j) => {
        if (cancelled) return;
        const list = j.stocks ?? [];
        // Auto-select last-used symbol if no ?stock= present.
        if (!symbol && list.length > 0) {
          let last: string | null = null;
          try {
            last = localStorage.getItem('aistock:lastStock:analysis');
          } catch {
            /* ignore */
          }
          const picked =
            (last && list.find((s) => s.symbol === last)) || list[0];
          if (picked) {
            setSymbol(picked.symbol);
            setStockMeta(picked);
            const u = new URL(window.location.href);
            u.searchParams.set('stock', picked.symbol);
            window.history.replaceState({}, '', u.toString());
            return;
          }
        }
        const found = symbol ? list.find((s) => s.symbol === symbol) ?? null : null;
        setStockMeta(found);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [symbol]);

  // Persist last-used symbol.
  useEffect(() => {
    if (!symbol) return;
    try {
      localStorage.setItem('aistock:lastStock:analysis', symbol);
    } catch {
      /* ignore */
    }
  }, [symbol]);

  const { sessionId, chatId, setChatId, reset: resetSession } = useChatSession();

  // Stable transport via a ref so re-renders don't tear down useChat.
  const bodyRef = useRef<Record<string, unknown>>({
    tab: 'analysis' as const,
    stockId: stockMeta?.id ?? null,
    stockSymbol: symbol,
    provider: model?.provider,
    modelId: model?.modelId,
    sessionId,
    chatId: chatId ?? undefined,
    effort: effortRef.current,
  });
  bodyRef.current = {
    tab: 'analysis' as const,
    stockId: stockMeta?.id ?? null,
    stockSymbol: symbol,
    provider: model?.provider,
    modelId: model?.modelId,
    sessionId,
    chatId: chatId ?? undefined,
    effort: effortRef.current,
  };

  const transport = useMemo(
    () =>
      new DefaultChatTransport({
        api: '/api/chat',
        prepareSendMessagesRequest: ({ messages: msgs }) => {
          const b: Record<string, unknown> = {
            ...bodyRef.current,
            effort: effortRef.current,
          };
          if (!b.sessionId) delete b.sessionId;
          if (b.chatId == null) delete b.chatId;
          if (b.stockId == null) delete b.stockId;
          if (b.stockSymbol == null) delete b.stockSymbol;
          if (!b.provider) delete b.provider;
          if (!b.modelId) delete b.modelId;
          return { body: { messages: msgs, ...b } };
        },
      }),
    [],
  );

  const { messages, sendMessage, status, setMessages, stop, error } = useChat({ transport });

  usePendingChatLoad({
    onApply: (id, msgs) => {
      setChatId(id);
      setMessages(msgs as never);
    },
  });

  // Restore / persist messages across page nav.
  const { hydrated: persistHydrated, initial, persist, clear } = useChatPersistence({
    tab: 'analysis',
    scope: stockMeta?.id ?? symbol ?? null,
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

  const newChat = useCallback(() => {
    setMessages([]);
    resetSession();
    setInput('');
    clear();
  }, [setMessages, resetSession, clear]);

  const handleBubble = useCallback(
    (b: Bubble) => {
      if (!symbol) return;
      const text = renderPrompt(b.prompt, {
        symbol,
        exchange: stockMeta?.exchange,
        name: stockMeta?.name,
      });
      void sendMessage({ text });
    },
    [symbol, stockMeta, sendMessage],
  );

  const handleComposerSubmit = useCallback(
    (text: string) => {
      void sendMessage({ text });
      setInput('');
    },
    [sendMessage],
  );

  function saveToDb() {
    if (!stockMeta?.id || streaming) return;
    void sendMessage({
      text:
        `Review every concrete finding from this conversation and PERSIST it now. ` +
        `Call consolidate_events first to see what's stored. For each candidate: if a near-duplicate exists, merge the more insightful summary onto the keeper; else upsert_event with the date-fallback ladder. ` +
        `Add forward catalysts via upsert_future_event. End with upsert_business_context (summary, timeline, future_outlook) and a final consolidate_events({stock_id: ${stockMeta.id}, dry_run:false}). ` +
        `Reply with a short bulleted summary of what was written/merged/skipped.`,
    });
  }

  return (
    <div className="flex h-full flex-col">
      <header className="flex flex-wrap items-center gap-2 border-b border-border px-3 py-2 sm:gap-3 sm:px-4">
        <div className="min-w-0 flex-1 sm:min-w-[240px] sm:max-w-sm">
          <StockSwitcher value={symbol ?? undefined} />
        </div>
        <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground sm:ml-auto sm:gap-3">
          {model ? (
            <span className="rounded-md border border-border px-2 py-1">
              {model.provider} · {model.modelId}
            </span>
          ) : (
            <span className="rounded-md border border-border px-2 py-1">
              No model — set in Settings
            </span>
          )}
          <EffortPicker
            tab="analysis"
            onChange={(e) => {
              effortRef.current = e;
            }}
          />
          {messages.length > 0 ? (
            <Button size="sm" variant="ghost" onClick={newChat} disabled={streaming}>
              New chat
            </Button>
          ) : null}
          {stockMeta?.id && messages.length > 0 ? (
            <Button size="sm" variant="ghost" onClick={saveToDb} disabled={streaming}>
              Save to DB
            </Button>
          ) : null}
          <Button size="sm" variant="ghost" onClick={() => setHistoryOpen(true)}>
            History
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => setDbOpen(true)}
            disabled={!stockMeta?.id}
            title={stockMeta?.id ? 'Inspect raw Postgres rows for this stock' : 'Select a stock first'}
          >
            DB
          </Button>
        </div>
      </header>
      <DbSnapshotPanel stockId={stockMeta?.id} open={dbOpen} onClose={() => setDbOpen(false)} />
      <HistoryPanel
        tab="analysis"
        stockId={stockMeta?.id ?? null}
        open={historyOpen}
        onClose={() => setHistoryOpen(false)}
        onLoad={(id, msgs) => {
          setChatId(id);
          setMessages(msgs as never[]);
        }}
      />

      <div className="border-b border-border px-4 py-2">
        <BubbleStrip bubbles={BUBBLES} onPick={handleBubble} disabled={!symbol || streaming} />
        {!symbol ? (
          <div className="mt-1 text-xs text-muted-foreground">
            Select a stock to enable one-click prompts.
          </div>
        ) : null}
      </div>

      <div className="flex-1 overflow-y-auto">
        <MessageList messages={messages as never[]} streaming={streaming} />
      </div>

      <div className="border-t border-border p-3">
        {error ? (
          <div className="mb-2 text-xs text-red-500">
            {error.message ?? 'Chat error'}
          </div>
        ) : null}
        <Composer
          value={input}
          onChange={setInput}
          onSubmit={handleComposerSubmit}
          onStop={stop}
          isLoading={streaming}
          placeholder={symbol ? `Ask about ${symbol}…` : 'Ask anything…'}
        />
      </div>

      <CostPill tokensIn={tokensIn} tokensOut={tokensOut} usd={usd} />
    </div>
  );
}

'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { X, RefreshCw, Database } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  DbEventsBlock,
  DbFutureEventsBlock,
  DbBusinessContextBlock,
} from './tool-renderers';

interface Snapshot {
  stock: { id: number; symbol: string; exchange: string; name: string };
  events: Array<Record<string, unknown>>;
  future_events: Array<Record<string, unknown>>;
  business_context: Record<string, unknown> | null;
  research_tasks: Array<{
    id: number;
    driver: string;
    status: string;
    updatedAt: string;
  }>;
  prices_summary: {
    count: number;
    fromDate: string | null;
    toDate: string | null;
    latestClose: string | null;
  };
  rag_counts: {
    news_chunks: number;
    research_notes: number;
    business_context_chunks: number;
  };
}

interface Props {
  stockId: number | null | undefined;
  open: boolean;
  onClose: () => void;
}

/**
 * Side panel that dumps EVERY Postgres row tied to the active stock so the
 * user can verify what the AI has actually stored vs invented.
 */
export function DbSnapshotPanel({ stockId, open, onClose }: Props) {
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const cacheKey = stockId ? `aistock:cache:/api/stocks/${stockId}/db-snapshot` : null;
  const refresh = useCallback(async () => {
    if (!stockId) return;
    setLoading(true);
    setErr(null);
    try {
      const r = await fetch(`/api/stocks/${stockId}/db-snapshot`);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const j = (await r.json()) as Snapshot;
      setSnap(j);
      if (cacheKey) {
        try {
          sessionStorage.setItem(cacheKey, JSON.stringify({ ts: Date.now(), v: j }));
        } catch {
          /* ignore */
        }
      }
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [stockId, cacheKey]);

  // Show cached snapshot instantly, refetch in background.
  const lastStockRef = useRef<number | null | undefined>(null);
  useEffect(() => {
    if (!open) return;
    if (cacheKey && lastStockRef.current !== stockId) {
      lastStockRef.current = stockId;
      try {
        const raw = sessionStorage.getItem(cacheKey);
        if (raw) {
          const parsed = JSON.parse(raw) as { v: Snapshot };
          if (parsed?.v) setSnap(parsed.v);
        }
      } catch {
        /* ignore */
      }
    }
    void refresh();
  }, [open, refresh, cacheKey, stockId]);

  if (!open) return null;

  return (
    <div className="absolute inset-y-0 right-0 z-30 flex w-full max-w-full flex-col border-l border-border bg-background shadow-lg sm:w-[460px]">
      <div className="flex items-center justify-between border-b border-border px-3 py-2">
        <div className="flex items-center gap-2 text-sm font-semibold">
          <Database className="h-4 w-4" /> DB snapshot
        </div>
        <button
          type="button"
          onClick={onClose}
          className="rounded-md p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
          aria-label="Close"
        >
          <X className="h-4 w-4" />
        </button>
      </div>
      <div className="flex items-center gap-2 border-b border-border px-3 py-2">
        <Button size="sm" variant="outline" onClick={refresh} disabled={loading || !stockId}>
          <RefreshCw className={loading ? 'h-3.5 w-3.5 animate-spin' : 'h-3.5 w-3.5'} />
          Refresh
        </Button>
        {snap ? (
          <div className="text-[10px] text-muted-foreground">
            {snap.stock.symbol} · {snap.stock.exchange} · {snap.stock.name}
          </div>
        ) : null}
      </div>
      <div className="flex-1 space-y-3 overflow-auto px-3 py-3">
        {!stockId ? (
          <div className="text-xs text-muted-foreground">Select a stock first.</div>
        ) : err ? (
          <div className="text-xs text-red-500">{err}</div>
        ) : loading && !snap ? (
          <div className="text-xs text-muted-foreground">Loading…</div>
        ) : snap ? (
          <>
            <Stat snap={snap} />
            <DbBusinessContextBlock
              output={snap.business_context as never}
              running={false}
            />
            <DbEventsBlock output={{ events: snap.events as never }} running={false} />
            <DbFutureEventsBlock
              output={{ future_events: snap.future_events as never }}
              running={false}
            />
            <TasksBlock tasks={snap.research_tasks} />
          </>
        ) : null}
      </div>
    </div>
  );
}

function Stat({ snap }: { snap: Snapshot }) {
  const items: Array<[string, string | number]> = [
    ['events', snap.events.length],
    ['future events', snap.future_events.length],
    ['research tasks', snap.research_tasks.length],
    [
      'prices',
      snap.prices_summary.count > 0
        ? `${snap.prices_summary.count} bars (${snap.prices_summary.fromDate} → ${snap.prices_summary.toDate})`
        : 0,
    ],
    ['latest close', snap.prices_summary.latestClose ?? '—'],
    ['news chunks', snap.rag_counts.news_chunks],
    ['research note chunks', snap.rag_counts.research_notes],
    ['business-context chunks', snap.rag_counts.business_context_chunks],
  ];
  return (
    <div className="grid grid-cols-2 gap-1 rounded-md border border-border bg-muted/20 p-2 text-[11px]">
      {items.map(([k, v]) => (
        <div key={k} className="flex items-baseline justify-between gap-2">
          <span className="text-muted-foreground">{k}</span>
          <span className="font-mono tabular-nums text-foreground">{String(v)}</span>
        </div>
      ))}
    </div>
  );
}

function TasksBlock({
  tasks,
}: {
  tasks: Array<{ id: number; driver: string; status: string; updatedAt: string }>;
}) {
  if (tasks.length === 0) {
    return (
      <div className="rounded-md border border-border bg-muted/20 px-3 py-2 text-xs text-muted-foreground">
        DB · research_tasks: (empty)
      </div>
    );
  }
  return (
    <div className="space-y-1.5">
      <div className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
        DB · research_tasks · {tasks.length}
      </div>
      {tasks.map((t) => (
        <div
          key={t.id}
          className="flex items-center gap-2 rounded-md border border-border bg-muted/20 px-3 py-1.5 text-xs"
        >
          <span className="min-w-[28px] rounded bg-background px-1 text-center text-[10px] tabular-nums text-muted-foreground">
            #{t.id}
          </span>
          <span className="flex-1 truncate">{t.driver}</span>
          <span
            className={
              t.status === 'done'
                ? 'rounded-full bg-green-500/15 px-2 py-0.5 text-[10px] text-green-400'
                : t.status === 'researching'
                  ? 'rounded-full bg-blue-500/15 px-2 py-0.5 text-[10px] text-blue-400'
                  : t.status === 'failed'
                    ? 'rounded-full bg-red-500/15 px-2 py-0.5 text-[10px] text-red-400'
                    : 'rounded-full bg-muted px-2 py-0.5 text-[10px] text-muted-foreground'
            }
          >
            {t.status}
          </span>
        </div>
      ))}
    </div>
  );
}

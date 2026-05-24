'use client';

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  Activity,
  AlertCircle,
  BarChart3,
  Brain,
  Calendar,
  CalendarClock,
  CheckCircle2,
  Clock,
  Compass,
  FileText,
  Layers,
  Loader2,
  Save,
  Search,
  Settings2,
  Sigma,
  TrendingUp,
  XCircle,
  Zap,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import {
  DbBusinessContextBlock,
  DbEventsBlock,
  DbFutureEventsBlock,
  DbPricesBlock,
  GenericToolBlock,
  SearchNewsBlock,
  pickRenderer,
} from './tool-renderers';

/**
 * One tool-call as the bubble understands it. Fed in from message-bubble.tsx
 * which splits `message.parts` from the AI SDK into typed chunks. `running`
 * mirrors v6's lifecycle states (`input-streaming` / `input-available` =
 * running, `output-available` / `output-error` = settled).
 */
export interface ToolChunk {
  toolName: string;
  toolArgs: unknown;
  toolResult: unknown;
  running: boolean;
  errored: boolean;
}

interface ThinkingCardProps {
  chunks: ToolChunk[];
  /** True while at least one chunk is still in-flight. Drives pulsing + ETA. */
  active: boolean;
  /** True while the assistant message itself is still streaming (parent's `streaming` flag for the latest assistant turn). Used to differentiate "tool finished, model still generating" from "all done". */
  streaming: boolean;
}

/** Icon assigned by tool name. Falls back to a generic gear. */
function ToolIcon({ name, className }: { name: string; className?: string }) {
  const cls = cn('h-3.5 w-3.5', className);
  const map: Record<string, ReactNode> = {
    search_news: <Search className={cls} />,
    search_stocks: <Compass className={cls} />,
    get_events: <Calendar className={cls} />,
    upsert_event: <Save className={cls} />,
    get_future_events: <CalendarClock className={cls} />,
    upsert_future_event: <Save className={cls} />,
    get_business_context: <FileText className={cls} />,
    upsert_business_context: <Save className={cls} />,
    consolidate_events: <Layers className={cls} />,
    get_prices: <TrendingUp className={cls} />,
    get_prices_intraday: <TrendingUp className={cls} />,
    get_fundamentals: <BarChart3 className={cls} />,
    correlate_event_price: <Sigma className={cls} />,
    create_routine: <Zap className={cls} />,
    get_current_datetime: <Clock className={cls} />,
  };
  return (map[name] as ReactNode) ?? <Settings2 className={cls} />;
}

/** Friendly caption fragments — used both in the headline summary and chip tooltips. */
function describeChunk(c: ToolChunk): string {
  const name = c.toolName;
  const args = (c.toolArgs ?? {}) as Record<string, unknown>;
  const q = typeof args.query === 'string' ? args.query : null;
  const title = typeof args.title === 'string' ? args.title : null;
  const symbol = typeof args.symbol === 'string' ? args.symbol : null;
  switch (name) {
    case 'search_news':
      return q ? `Searching news for "${truncate(q, 60)}"` : 'Searching news';
    case 'search_stocks':
      return q ? `Looking up "${truncate(q, 40)}"` : 'Looking up symbol';
    case 'upsert_event':
      return title ? `Saving event "${truncate(title, 40)}"` : 'Saving event';
    case 'upsert_future_event':
      return title ? `Saving future event "${truncate(title, 40)}"` : 'Saving future event';
    case 'upsert_business_context':
      return 'Updating business context';
    case 'consolidate_events':
      return 'Consolidating duplicates';
    case 'get_events':
      return symbol ? `Reading events for ${symbol}` : 'Reading events';
    case 'get_future_events':
      return symbol ? `Reading future events for ${symbol}` : 'Reading future events';
    case 'get_business_context':
      return symbol ? `Reading business context for ${symbol}` : 'Reading business context';
    case 'get_prices':
    case 'get_prices_intraday':
      return symbol ? `Reading prices for ${symbol}` : 'Reading prices';
    case 'get_fundamentals':
      return symbol ? `Reading fundamentals for ${symbol}` : 'Reading fundamentals';
    case 'correlate_event_price':
      return 'Computing event-vs-price correlation';
    case 'create_routine':
      return 'Scheduling routine';
    case 'get_current_datetime':
      return 'Checking current date';
    default:
      return `Running ${name}`;
  }
}

/**
 * Summarise the entire activity stream into one human line. The model can run
 * 5–15 tools per turn; we condense to "Searching news, found 4 articles,
 * persisting 2 events…". Uses past-tense for done items, present-continuous
 * for the in-flight one.
 */
function summariseActivity(chunks: ToolChunk[], active: boolean): string {
  if (chunks.length === 0) return 'Thinking…';
  // Group by tool name for compact phrasing.
  const groups = new Map<string, { done: number; running: number; lastResultCount?: number }>();
  for (const c of chunks) {
    const g = groups.get(c.toolName) ?? { done: 0, running: 0 };
    if (c.running) g.running += 1;
    else g.done += 1;
    const out = c.toolResult as Record<string, unknown> | null | undefined;
    if (out) {
      if (Array.isArray((out as { results?: unknown[] }).results)) {
        g.lastResultCount = (out as { results: unknown[] }).results.length;
      } else if (Array.isArray((out as { events?: unknown[] }).events)) {
        g.lastResultCount = (out as { events: unknown[] }).events.length;
      } else if (Array.isArray((out as { future_events?: unknown[] }).future_events)) {
        g.lastResultCount = (out as { future_events: unknown[] }).future_events.length;
      }
    }
    groups.set(c.toolName, g);
  }
  const phrases: string[] = [];
  for (const [name, g] of groups) {
    const verb = verbForTool(name);
    if (g.done > 0 && g.lastResultCount != null) {
      phrases.push(`${verb} (${g.done}× → ${g.lastResultCount})`);
    } else if (g.done > 0) {
      phrases.push(`${verb} (${g.done}×)`);
    } else if (g.running > 0) {
      phrases.push(`${verb}…`);
    }
  }
  const joined = phrases.join(' · ');
  if (!active) return joined || 'Done';
  return joined ? `${joined} · still working…` : 'Thinking…';
}

function verbForTool(name: string): string {
  switch (name) {
    case 'search_news':
      return 'searched news';
    case 'search_stocks':
      return 'looked up symbol';
    case 'upsert_event':
      return 'saved events';
    case 'upsert_future_event':
      return 'saved future events';
    case 'upsert_business_context':
      return 'updated context';
    case 'consolidate_events':
      return 'consolidated';
    case 'get_events':
      return 'read events';
    case 'get_future_events':
      return 'read future events';
    case 'get_business_context':
      return 'read context';
    case 'get_prices':
    case 'get_prices_intraday':
      return 'read prices';
    case 'get_fundamentals':
      return 'read fundamentals';
    case 'correlate_event_price':
      return 'correlated';
    case 'create_routine':
      return 'scheduled routine';
    case 'get_current_datetime':
      return 'checked date';
    default:
      return name;
  }
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return s.slice(0, n - 1) + '…';
}

/**
 * Per-chunk timing. Keyed by chunk index (insertion order is stable within an
 * assistant turn) — when a chunk transitions running→settled we record the
 * elapsed wall-clock. Used to compute avg-per-tool, which feeds the ETA.
 */
interface Timing {
  startedAt: number;
  endedAt?: number;
}

export function ThinkingCard({ chunks, active, streaming }: ThinkingCardProps) {
  const [openIdx, setOpenIdx] = useState<number | null>(null);
  // Default-collapsed once everything finishes, to keep older turns compact.
  // While anything is still active, force-expand so the user sees live work.
  const [bodyOpen, setBodyOpen] = useState<boolean>(true);
  // Once the whole turn settles, auto-collapse once (user can re-open).
  const autoCollapsedRef = useRef(false);
  useEffect(() => {
    if (!active && !streaming && !autoCollapsedRef.current) {
      autoCollapsedRef.current = true;
      setBodyOpen(false);
    }
    if (active || streaming) {
      autoCollapsedRef.current = false;
      setBodyOpen(true);
    }
  }, [active, streaming]);

  // Track per-chunk start/end times by chunk index. Recomputed each render —
  // ref-backed so we don't re-trigger effects mid-stream.
  const timingsRef = useRef<Map<number, Timing>>(new Map());
  const now = Date.now();
  chunks.forEach((c, idx) => {
    const existing = timingsRef.current.get(idx);
    if (!existing) {
      timingsRef.current.set(idx, { startedAt: now });
    }
    if (!c.running && existing && existing.endedAt == null) {
      existing.endedAt = now;
    }
  });

  // Force a 1-Hz re-render while anything is running so the running-elapsed
  // duration ticks up in the UI without us listening to every keystroke.
  const [, force] = useState(0);
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => force((v) => (v + 1) % 1_000_000), 1000);
    return () => clearInterval(t);
  }, [active]);

  const stats = useMemo(() => {
    const done = chunks.filter((c) => !c.running).length;
    const running = chunks.filter((c) => c.running).length;
    const failed = chunks.filter((c) => c.errored).length;
    const durations: number[] = [];
    for (let i = 0; i < chunks.length; i++) {
      const t = timingsRef.current.get(i);
      if (t?.endedAt != null) durations.push(t.endedAt - t.startedAt);
    }
    const avgMs = durations.length > 0 ? durations.reduce((a, b) => a + b, 0) / durations.length : null;
    // Best-effort total: completed steps + currently running + a 1-step buffer
    // for "the model probably wants to call one more thing". Capped so it can
    // never display "Step 5 of 4" — we floor `total` at `done + running`.
    const totalEstimate = active ? Math.max(done + running + (streaming ? 1 : 0), done + running) : done;
    return { done, running, failed, avgMs, totalEstimate };
  }, [chunks, active, streaming, now]);

  const progressPct = stats.totalEstimate === 0 ? 0 : (stats.done / stats.totalEstimate) * 100;
  const etaSeconds = (() => {
    if (!active || stats.avgMs == null) return null;
    const remaining = Math.max(0, stats.totalEstimate - stats.done);
    if (remaining === 0) return null;
    return Math.round((stats.avgMs * remaining) / 1000);
  })();

  const summary = summariseActivity(chunks, active);
  // The card grows visually with the model's activity. Soft gradient + brighter
  // border when active to draw attention; settles to muted styling once done.
  return (
    <div
      className={cn(
        'rounded-xl border px-4 py-3 transition-colors',
        active
          ? 'border-blue-500/40 bg-gradient-to-br from-blue-500/10 via-background to-purple-500/5 shadow-sm shadow-blue-500/10'
          : 'border-border bg-muted/20',
      )}
    >
      {/* Header: brain icon + status text + collapse toggle. */}
      <button
        type="button"
        onClick={() => setBodyOpen((v) => !v)}
        className="flex w-full items-center gap-2 text-left"
        aria-expanded={bodyOpen}
      >
        <div
          className={cn(
            'flex h-7 w-7 shrink-0 items-center justify-center rounded-full',
            active ? 'bg-blue-500/20 text-blue-300' : 'bg-muted/50 text-muted-foreground',
          )}
        >
          {active ? <Loader2 className="h-4 w-4 animate-spin" /> : <Brain className="h-4 w-4" />}
        </div>
        <div className="min-w-0 flex-1">
          <div
            className={cn(
              'truncate text-xs font-semibold',
              active ? 'text-blue-300' : 'text-foreground',
            )}
          >
            {active ? 'Thinking & researching' : `Process · ${stats.done} step${stats.done === 1 ? '' : 's'}`}
          </div>
          <div className="mt-0.5 truncate text-[11px] text-muted-foreground">{summary}</div>
        </div>
        <div className="flex shrink-0 items-center gap-2 text-[10px] text-muted-foreground">
          {stats.failed > 0 ? (
            <span className="inline-flex items-center gap-1 text-red-400">
              <AlertCircle className="h-3 w-3" /> {stats.failed}
            </span>
          ) : null}
          <span className="font-mono tabular-nums">
            {stats.done}
            {active ? `/${stats.totalEstimate}` : ''}
          </span>
          <Activity className={cn('h-3.5 w-3.5', bodyOpen ? 'rotate-0' : 'opacity-60')} />
        </div>
      </button>

      {bodyOpen ? (
        <>
          {/* Progress bar + ETA. While anything is running, also show
              indeterminate-bar overlay so movement is visible even before
              the first tool settles. */}
          <div className="mt-3">
            <div className="relative h-1.5 w-full overflow-hidden rounded-full bg-muted/40">
              <div
                className={cn(
                  'h-full rounded-full transition-all duration-500 ease-out',
                  active ? 'bg-blue-500/80' : 'bg-foreground/30',
                )}
                style={{ width: `${Math.min(100, Math.max(progressPct, active && stats.done === 0 ? 6 : 0))}%` }}
              />
              {active && stats.done === 0 ? (
                // No completed work yet — slide a highlight so the bar feels alive.
                <div className="indeterminate-bar absolute inset-0 h-full w-full rounded-full opacity-60" />
              ) : null}
            </div>
            <div className="mt-1 flex items-center justify-between text-[10px] text-muted-foreground">
              <span>
                {active
                  ? `Step ${Math.min(stats.done + 1, stats.totalEstimate)} of ${stats.totalEstimate}`
                  : `${stats.done} step${stats.done === 1 ? '' : 's'} complete`}
              </span>
              <span className="tabular-nums">
                {etaSeconds != null ? `~${formatSeconds(etaSeconds)} remaining` : active ? 'estimating…' : ''}
                {!active && stats.avgMs != null
                  ? `avg ${(stats.avgMs / 1000).toFixed(1)}s/step`
                  : null}
              </span>
            </div>
          </div>

          {/* Chip strip. Horizontally scrolls on narrow mobile widths. */}
          <div className="thin-scroll mt-3 flex max-w-full flex-wrap gap-1.5 overflow-x-auto pb-1 sm:flex-nowrap">
            {chunks.map((c, i) => {
              const isOpen = openIdx === i;
              const t = timingsRef.current.get(i);
              const elapsedMs =
                t?.endedAt != null
                  ? t.endedAt - t.startedAt
                  : t != null
                    ? now - t.startedAt
                    : null;
              return (
                <button
                  key={i}
                  type="button"
                  onClick={() => setOpenIdx(isOpen ? null : i)}
                  title={describeChunk(c)}
                  className={cn(
                    'inline-flex shrink-0 items-center gap-1.5 rounded-full border px-2.5 py-1 text-[10.5px] font-medium transition-all',
                    c.errored
                      ? 'border-red-500/50 bg-red-500/10 text-red-300'
                      : c.running
                        ? 'border-blue-500/50 bg-blue-500/15 text-blue-200 shadow-sm shadow-blue-500/20'
                        : isOpen
                          ? 'border-foreground/40 bg-accent text-foreground'
                          : 'border-border bg-muted/40 text-muted-foreground hover:border-foreground/30 hover:text-foreground',
                    c.running && 'animate-pulse',
                  )}
                >
                  <ToolIcon name={c.toolName} className={cn(c.running && 'animate-spin-slow')} />
                  <span className="max-w-[180px] truncate font-mono">{c.toolName}</span>
                  {c.errored ? (
                    <XCircle className="h-3 w-3" />
                  ) : c.running ? (
                    <Loader2 className="h-3 w-3 animate-spin" />
                  ) : (
                    <CheckCircle2 className="h-3 w-3 text-green-400" />
                  )}
                  {elapsedMs != null && elapsedMs > 600 ? (
                    <span className="font-mono text-[9.5px] tabular-nums opacity-70">
                      {(elapsedMs / 1000).toFixed(elapsedMs > 9_500 ? 0 : 1)}s
                    </span>
                  ) : null}
                </button>
              );
            })}
          </div>

          {/* Expanded chip detail. */}
          {openIdx != null && chunks[openIdx] ? (
            <div className="mt-3 rounded-lg border border-border/70 bg-background/40 p-2">
              {(() => {
                const c = chunks[openIdx]!;
                const renderer = pickRenderer(c.toolName);
                switch (renderer) {
                  case 'news':
                    return <SearchNewsBlock output={(c.toolResult as never) ?? null} running={c.running} />;
                  case 'events':
                    return <DbEventsBlock output={(c.toolResult as never) ?? null} running={c.running} />;
                  case 'future':
                    return <DbFutureEventsBlock output={(c.toolResult as never) ?? null} running={c.running} />;
                  case 'context':
                    return <DbBusinessContextBlock output={(c.toolResult as never) ?? null} running={c.running} />;
                  case 'prices':
                    return <DbPricesBlock output={(c.toolResult as never) ?? null} running={c.running} />;
                  default:
                    return (
                      <GenericToolBlock
                        name={c.toolName}
                        args={c.toolArgs}
                        result={c.toolResult}
                        running={c.running}
                      />
                    );
                }
              })()}
            </div>
          ) : null}
        </>
      ) : null}

    </div>
  );
}

function formatSeconds(s: number): string {
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return rem === 0 ? `${m}m` : `${m}m ${rem}s`;
}

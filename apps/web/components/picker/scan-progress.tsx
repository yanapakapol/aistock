'use client';

import { useEffect, useState } from 'react';
import { cn } from '@/lib/utils';

// ---------------------------------------------------------------------------
// PUBLIC CONTRACT — the SSE producer (/api/picker/scan) must emit events with
// this exact shape. picker-client subscribes to the stream and passes the
// accumulated events array down through StockCardGrid → ScanProgress.
//
// `at` is a millisecond epoch timestamp so we can render relative timings
// without trusting the wall clock on the client. `startedAt` is the same.
// ---------------------------------------------------------------------------
export type ScanEvent =
  | {
      type: 'phase';
      name: string;
      detail: string;
      query?: number;
      of?: number;
      count?: number;
      at: number;
    }
  | { type: 'error'; message: string; at: number };

interface Props {
  events: ScanEvent[];
  startedAt: number;
}

// Known phases each contribute roughly 1/6 of total progress. Searches are
// the long tail (N parallel queries), so we treat them as a single weighted
// slice and use query/of to fill within that slice — that keeps the bar
// monotonic even when search events arrive out of order.
//
// Order matters: progress() walks this list and stops at the latest seen
// phase, so e.g. a `sources` event implies all prior phases are done even if
// some were dropped by the stream.
const PHASE_ORDER = [
  'resolve-markets',
  'search',
  'sources',
  'llm',
  'result',
] as const;
type KnownPhase = (typeof PHASE_ORDER)[number];

const PHASE_WEIGHT = 1 / (PHASE_ORDER.length + 1); // +1 so we never hit 100% until 'result' lands

// Rough wall-clock budget per phase for the ETA estimator. These are tuned
// from observed scan timings (resolve fast, search slow, llm slowest). The
// "remaining" math just subtracts elapsed from the sum of unstarted slices.
const PHASE_ETA_MS: Record<KnownPhase, number> = {
  'resolve-markets': 500,
  search: 18_000,
  sources: 2_000,
  llm: 12_000,
  result: 500,
};

const TOTAL_ETA_MS = Object.values(PHASE_ETA_MS).reduce((a, b) => a + b, 0);

function isKnownPhase(name: string): name is KnownPhase {
  return (PHASE_ORDER as readonly string[]).includes(name);
}

function phaseIcon(name: string): string {
  if (name === 'resolve-markets') return '🌍';
  if (name === 'search') return '🔍';
  if (name === 'sources') return '📚';
  if (name === 'llm') return '🤖';
  if (name === 'result') return '✅';
  return '•';
}

// Compute % complete by finding the furthest phase seen so far, plus partial
// credit inside the `search` slice based on query/of. Caps at 99% so the bar
// only fills completely when a `result` event lands.
function progress(events: ScanEvent[]): number {
  let furthest = -1;
  let searchFrac = 0;
  for (const ev of events) {
    if (ev.type !== 'phase' || !isKnownPhase(ev.name)) continue;
    const idx = PHASE_ORDER.indexOf(ev.name);
    if (idx > furthest) furthest = idx;
    if (ev.name === 'search' && typeof ev.query === 'number' && typeof ev.of === 'number' && ev.of > 0) {
      // Take the highest fraction we've seen — never decrease.
      searchFrac = Math.max(searchFrac, Math.min(ev.query / ev.of, 1));
    }
  }
  if (furthest < 0) return 2; // tiny sliver so the bar is visible immediately
  let pct = (furthest + 1) * PHASE_WEIGHT * 100;
  // If we're currently in the search slice and haven't moved past it, replace
  // the full-slice credit with the partial fraction so the bar grows smoothly
  // as queries complete instead of jumping after the last one.
  const searchIdx = PHASE_ORDER.indexOf('search');
  if (furthest === searchIdx && searchFrac > 0) {
    const base = searchIdx * PHASE_WEIGHT * 100;
    pct = base + PHASE_WEIGHT * 100 * searchFrac;
  }
  const resultSeen = events.some((e) => e.type === 'phase' && e.name === 'result');
  return resultSeen ? 100 : Math.min(pct, 99);
}

// Estimate remaining time from the current phase. Returns seconds rounded
// to the nearest 1s, or null if we're done / have no signal yet.
function estimateRemaining(events: ScanEvent[], elapsedMs: number): number | null {
  const resultSeen = events.some((e) => e.type === 'phase' && e.name === 'result');
  if (resultSeen) return 0;
  const remainingByTotal = Math.max(0, TOTAL_ETA_MS - elapsedMs);
  // If we have no phase signal at all, just project from total budget.
  let latest: KnownPhase | null = null;
  for (const ev of events) {
    if (ev.type === 'phase' && isKnownPhase(ev.name)) latest = ev.name;
  }
  if (!latest) return Math.round(remainingByTotal / 1000);
  // Sum the budgets of all phases at-or-after the latest seen, halved for the
  // current one (assume we're mid-phase on average).
  const idx = PHASE_ORDER.indexOf(latest);
  let budget = PHASE_ETA_MS[latest] / 2;
  for (let i = idx + 1; i < PHASE_ORDER.length; i++) {
    budget += PHASE_ETA_MS[PHASE_ORDER[i] as KnownPhase];
  }
  return Math.max(0, Math.round(budget / 1000));
}

function formatPhaseLabel(ev: Extract<ScanEvent, { type: 'phase' }>): string {
  if (ev.name === 'search' && typeof ev.query === 'number' && typeof ev.of === 'number') {
    return `Search ${ev.query}/${ev.of}: ${ev.detail}`;
  }
  if (ev.name === 'sources' && typeof ev.count === 'number') {
    return `Aggregated ${ev.count} unique articles`;
  }
  if (ev.name === 'llm') {
    return `LLM analysis · ${ev.detail}`;
  }
  if (ev.name === 'resolve-markets') {
    return ev.detail || 'Resolving markets';
  }
  if (ev.name === 'result') {
    return ev.detail || 'Done';
  }
  return ev.detail || ev.name;
}

export function ScanProgress({ events, startedAt }: Props) {
  // Ticking clock so the elapsed timer updates every second without requiring
  // a new event to roll in. Cleared on unmount.
  const [now, setNow] = useState<number>(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  const elapsedMs = Math.max(0, now - startedAt);
  const elapsedSec = Math.floor(elapsedMs / 1000);
  const remainingSec = estimateRemaining(events, elapsedMs);
  const pct = progress(events);

  // Latest event index drives the pulsing border on the active line.
  const lastIdx = events.length - 1;

  return (
    <div className="flex flex-col gap-3 rounded-lg border border-border bg-background p-4">
      {/* Top progress bar */}
      <div
        className="h-2 w-full overflow-hidden rounded-full bg-accent"
        role="progressbar"
        aria-valuenow={Math.round(pct)}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label="Scan progress"
      >
        <div
          className="h-full bg-green-500 transition-[width] duration-500 ease-out"
          style={{ width: `${pct}%` }}
        />
      </div>

      {/* Elapsed / remaining */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
        <span aria-label="elapsed">⏱ Elapsed {elapsedSec}s</span>
        {remainingSec !== null && remainingSec > 0 ? (
          <span>· ~{remainingSec}s remaining</span>
        ) : null}
        <span className="ml-auto tabular-nums">{Math.round(pct)}%</span>
      </div>

      {/* Activity log */}
      <ol className="flex flex-col gap-1.5">
        {events.length === 0 ? (
          <li className="text-xs italic text-muted-foreground">
            Waiting for first event...
          </li>
        ) : null}
        {events.map((ev, i) => {
          const isLatest = i === lastIdx;
          const tsec = Math.max(0, Math.floor((ev.at - startedAt) / 1000));
          if (ev.type === 'error') {
            return (
              <li
                key={i}
                className={cn(
                  'flex items-start gap-2 rounded border px-2 py-1.5 text-xs',
                  'border-red-500/40 bg-red-500/10 text-red-400',
                  isLatest && 'animate-pulse',
                )}
              >
                <span aria-hidden>❌</span>
                <span className="min-w-0 flex-1 break-words">{ev.message}</span>
                <span className="shrink-0 tabular-nums opacity-70">{tsec}s</span>
              </li>
            );
          }
          return (
            <li
              key={i}
              className={cn(
                'flex items-start gap-2 rounded border px-2 py-1.5 text-xs',
                isLatest
                  ? 'border-green-500/40 bg-green-500/5 animate-pulse'
                  : 'border-transparent',
              )}
            >
              <span aria-hidden>{phaseIcon(ev.name)}</span>
              <span className="min-w-0 flex-1 break-words">
                {formatPhaseLabel(ev)}
              </span>
              <span className="shrink-0 tabular-nums text-muted-foreground">
                {tsec}s
              </span>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

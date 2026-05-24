'use client';

import { Component, useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { Trash2, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Select } from '@/components/ui/select';
import { cn } from '@/lib/utils';
import { SearchCombobox, type SearchResult } from '@/components/portfolio/search-combobox';
import { PriceChart, type PricePoint } from '@/components/portfolio/price-chart';
import { usePrefetchHandlers } from '@/components/prefetch-link';

// ---------------------------------------------------------------------------
// ROOT CAUSE OF THE 2026-05 /portfolio CLIENT CRASH ("Application error: a
// client-side exception has occurred"):
//
// Postgres `numeric(18,6)` columns (open/high/low/close in prices_daily) and
// `bigint` (volume) are returned by the drizzle / neon-http pipeline as
// STRINGS, not JS numbers — JSON can't roundtrip BigInt, and numeric is kept
// as text to preserve precision. The previous client typed PriceRow.close as
// `number` and called `last.close.toFixed(2)` directly at render time, which
// threw "last.close.toFixed is not a function" and tripped Next's generic
// error page. The same shape mismatch existed for Stock.id (DB serial →
// number, typed as string here); that one silently broke selection rather
// than crashing because `'5' === 5` is just false.
//
// Fix: normalize rows at the network/cache boundary (`normalizePriceRow`,
// `normalizeStock`) so the render layer can safely treat numeric fields as
// numbers, and correct the Stock.id type to `number`. Also wrap the main
// JSX in a small PortfolioErrorBoundary so any future shape regression
// surfaces a readable error to the user instead of the Vercel chrome.
// ---------------------------------------------------------------------------

interface Stock {
  id: number;
  symbol: string;
  exchange: string;
  name: string;
  currency: string | null;
  addedAt: string;
}

interface PriceRow {
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

type Range = '1M' | '3M' | '6M' | '1Y' | '5Y';

const RANGE_DAYS: Record<Range, number> = { '1M': 30, '3M': 90, '6M': 180, '1Y': 365, '5Y': 1825 };

function isoOffset(days: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Coerce a value that might be string|number|bigint|null|undefined into a
 * JS number. Returns NaN on failure rather than 0 so callers can decide how
 * to handle missing data without confusing it with a real zero price.
 */
function toNum(v: unknown): number {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.length > 0) {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  if (typeof v === 'bigint') return Number(v);
  return Number.NaN;
}

function normalizePriceRow(r: unknown): PriceRow | null {
  if (!r || typeof r !== 'object') return null;
  const o = r as Record<string, unknown>;
  const date = typeof o.date === 'string' ? o.date : null;
  const close = toNum(o.close);
  if (!date || !Number.isFinite(close)) return null;
  return {
    date,
    open: toNum(o.open),
    high: toNum(o.high),
    low: toNum(o.low),
    close,
    volume: toNum(o.volume),
  };
}

function normalizePriceRows(rows: unknown): PriceRow[] {
  if (!Array.isArray(rows)) return [];
  const out: PriceRow[] = [];
  for (const r of rows) {
    const norm = normalizePriceRow(r);
    if (norm) out.push(norm);
  }
  return out;
}

function normalizeStock(s: unknown): Stock | null {
  if (!s || typeof s !== 'object') return null;
  const o = s as Record<string, unknown>;
  const idRaw = o.id;
  const id = typeof idRaw === 'number' ? idRaw : Number(idRaw);
  if (!Number.isFinite(id)) return null;
  return {
    id,
    symbol: typeof o.symbol === 'string' ? o.symbol : '',
    exchange: typeof o.exchange === 'string' ? o.exchange : '',
    name: typeof o.name === 'string' ? o.name : '',
    currency: typeof o.currency === 'string' ? o.currency : null,
    addedAt: typeof o.addedAt === 'string' ? o.addedAt : '',
  };
}

function normalizeStocks(arr: unknown): Stock[] {
  if (!Array.isArray(arr)) return [];
  const out: Stock[] = [];
  for (const s of arr) {
    const norm = normalizeStock(s);
    if (norm) out.push(norm);
  }
  return out;
}

/**
 * Inline error boundary scoped to /portfolio. React's error boundaries
 * *must* be class components — there's no hook equivalent. We render a
 * compact error card with the actual message so the user sees what went
 * wrong instead of the generic Vercel "Application error" page. The page
 * is still recoverable via a hard reload.
 */
interface BoundaryState {
  error: Error | null;
}
class PortfolioErrorBoundary extends Component<{ children: ReactNode }, BoundaryState> {
  override state: BoundaryState = { error: null };
  static getDerivedStateFromError(error: unknown): BoundaryState {
    return { error: error instanceof Error ? error : new Error(String(error)) };
  }
  override componentDidCatch(error: unknown) {
    // Surface in the browser console so a logged-in user can copy the stack.
    // eslint-disable-next-line no-console
    console.error('[PortfolioClient] render error', error);
  }
  override render() {
    if (this.state.error) {
      return (
        <div className="flex h-full items-center justify-center p-6">
          <div className="max-w-md rounded-md border border-red-500/40 bg-red-500/5 p-4 text-sm">
            <div className="font-semibold text-red-500">Failed to load portfolio</div>
            <div className="mt-1 break-words text-muted-foreground">
              {this.state.error.message || 'Unknown render error'}
            </div>
            <button
              type="button"
              onClick={() => window.location.reload()}
              className="mt-3 rounded border border-border px-2 py-1 text-xs hover:bg-accent"
            >
              Reload
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

export function PortfolioClient() {
  return (
    <PortfolioErrorBoundary>
      <PortfolioClientInner />
    </PortfolioErrorBoundary>
  );
}

function PortfolioClientInner() {
  const [stocks, setStocks] = useState<Stock[]>([]);
  const [loadingList, setLoadingList] = useState(true);
  const [listErr, setListErr] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [range, setRange] = useState<Range>('6M');
  const [prices, setPrices] = useState<PriceRow[]>([]);
  const [loadingPrices, setLoadingPrices] = useState(false);
  const [priceErr, setPriceErr] = useState<string | null>(null);
  const [ingesting, setIngesting] = useState(false);
  const [ingestMsg, setIngestMsg] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [deletingId, setDeletingId] = useState<number | null>(null);

  const selected = useMemo(
    () => stocks.find((s) => s.id === selectedId) ?? null,
    [stocks, selectedId],
  );

  const loadStocks = useCallback(async () => {
    setLoadingList(true);
    setListErr(null);
    try {
      const r = await fetch('/api/portfolio');
      // The portfolio API now requires auth (per-user scoped post multi-tenant
      // refactor). If the session expired or the user was deleted (e.g. a
      // guest TTL elapsed mid-session), wipe any cached watchlist — it
      // belongs to the now-defunct session and would otherwise leak across
      // logins on the same browser — and bounce to /login.
      if (r.status === 401) {
        try {
          sessionStorage.removeItem('aistock:cache:/api/portfolio');
        } catch {
          /* ignore */
        }
        window.location.href = '/login?next=/portfolio';
        return;
      }
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const j = (await r.json()) as { stocks?: unknown };
      // Normalize at the network boundary so render-layer code can trust
      // the shape (id is number, not string from a stale cache).
      const fresh = normalizeStocks(j?.stocks);
      setStocks(fresh);
      try {
        sessionStorage.setItem(
          'aistock:cache:/api/portfolio',
          JSON.stringify({ ts: Date.now(), v: { stocks: fresh } }),
        );
      } catch {
        /* ignore */
      }
      setSelectedId((prev) => {
        if (prev != null && fresh.some((s) => s.id === prev)) return prev;
        return fresh[0]?.id ?? null;
      });
    } catch (e) {
      setListErr(e instanceof Error ? e.message : 'Failed to load');
    } finally {
      setLoadingList(false);
    }
  }, []);

  // Hydrate from sessionStorage instantly so the watchlist never appears empty
  // on first paint while waiting for a Neon cold-start.
  useEffect(() => {
    try {
      const raw = sessionStorage.getItem('aistock:cache:/api/portfolio');
      if (raw) {
        const parsed = JSON.parse(raw) as { v?: { stocks?: unknown } };
        const cachedStocks = normalizeStocks(parsed?.v?.stocks);
        if (cachedStocks.length > 0) {
          setStocks(cachedStocks);
          setLoadingList(false);
          setSelectedId((prev) => prev ?? cachedStocks[0]?.id ?? null);
        }
      }
    } catch {
      /* ignore */
    }
    void loadStocks();
  }, [loadStocks]);

  const loadPrices = useCallback(async (stockId: number, r: Range) => {
    const from = isoOffset(RANGE_DAYS[r]);
    const to = todayIso();
    const url = `/api/portfolio/${encodeURIComponent(String(stockId))}/prices?from=${from}&to=${to}`;
    const cacheKey = `aistock:cache:${url}`;
    // Show cached prices instantly so the chart doesn't blank on range change.
    try {
      const raw = sessionStorage.getItem(cacheKey);
      if (raw) {
        const parsed = JSON.parse(raw) as { ts?: number; v?: { rows?: unknown } };
        const cachedRows = normalizePriceRows(parsed?.v?.rows);
        // Use cached data if < 5 minutes old; otherwise still show stale + refetch.
        if (cachedRows.length > 0) {
          setPrices(cachedRows);
          if (typeof parsed?.ts === 'number' && Date.now() - parsed.ts < 5 * 60_000) {
            setLoadingPrices(false);
            return;
          }
        }
      }
    } catch {
      /* ignore */
    }
    setLoadingPrices(true);
    setPriceErr(null);
    try {
      const res = await fetch(url);
      if (res.status === 401) {
        // Session vanished mid-page — bounce to /login. Same rationale as in
        // loadStocks above.
        window.location.href = '/login?next=/portfolio';
        return;
      }
      // 404 here means "this stockId no longer belongs to you" — usually a
      // stale sessionStorage cache from a previous user on the same browser.
      // Surface a friendlier message and drop the cache so the next load
      // reflects reality.
      if (res.status === 404) {
        try {
          sessionStorage.removeItem(cacheKey);
        } catch {
          /* ignore */
        }
        setPrices([]);
        setPriceErr('Stock not found in your portfolio');
        return;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const j = (await res.json()) as { rows?: unknown };
      // CRITICAL: postgres `numeric` columns roundtrip as strings — coerce
      // here so render-time `close.toFixed(2)` etc. never sees a string.
      const normRows = normalizePriceRows(j?.rows);
      setPrices(normRows);
      try {
        sessionStorage.setItem(
          cacheKey,
          JSON.stringify({ ts: Date.now(), v: { rows: normRows } }),
        );
      } catch {
        /* quota */
      }
    } catch (e) {
      setPriceErr(e instanceof Error ? e.message : 'Failed to load prices');
    } finally {
      setLoadingPrices(false);
    }
  }, []);

  useEffect(() => {
    if (selectedId == null) {
      setPrices([]);
      return;
    }
    void loadPrices(selectedId, range);
  }, [selectedId, range, loadPrices]);

  async function addStock(r: SearchResult) {
    setAdding(true);
    try {
      const res = await fetch('/api/portfolio', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          symbol: r.symbol,
          exchange: r.exchange,
          name: r.name,
          currency: r.currency,
          mic: r.mic,
        }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const j = (await res.json()) as { stock?: unknown };
      const added = normalizeStock(j?.stock);
      if (!added) throw new Error('add: malformed response');
      setStocks((prev) => {
        if (prev.some((s) => s.id === added.id)) return prev;
        return [...prev, added];
      });
      setSelectedId(added.id);
      // Auto-fetch prices in the background so the chart appears without
      // requiring a manual "Refresh data" click.
      void fetch(`/api/portfolio/${encodeURIComponent(String(added.id))}/ingest`, {
        method: 'POST',
      })
        .then(() => loadPrices(added.id, range))
        .catch(() => undefined);
    } catch (e) {
      setListErr(e instanceof Error ? e.message : 'Failed to add');
    } finally {
      setAdding(false);
    }
  }

  async function removeStock(id: number) {
    setDeletingId(id);
    try {
      const res = await fetch('/api/portfolio', {
        method: 'DELETE',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ stockId: id }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setStocks((prev) => prev.filter((s) => s.id !== id));
      setSelectedId((prev) => {
        if (prev !== id) return prev;
        const remaining = stocks.filter((s) => s.id !== id);
        return remaining[0]?.id ?? null;
      });
    } catch (e) {
      setListErr(e instanceof Error ? e.message : 'Failed to delete');
    } finally {
      setDeletingId(null);
    }
  }

  async function ingestNow() {
    if (!selected) return;
    setIngesting(true);
    setIngestMsg(null);
    try {
      const res = await fetch(
        `/api/portfolio/${encodeURIComponent(String(selected.id))}/ingest`,
        { method: 'POST' },
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const j = (await res.json()) as { upserted?: unknown };
      const upserted = typeof j?.upserted === 'number' ? j.upserted : 0;
      setIngestMsg(`Upserted ${upserted} row${upserted === 1 ? '' : 's'}`);
      await loadPrices(selected.id, range);
    } catch (e) {
      setIngestMsg(e instanceof Error ? e.message : 'Refresh failed');
    } finally {
      setIngesting(false);
    }
  }

  const chartPoints: PricePoint[] = useMemo(
    () =>
      prices
        .filter((p) => Number.isFinite(p.close))
        .map((p) => ({ date: p.date, close: p.close })),
    [prices],
  );

  const last = prices.length > 0 ? prices[prices.length - 1] : null;
  const first = prices.length > 0 ? prices[0] : null;
  // Guard every arithmetic op — `close` is the field most likely to be missing
  // or non-finite after a partial ingest. Without these guards a single bad
  // row crashes the whole page.
  const lastClose = last && Number.isFinite(last.close) ? last.close : null;
  const firstClose = first && Number.isFinite(first.close) ? first.close : null;
  const delta = lastClose != null && firstClose != null ? lastClose - firstClose : null;
  const deltaPct =
    delta != null && firstClose != null && firstClose !== 0
      ? (delta / firstClose) * 100
      : null;

  return (
    <div className="flex h-full flex-col md:flex-row">
      <aside className="flex w-full shrink-0 flex-col border-b border-border bg-muted/20 md:w-64 md:border-b-0 md:border-r">
        <div className="border-b border-border px-4 py-3">
          <h2 className="text-sm font-semibold">Watchlist</h2>
          <p className="text-xs text-muted-foreground">{stocks.length} symbol{stocks.length === 1 ? '' : 's'}</p>
        </div>
        <div className="flex-1 overflow-auto">
          {loadingList ? (
            <div className="px-4 py-3 text-xs text-muted-foreground">Loading…</div>
          ) : listErr ? (
            <div className="px-4 py-3 text-xs text-red-500">{listErr}</div>
          ) : stocks.length === 0 ? (
            <div className="px-4 py-3 text-xs text-muted-foreground">
              No stocks yet. Use the search to add one.
            </div>
          ) : (
            <ul>
              {stocks.map((s) => (
                <StockRow
                  key={s.id}
                  stock={s}
                  active={s.id === selectedId}
                  deleting={deletingId === s.id}
                  onSelect={setSelectedId}
                  onRemove={removeStock}
                />
              ))}
            </ul>
          )}
        </div>
      </aside>

      <section className="flex w-full shrink-0 flex-col border-b border-border md:w-80 md:border-b-0 md:border-r">
        <div className="border-b border-border px-4 py-3">
          <h2 className="text-sm font-semibold">Add stock</h2>
          <p className="text-xs text-muted-foreground">Search across SH, SZ, HK, KR, JP, TH, US, LSE, Xetra, Euronext.</p>
        </div>
        <div className="p-4">
          <SearchCombobox onPick={addStock} disabled={adding} />
          {adding ? <div className="mt-2 text-xs text-muted-foreground">Adding…</div> : null}
        </div>
      </section>

      <section className="flex min-w-0 flex-1 flex-col overflow-hidden">
        {selected ? (
          <>
            <div className="flex flex-wrap items-start justify-between gap-3 border-b border-border px-4 py-3 sm:gap-4 sm:px-6 sm:py-4">
              <div className="min-w-0 flex-1">
                <div className="flex items-baseline gap-3">
                  <h1 className="truncate text-lg font-semibold">{selected.symbol}</h1>
                  <span className="text-xs text-muted-foreground">
                    {selected.exchange}
                    {selected.currency ? ` · ${selected.currency}` : ''}
                  </span>
                </div>
                <div className="truncate text-sm text-muted-foreground">{selected.name}</div>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <Select
                  value={range}
                  onChange={(e) => setRange(e.target.value as Range)}
                  className="w-24"
                >
                  {(['1M', '3M', '6M', '1Y', '5Y'] as Range[]).map((r) => (
                    <option key={r} value={r}>
                      {r}
                    </option>
                  ))}
                </Select>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => void ingestNow()}
                  disabled={ingesting}
                >
                  <RefreshCw className={cn('h-3.5 w-3.5', ingesting && 'animate-spin')} />
                  Refresh data
                </Button>
              </div>
            </div>

            <div className="flex-1 overflow-auto p-6">
              <div className="mb-4 flex items-baseline gap-4">
                {lastClose != null ? (
                  <>
                    <div className="text-2xl font-semibold tabular-nums">
                      {lastClose.toFixed(2)}
                    </div>
                    {delta != null && deltaPct != null ? (
                      <div
                        className={cn(
                          'text-sm tabular-nums',
                          delta >= 0 ? 'text-green-500' : 'text-red-500',
                        )}
                      >
                        {delta >= 0 ? '+' : ''}
                        {delta.toFixed(2)} ({deltaPct >= 0 ? '+' : ''}
                        {deltaPct.toFixed(2)}%)
                        <span className="ml-1 text-xs text-muted-foreground">over {range}</span>
                      </div>
                    ) : null}
                  </>
                ) : (
                  <div className="text-sm text-muted-foreground">No prices loaded yet.</div>
                )}
              </div>

              {loadingPrices ? (
                <div
                  className="flex w-full items-center justify-center rounded-md border border-border bg-muted/20 text-xs text-muted-foreground"
                  style={{ height: 320 }}
                >
                  Loading prices…
                </div>
              ) : priceErr ? (
                <div
                  className="flex w-full items-center justify-center rounded-md border border-border bg-muted/20 text-xs text-red-500"
                  style={{ height: 320 }}
                >
                  {priceErr}
                </div>
              ) : (
                <PriceChart data={chartPoints} />
              )}

              <div className="mt-3 flex items-center justify-between text-xs text-muted-foreground">
                <span>
                  {prices.length} point{prices.length === 1 ? '' : 's'}
                  {first && last ? ` · ${first.date} → ${last.date}` : ''}
                </span>
                {ingestMsg ? <span>{ingestMsg}</span> : null}
              </div>
            </div>
          </>
        ) : (
          <div className="flex h-full items-center justify-center p-6 text-sm text-muted-foreground">
            {loadingList ? 'Loading…' : 'Select or add a stock to view its price chart.'}
          </div>
        )}
      </section>
    </div>
  );
}

/**
 * One row in the watchlist sidebar. Pulled out so we can call
 * `usePrefetchHandlers` per-stock (hooks-in-a-loop is fine when the loop
 * always renders one component per iteration). Hovering / touching the row
 * warms BOTH the price series for the default 6M range AND the DB snapshot,
 * so clicking the row paints from cache without a network round-trip.
 */
function StockRow({
  stock,
  active,
  deleting,
  onSelect,
  onRemove,
}: {
  stock: Stock;
  active: boolean;
  deleting: boolean;
  onSelect: (id: number) => void;
  onRemove: (id: number) => void;
}) {
  // Pre-warm the default 6M view (matches the initial Range state). If the
  // user has 1M selected the hover prefetch is "wasted" but only by a handful
  // of KB, and the explicit click still hits its own cache key.
  const from = isoOffset(RANGE_DAYS['6M']);
  const to = todayIso();
  const idStr = String(stock.id);
  const prefetchUrls = [
    `/api/portfolio/${encodeURIComponent(idStr)}/prices?from=${from}&to=${to}`,
    `/api/stocks/${encodeURIComponent(idStr)}/db-snapshot`,
  ];
  const handlers = usePrefetchHandlers(prefetchUrls);
  return (
    <li>
      <div
        {...handlers}
        className={cn(
          'group flex items-center gap-2 border-b border-border/60 px-3 py-2',
          active && 'bg-accent',
        )}
      >
        <button
          type="button"
          onClick={() => onSelect(stock.id)}
          className="min-w-0 flex-1 text-left"
        >
          <div className="truncate text-sm font-medium">{stock.symbol}</div>
          <div className="truncate text-xs text-muted-foreground">
            {stock.name}
            <span className="ml-1">· {stock.exchange}</span>
          </div>
        </button>
        <button
          type="button"
          onClick={() => onRemove(stock.id)}
          disabled={deleting}
          title="Remove"
          className="rounded-md p-1 text-muted-foreground opacity-0 transition hover:bg-background hover:text-red-500 group-hover:opacity-100 disabled:opacity-50"
        >
          <Trash2 className="h-3.5 w-3.5" />
        </button>
      </div>
    </li>
  );
}

'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Trash2, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Select } from '@/components/ui/select';
import { cn } from '@/lib/utils';
import { SearchCombobox, type SearchResult } from '@/components/portfolio/search-combobox';
import { PriceChart, type PricePoint } from '@/components/portfolio/price-chart';
import { usePrefetchHandlers } from '@/components/prefetch-link';

interface Stock {
  id: string;
  symbol: string;
  exchange: string;
  name: string;
  currency: string;
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

export function PortfolioClient() {
  const [stocks, setStocks] = useState<Stock[]>([]);
  const [loadingList, setLoadingList] = useState(true);
  const [listErr, setListErr] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [range, setRange] = useState<Range>('6M');
  const [prices, setPrices] = useState<PriceRow[]>([]);
  const [loadingPrices, setLoadingPrices] = useState(false);
  const [priceErr, setPriceErr] = useState<string | null>(null);
  const [ingesting, setIngesting] = useState(false);
  const [ingestMsg, setIngestMsg] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);

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
      const j = (await r.json()) as { stocks: Stock[] };
      const fresh = j.stocks ?? [];
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
        if (prev && fresh.some((s) => s.id === prev)) return prev;
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
        const parsed = JSON.parse(raw) as { v: { stocks: Stock[] } };
        if (parsed?.v?.stocks?.length) {
          setStocks(parsed.v.stocks);
          setLoadingList(false);
          setSelectedId((prev) => prev ?? parsed.v.stocks[0]?.id ?? null);
        }
      }
    } catch {
      /* ignore */
    }
    void loadStocks();
  }, [loadStocks]);

  const loadPrices = useCallback(async (stockId: string, r: Range) => {
    const from = isoOffset(RANGE_DAYS[r]);
    const to = todayIso();
    const url = `/api/portfolio/${encodeURIComponent(stockId)}/prices?from=${from}&to=${to}`;
    const cacheKey = `aistock:cache:${url}`;
    // Show cached prices instantly so the chart doesn't blank on range change.
    try {
      const raw = sessionStorage.getItem(cacheKey);
      if (raw) {
        const parsed = JSON.parse(raw) as { ts: number; v: { rows: PriceRow[] } };
        // Use cached data if < 5 minutes old; otherwise still show stale + refetch.
        if (parsed?.v?.rows) {
          setPrices(parsed.v.rows);
          if (Date.now() - parsed.ts < 5 * 60_000) {
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
      const j = (await res.json()) as { rows: PriceRow[] };
      setPrices(j.rows ?? []);
      try {
        sessionStorage.setItem(cacheKey, JSON.stringify({ ts: Date.now(), v: j }));
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
    if (!selectedId) {
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
      const j = (await res.json()) as { stock: Stock };
      setStocks((prev) => {
        if (prev.some((s) => s.id === j.stock.id)) return prev;
        return [...prev, j.stock];
      });
      setSelectedId(j.stock.id);
      // Auto-fetch prices in the background so the chart appears without
      // requiring a manual "Refresh data" click.
      void fetch(`/api/portfolio/${encodeURIComponent(j.stock.id)}/ingest`, {
        method: 'POST',
      })
        .then(() => loadPrices(j.stock.id, range))
        .catch(() => undefined);
    } catch (e) {
      setListErr(e instanceof Error ? e.message : 'Failed to add');
    } finally {
      setAdding(false);
    }
  }

  async function removeStock(id: string) {
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
      const res = await fetch(`/api/portfolio/${encodeURIComponent(selected.id)}/ingest`, {
        method: 'POST',
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const j = (await res.json()) as { upserted: number };
      setIngestMsg(`Upserted ${j.upserted} row${j.upserted === 1 ? '' : 's'}`);
      await loadPrices(selected.id, range);
    } catch (e) {
      setIngestMsg(e instanceof Error ? e.message : 'Refresh failed');
    } finally {
      setIngesting(false);
    }
  }

  const chartPoints: PricePoint[] = useMemo(
    () => prices.map((p) => ({ date: p.date, close: p.close })),
    [prices],
  );

  const last = prices.length > 0 ? prices[prices.length - 1] : null;
  const first = prices.length > 0 ? prices[0] : null;
  const delta = last && first ? last.close - first.close : null;
  const deltaPct = last && first && first.close !== 0 ? (delta! / first.close) * 100 : null;

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
                    {selected.exchange} · {selected.currency}
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
                {last ? (
                  <>
                    <div className="text-2xl font-semibold tabular-nums">
                      {last.close.toFixed(2)}
                    </div>
                    {delta !== null && deltaPct !== null ? (
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
  onSelect: (id: string) => void;
  onRemove: (id: string) => void;
}) {
  // Pre-warm the default 6M view (matches the initial Range state). If the
  // user has 1M selected the hover prefetch is "wasted" but only by a handful
  // of KB, and the explicit click still hits its own cache key.
  const from = isoOffset(RANGE_DAYS['6M']);
  const to = todayIso();
  const prefetchUrls = [
    `/api/portfolio/${encodeURIComponent(stock.id)}/prices?from=${from}&to=${to}`,
    `/api/stocks/${encodeURIComponent(stock.id)}/db-snapshot`,
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

'use client';

import { useState } from 'react';
import { useRouter, useSearchParams, usePathname } from 'next/navigation';
import { Select } from '@/components/ui/select';
import { useCachedJson } from '@/lib/client/use-cached-json';

interface PortfolioStock {
  id: number;
  symbol: string;
  exchange: string;
  name: string;
}

interface Props {
  /** Current selected symbol (from ?stock=). */
  value?: string;
  /** Optional callback in addition to URL update. */
  onChange?: (stock: PortfolioStock) => void;
  className?: string;
}

/**
 * Dropdown header listing portfolio stocks. Selecting one updates the
 * `?stock=` URL param (replacing — not pushing — to avoid history pollution).
 */
export function StockSwitcher({ value, onChange, className }: Props) {
  const router = useRouter();
  const pathname = usePathname();
  const sp = useSearchParams();
  // SWR: instant from sessionStorage, refresh in background.
  const { data, loading, error } = useCachedJson<{ stocks: PortfolioStock[] }>(
    '/api/portfolio',
    { ttlMs: 30_000 },
  );
  const stocks = data?.stocks ?? [];
  const err = error;

  function setSymbol(symbol: string) {
    const stock = stocks.find((s) => s.symbol === symbol);
    if (!stock) return;
    const params = new URLSearchParams(sp?.toString() ?? '');
    params.set('stock', stock.symbol);
    router.replace(`${pathname}?${params.toString()}` as never);
    onChange?.(stock);
  }

  if (loading && stocks.length === 0) {
    return <div className="text-xs text-muted-foreground">Loading portfolio…</div>;
  }
  if (err && stocks.length === 0) {
    return <div className="text-xs text-red-500">Portfolio: {err}</div>;
  }
  if (stocks.length === 0) {
    return (
      <div className="text-xs text-muted-foreground">
        No stocks in portfolio — add one from Portfolio first.
      </div>
    );
  }

  return (
    <Select
      className={className}
      value={value ?? ''}
      onChange={(e) => setSymbol(e.target.value)}
    >
      {!value || !stocks.some((s) => s.symbol === value) ? (
        <option value="" disabled>
          Select a stock…
        </option>
      ) : null}
      {stocks.map((s) => (
        <option key={s.id} value={s.symbol}>
          {s.symbol} · {s.exchange} — {s.name}
        </option>
      ))}
    </Select>
  );
}

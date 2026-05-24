'use client';

import { useEffect, useState } from 'react';
import { useRouter, useSearchParams, usePathname } from 'next/navigation';
import { Select } from '@/components/ui/select';

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
  const [stocks, setStocks] = useState<PortfolioStock[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    fetch('/api/portfolio')
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json() as Promise<{ stocks: PortfolioStock[] }>;
      })
      .then((j) => {
        if (cancelled) return;
        setStocks(j.stocks ?? []);
        setErr(null);
      })
      .catch((e) => {
        if (cancelled) return;
        setErr((e as Error).message);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  function setSymbol(symbol: string) {
    const stock = stocks.find((s) => s.symbol === symbol);
    if (!stock) return;
    const params = new URLSearchParams(sp?.toString() ?? '');
    params.set('stock', stock.symbol);
    router.replace(`${pathname}?${params.toString()}` as never);
    onChange?.(stock);
  }

  if (loading) {
    return <div className="text-xs text-muted-foreground">Loading portfolio…</div>;
  }
  if (err) {
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

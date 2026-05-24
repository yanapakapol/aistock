'use client';

import { useEffect, useRef, useState } from 'react';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';

export interface SearchResult {
  symbol: string;
  exchange: string;
  name: string;
  currency: string;
  mic?: string;
}

interface Props {
  onPick: (r: SearchResult) => void | Promise<void>;
  placeholder?: string;
  disabled?: boolean;
}

export function SearchCombobox({ onPick, placeholder = 'Search symbol or name…', disabled }: Props) {
  const [q, setQ] = useState('');
  const [results, setResults] = useState<SearchResult[]>([]);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [active, setActive] = useState(0);
  const wrapRef = useRef<HTMLDivElement>(null);
  const reqRef = useRef(0);

  useEffect(() => {
    const term = q.trim();
    if (term.length < 1) {
      setResults([]);
      setOpen(false);
      setLoading(false);
      return;
    }
    setLoading(true);
    setErr(null);
    const id = ++reqRef.current;
    const t = setTimeout(async () => {
      try {
        const r = await fetch(`/api/stocks/search?q=${encodeURIComponent(term)}`);
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const j = (await r.json()) as { results: SearchResult[] };
        if (id !== reqRef.current) return;
        setResults(j.results ?? []);
        setOpen(true);
        setActive(0);
      } catch (e) {
        if (id !== reqRef.current) return;
        setErr(e instanceof Error ? e.message : 'Search failed');
        setResults([]);
        setOpen(true);
      } finally {
        if (id === reqRef.current) setLoading(false);
      }
    }, 300);
    return () => clearTimeout(t);
  }, [q]);

  useEffect(() => {
    function onDoc(e: MouseEvent) {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, []);

  async function pick(r: SearchResult) {
    setOpen(false);
    setQ('');
    setResults([]);
    await onPick(r);
  }

  function onKey(e: React.KeyboardEvent<HTMLInputElement>) {
    if (!open || results.length === 0) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((a) => (a + 1) % results.length);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((a) => (a - 1 + results.length) % results.length);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const r = results[active];
      if (r) void pick(r);
    } else if (e.key === 'Escape') {
      setOpen(false);
    }
  }

  return (
    <div ref={wrapRef} className="relative">
      <Input
        value={q}
        onChange={(e) => setQ(e.target.value)}
        onFocus={() => results.length > 0 && setOpen(true)}
        onKeyDown={onKey}
        placeholder={placeholder}
        disabled={disabled}
        autoComplete="off"
      />
      {open ? (
        <div className="absolute z-20 mt-1 w-full overflow-hidden rounded-md border border-border bg-background shadow-lg">
          {loading ? (
            <div className="px-3 py-2 text-xs text-muted-foreground">Searching…</div>
          ) : err ? (
            <div className="px-3 py-2 text-xs text-red-500">{err}</div>
          ) : results.length === 0 ? (
            <div className="px-3 py-2 text-xs text-muted-foreground">No matches</div>
          ) : (
            <ul className="max-h-72 overflow-auto">
              {results.map((r, i) => (
                <li key={`${r.symbol}:${r.exchange}:${i}`}>
                  <button
                    type="button"
                    onMouseEnter={() => setActive(i)}
                    onClick={() => void pick(r)}
                    className={cn(
                      'flex w-full items-center justify-between gap-3 px-3 py-2 text-left text-sm hover:bg-accent',
                      i === active && 'bg-accent',
                    )}
                  >
                    <span className="min-w-0 flex-1 truncate">
                      <span className="font-medium">{r.symbol}</span>
                      <span className="ml-2 text-muted-foreground">{r.name}</span>
                    </span>
                    <span className="shrink-0 text-xs text-muted-foreground">
                      {r.exchange}
                      <span className="ml-2">{r.currency}</span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : null}
    </div>
  );
}

'use client';

import { useEffect, useRef, useState } from 'react';

/**
 * Stale-while-revalidate fetch with sessionStorage caching.
 *
 * - On mount: returns cached value INSTANTLY (no spinner) if present.
 * - Always kicks off a background fetch and updates state when fresh data arrives.
 * - Stores per-URL keyed cache under `aistock:cache:<key>`.
 *
 * This is the antidote to Neon cold-starts + Netlify function spin-up: the
 * user sees the last-known good data immediately while a fresh copy is being
 * fetched, so the page never appears empty.
 */
export function useCachedJson<T>(
  url: string | null,
  opts?: { ttlMs?: number; storage?: 'session' | 'local' },
): {
  data: T | null;
  loading: boolean;
  error: string | null;
  refetch: () => void;
} {
  const storageKind = opts?.storage ?? 'session';
  const ttl = opts?.ttlMs ?? 60_000;
  const cacheKey = url ? `aistock:cache:${url}` : null;

  const [data, setData] = useState<T | null>(() => readCache<T>(cacheKey, storageKind, ttl));
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const tick = useRef(0);

  function trigger() {
    if (!url) return;
    const myTick = ++tick.current;
    setLoading(true);
    setError(null);
    fetch(url)
      .then(async (r) => {
        if (myTick !== tick.current) return;
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const j = (await r.json()) as T;
        if (myTick !== tick.current) return;
        setData(j);
        writeCache(cacheKey, j, storageKind);
      })
      .catch((e) => {
        if (myTick !== tick.current) return;
        setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (myTick !== tick.current) return;
        setLoading(false);
      });
  }

  useEffect(() => {
    setData(readCache<T>(cacheKey, storageKind, ttl));
    trigger();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url]);

  return { data, loading, error, refetch: trigger };
}

function storage(kind: 'session' | 'local'): Storage | null {
  if (typeof window === 'undefined') return null;
  return kind === 'session' ? window.sessionStorage : window.localStorage;
}

function readCache<T>(
  key: string | null,
  kind: 'session' | 'local',
  ttl: number,
): T | null {
  if (!key) return null;
  const s = storage(kind);
  if (!s) return null;
  try {
    const raw = s.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { ts: number; v: T };
    if (Date.now() - parsed.ts > ttl) return parsed.v; // still return stale, just trigger refetch
    return parsed.v;
  } catch {
    return null;
  }
}

function writeCache<T>(key: string | null, value: T, kind: 'session' | 'local') {
  if (!key) return;
  const s = storage(kind);
  if (!s) return;
  try {
    s.setItem(key, JSON.stringify({ ts: Date.now(), v: value }));
  } catch {
    /* quota — ignore */
  }
}

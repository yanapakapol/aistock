'use client';

import { useEffect, useRef, useState } from 'react';

/**
 * Stale-while-revalidate fetch with sessionStorage caching.
 *
 * - On mount: returns cached value INSTANTLY (no spinner) if present.
 * - Only kicks off a background fetch if the cached value is OLDER than
 *   `revalidateAfterMs` (default 60s). Otherwise skips the network call.
 * - Always returns stale data; never throws away cache on TTL expiry.
 * - In-flight dedupe: simultaneous mounts share one fetch per URL.
 *
 * Antidote to Neon cold-starts + serverless spin-up: the page never appears
 * empty AND we don't burn DB calls re-asking for things we just got.
 */
const inflight = new Map<string, Promise<unknown>>();

export function useCachedJson<T>(
  url: string | null,
  opts?: { revalidateAfterMs?: number; storage?: 'session' | 'local' },
): {
  data: T | null;
  loading: boolean;
  error: string | null;
  refetch: () => void;
} {
  const storageKind = opts?.storage ?? 'session';
  const revalidateAfter = opts?.revalidateAfterMs ?? 60_000;
  const cacheKey = url ? `aistock:cache:${url}` : null;

  const [data, setData] = useState<T | null>(() => readCacheValue<T>(cacheKey, storageKind));
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const tick = useRef(0);

  function trigger(force = false) {
    if (!url || !cacheKey) return;
    const meta = readCacheMeta(cacheKey, storageKind);
    if (!force && meta && Date.now() - meta.ts < revalidateAfter) {
      // Fresh enough — skip network entirely.
      return;
    }
    const myTick = ++tick.current;
    setLoading(true);
    setError(null);
    // Dedupe concurrent requests across components.
    let p = inflight.get(url) as Promise<T> | undefined;
    if (!p) {
      p = fetch(url).then(async (r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return (await r.json()) as T;
      });
      inflight.set(url, p);
      p.finally(() => inflight.delete(url));
    }
    p.then((j) => {
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
    setData(readCacheValue<T>(cacheKey, storageKind));
    trigger(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url]);

  return { data, loading, error, refetch: () => trigger(true) };
}

function storage(kind: 'session' | 'local'): Storage | null {
  if (typeof window === 'undefined') return null;
  return kind === 'session' ? window.sessionStorage : window.localStorage;
}

function readCacheValue<T>(key: string | null, kind: 'session' | 'local'): T | null {
  if (!key) return null;
  const s = storage(kind);
  if (!s) return null;
  try {
    const raw = s.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { ts: number; v: T };
    return parsed.v;
  } catch {
    return null;
  }
}

function readCacheMeta(key: string | null, kind: 'session' | 'local'): { ts: number } | null {
  if (!key) return null;
  const s = storage(kind);
  if (!s) return null;
  try {
    const raw = s.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { ts: number };
    return { ts: parsed.ts };
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

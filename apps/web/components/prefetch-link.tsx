'use client';

import Link from 'next/link';
import { useCallback, type ComponentProps, type ReactNode } from 'react';

/**
 * Wrapper around Next's `<Link>` that warms API endpoints on hover/touch.
 *
 * Why: Next already prefetches the *page bundle* on hover, but the data the
 * page needs (e.g. `/api/portfolio`) only fires AFTER mount. By kicking off a
 * `fetch(url)` the moment the user's cursor enters the link, the JSON is
 * already in the browser's HTTP cache (and our SWR sessionStorage cache, via
 * the loading-bar fetch hook) by the time the destination page mounts.
 *
 * The fetches are deliberately fire-and-forget:
 *   - No `await`, no state — failures are silently ignored.
 *   - Skipped entirely if the browser has already fetched this URL within the
 *     last 30 s (we dedupe via a module-scoped Map). This means hovering the
 *     same nav item 10 times only hits the network once.
 *   - `keepalive: true` so a fast click that triggers navigation before the
 *     prefetch lands doesn't cancel it.
 *
 * The fetches go through the global fetch monkey-patch in <LoadingBar />, so
 * a hover-prefetch will flash the top progress bar — which is the right UX
 * signal that "something is loading", and it'll already be done when the page
 * mounts.
 */
const PREFETCH_DEDUPE_MS = 30_000;
const lastFetched = new Map<string, number>();

function warm(url: string) {
  const now = Date.now();
  const prev = lastFetched.get(url);
  if (prev && now - prev < PREFETCH_DEDUPE_MS) return;
  lastFetched.set(url, now);
  // Cheap GET; the response will sit in the browser's HTTP cache thanks to the
  // Cache-Control: private headers our API routes set.
  try {
    void fetch(url, { credentials: 'same-origin', keepalive: true }).catch(() => undefined);
  } catch {
    /* fetch can throw synchronously on bad URLs — ignore */
  }
}

type Props = ComponentProps<typeof Link> & {
  /** One or more API endpoints to warm on hover. Order doesn't matter. */
  prefetchUrls?: string[] | string;
  children: ReactNode;
};

export function PrefetchLink({ prefetchUrls, onMouseEnter, onTouchStart, ...rest }: Props) {
  const onEnter = useCallback(
    (e: React.MouseEvent<HTMLAnchorElement>) => {
      if (prefetchUrls) {
        const urls = Array.isArray(prefetchUrls) ? prefetchUrls : [prefetchUrls];
        for (const u of urls) warm(u);
      }
      onMouseEnter?.(e);
    },
    [prefetchUrls, onMouseEnter],
  );
  const onTouch = useCallback(
    (e: React.TouchEvent<HTMLAnchorElement>) => {
      if (prefetchUrls) {
        const urls = Array.isArray(prefetchUrls) ? prefetchUrls : [prefetchUrls];
        for (const u of urls) warm(u);
      }
      onTouchStart?.(e);
    },
    [prefetchUrls, onTouchStart],
  );
  // Next's typed-routes generic on LinkProps.href makes a clean re-spread
  // awkward — forward everything verbatim and let the caller's prop types
  // flow through `ComponentProps<typeof Link>` above.
  return <Link {...rest} onMouseEnter={onEnter} onTouchStart={onTouch} />;
}

/**
 * Imperative version for non-anchor elements (e.g. a row `<button>` or `<li>`
 * that uses `setSelectedId` instead of routing). Returns the event handlers
 * to spread onto the element.
 *
 * Example:
 *   <li {...usePrefetchHandlers([`/api/portfolio/${id}/prices`])}>
 */
export function usePrefetchHandlers(urls: string[] | string | null | undefined) {
  return {
    onMouseEnter: () => {
      if (!urls) return;
      const list = Array.isArray(urls) ? urls : [urls];
      for (const u of list) warm(u);
    },
    onTouchStart: () => {
      if (!urls) return;
      const list = Array.isArray(urls) ? urls : [urls];
      for (const u of list) warm(u);
    },
  };
}

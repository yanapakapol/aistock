'use client';

import { useEffect, useState } from 'react';

/**
 * Global indeterminate loading bar at the top of the viewport. Monkey-patches
 * `window.fetch` to count in-flight requests; appears as soon as any fetch is
 * pending and disappears 200 ms after the last one settles (debounced so it
 * doesn't flicker between back-to-back calls).
 *
 * Zero deps, ~1 KB. Survives navigation because it lives in the root layout.
 */
export function LoadingBar() {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    if ((window as unknown as { __aistockFetchPatched?: boolean }).__aistockFetchPatched) return;
    (window as unknown as { __aistockFetchPatched: boolean }).__aistockFetchPatched = true;

    const orig = window.fetch.bind(window);
    let pending = 0;
    let hideTimer: ReturnType<typeof setTimeout> | null = null;

    function show() {
      if (hideTimer) {
        clearTimeout(hideTimer);
        hideTimer = null;
      }
      setVisible(true);
    }
    function maybeHide() {
      if (pending > 0) return;
      if (hideTimer) clearTimeout(hideTimer);
      hideTimer = setTimeout(() => setVisible(false), 200);
    }

    window.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : (input as Request).url;
      // Only track our own /api/* calls — third-party fetches (e.g. analytics)
      // shouldn't toggle the bar.
      const isInternal = url.startsWith('/') || url.startsWith(location.origin);
      if (isInternal) {
        pending++;
        show();
      }
      return orig(input as RequestInfo, init).finally(() => {
        if (isInternal) {
          pending = Math.max(0, pending - 1);
          maybeHide();
        }
      });
    };
  }, []);

  if (!visible) return null;
  return (
    <div
      className="indeterminate-bar pointer-events-none fixed inset-x-0 top-0 z-[60] h-[2px]"
      role="status"
      aria-label="Loading"
    />
  );
}

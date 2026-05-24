'use client';

// Top-level listener for two things React error boundaries do NOT catch:
//   - synchronous errors fired by non-React code (window 'error' event)
//   - unhandled promise rejections (window 'unhandledrejection')
// Both are normally invisible in production (Vercel shows a generic page) so
// we mount this once inside the root <body> to make them visible:
//   1. console.error with full payload so the browser console always shows it.
//   2. A small toast stack in the bottom-right (max 3) so the user notices
//      even if they don't have devtools open.

import { useEffect, useState } from 'react';

type Toast = {
  id: number;
  kind: 'error' | 'unhandledrejection';
  message: string;
};

const MAX_TOASTS = 3;
const AUTO_DISMISS_MS = 8000;

function describe(value: unknown): string {
  if (value == null) return 'Unknown error';
  if (value instanceof Error) return value.message || value.name || 'Error';
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export function ErrorListener(): React.ReactElement | null {
  const [toasts, setToasts] = useState<Toast[]>([]);

  useEffect(() => {
    let nextId = 1;

    const push = (kind: Toast['kind'], message: string) => {
      setToasts((prev) => {
        const id = nextId++;
        const next = [...prev, { id, kind, message }];
        // Auto-dismiss this toast after a delay so the UI doesn't pile up.
        setTimeout(() => {
          setToasts((cur) => cur.filter((t) => t.id !== id));
        }, AUTO_DISMISS_MS);
        // Cap to the last MAX_TOASTS so a runaway error loop can't flood the screen.
        return next.slice(-MAX_TOASTS);
      });
    };

    const onError = (e: ErrorEvent) => {
      // eslint-disable-next-line no-console
      console.error('[global]', e.error ?? e.message, e);
      push('error', describe(e.error ?? e.message));
    };

    const onRejection = (e: PromiseRejectionEvent) => {
      // eslint-disable-next-line no-console
      console.error('[unhandledrejection]', e.reason);
      push('unhandledrejection', describe(e.reason));
    };

    window.addEventListener('error', onError);
    window.addEventListener('unhandledrejection', onRejection);
    return () => {
      window.removeEventListener('error', onError);
      window.removeEventListener('unhandledrejection', onRejection);
    };
  }, []);

  if (toasts.length === 0) return null;

  const dismiss = (id: number) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  };

  return (
    <div
      // Fixed bottom-right stack. pointer-events-none on the wrapper so the
      // toasts don't block clicks on the page when stacked; each card opts
      // back in to receive its own clicks.
      className="pointer-events-none fixed bottom-4 right-4 z-[9999] flex w-[min(24rem,calc(100vw-2rem))] flex-col gap-2"
      role="status"
      aria-live="polite"
    >
      {toasts.map((t) => (
        <div
          key={t.id}
          className="pointer-events-auto rounded-lg border border-red-500/40 bg-red-500/10 p-3 text-xs shadow-lg backdrop-blur"
        >
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              <div className="font-semibold text-red-300">
                {t.kind === 'unhandledrejection' ? 'Unhandled rejection' : 'Runtime error'}
              </div>
              <div className="mt-0.5 break-words text-muted-foreground">
                {t.message}
              </div>
            </div>
            <button
              type="button"
              onClick={() => dismiss(t.id)}
              className="shrink-0 rounded px-1 text-muted-foreground hover:bg-foreground/10"
              aria-label="Dismiss"
            >
              ×
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}

export default ErrorListener;

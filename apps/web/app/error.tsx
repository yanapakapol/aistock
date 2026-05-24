'use client';

// Next.js per-route error boundary. Rendered when any route segment throws
// during SSR or client render. This replaces Vercel's generic
// "Application error: a client-side exception has occurred" white-page so the
// user (and us) can actually see what blew up.

import { useEffect } from 'react';

export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // Surface the full stack to the browser console — Vercel's default page
    // hides this in production, which makes user-reported bugs un-debuggable.
    // eslint-disable-next-line no-console
    console.error('[route-error]', error);
  }, [error]);

  return (
    <div className="min-h-screen flex items-center justify-center p-6">
      <div className="max-w-2xl w-full rounded-lg border border-red-500/40 bg-red-500/5 p-6 space-y-3">
        <h2 className="text-lg font-semibold">Something went wrong</h2>
        <p className="text-sm text-muted-foreground break-words">
          {error.message || 'Unknown error'}
        </p>
        {error.digest ? (
          <p className="text-xs text-muted-foreground">
            Digest: <code className="font-mono">{error.digest}</code>
          </p>
        ) : null}
        <details className="text-xs">
          <summary className="cursor-pointer text-muted-foreground">
            Stack trace
          </summary>
          <pre className="mt-2 overflow-x-auto whitespace-pre-wrap rounded bg-muted/50 p-2 text-[10px]">
            {error.stack || '(no stack available)'}
          </pre>
        </details>
        <div className="flex gap-2">
          <button
            onClick={reset}
            className="rounded bg-foreground/10 px-3 py-1 text-sm hover:bg-foreground/20"
          >
            Retry
          </button>
          <button
            onClick={() => {
              window.location.href = '/';
            }}
            className="rounded border px-3 py-1 text-sm hover:bg-foreground/5"
          >
            Go home
          </button>
        </div>
      </div>
    </div>
  );
}

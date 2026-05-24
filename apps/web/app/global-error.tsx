'use client';

// Next.js convention: this replaces the ENTIRE app (including the root layout)
// when an error happens inside app/layout.tsx itself. Because it replaces the
// root layout, it MUST emit its own <html> and <body> tags and cannot rely on
// any provider/context defined higher up.

import { useEffect } from 'react';

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // eslint-disable-next-line no-console
    console.error('[global-error]', error);
  }, [error]);

  return (
    <html lang="en" className="dark">
      <body
        style={{
          margin: 0,
          minHeight: '100vh',
          background: '#0a0a0a',
          color: '#fafafa',
          fontFamily:
            'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          padding: '1.5rem',
        }}
      >
        <div
          style={{
            maxWidth: '42rem',
            width: '100%',
            border: '1px solid rgba(239, 68, 68, 0.4)',
            background: 'rgba(239, 68, 68, 0.05)',
            borderRadius: '0.5rem',
            padding: '1.5rem',
          }}
        >
          <h2 style={{ fontSize: '1.125rem', fontWeight: 600, margin: 0 }}>
            The app crashed
          </h2>
          <p
            style={{
              fontSize: '0.875rem',
              opacity: 0.7,
              marginTop: '0.75rem',
              wordBreak: 'break-word',
            }}
          >
            {error.message || 'Unknown error'}
          </p>
          {error.digest ? (
            <p style={{ fontSize: '0.75rem', opacity: 0.6, marginTop: '0.5rem' }}>
              Digest: <code>{error.digest}</code>
            </p>
          ) : null}
          <details style={{ fontSize: '0.75rem', marginTop: '0.75rem' }}>
            <summary style={{ cursor: 'pointer', opacity: 0.7 }}>
              Stack trace
            </summary>
            <pre
              style={{
                marginTop: '0.5rem',
                padding: '0.5rem',
                background: 'rgba(255,255,255,0.05)',
                borderRadius: '0.25rem',
                fontSize: '10px',
                overflowX: 'auto',
                whiteSpace: 'pre-wrap',
              }}
            >
              {error.stack || '(no stack available)'}
            </pre>
          </details>
          <div style={{ display: 'flex', gap: '0.5rem', marginTop: '1rem' }}>
            <button
              onClick={reset}
              style={{
                padding: '0.25rem 0.75rem',
                fontSize: '0.875rem',
                background: 'rgba(255,255,255,0.1)',
                color: 'inherit',
                border: 'none',
                borderRadius: '0.25rem',
                cursor: 'pointer',
              }}
            >
              Retry
            </button>
            <button
              onClick={() => {
                window.location.href = '/';
              }}
              style={{
                padding: '0.25rem 0.75rem',
                fontSize: '0.875rem',
                background: 'transparent',
                color: 'inherit',
                border: '1px solid rgba(255,255,255,0.2)',
                borderRadius: '0.25rem',
                cursor: 'pointer',
              }}
            >
              Go home
            </button>
          </div>
        </div>
      </body>
    </html>
  );
}

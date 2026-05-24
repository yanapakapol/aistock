'use client';

import { useState } from 'react';

export function SetupForm() {
  const [secret, setSecret] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setPending(true);
    setError(null);
    try {
      const res = await fetch('/api/setup', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ secret }),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        setError(j?.error || `error_${res.status}`);
        return;
      }
      window.location.href = '/research';
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setPending(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-3">
      <input
        type="password"
        autoComplete="current-password"
        required
        value={secret}
        onChange={(e) => setSecret(e.target.value)}
        placeholder="Shared access secret"
        className="rounded-md border border-border bg-background px-3 py-2 text-sm"
      />
      <button
        type="submit"
        disabled={pending || secret.length === 0}
        className="rounded-md bg-foreground px-3 py-2 text-sm font-medium text-background disabled:opacity-50"
      >
        {pending ? 'Verifying...' : 'Unlock'}
      </button>
      {error && <p className="text-sm text-red-500">{error}</p>}
    </form>
  );
}

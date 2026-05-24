'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

export function LoginForm() {
  const router = useRouter();
  const sp = useSearchParams();
  const next = sp?.get('next') ?? '/research';
  const [username, setU] = useState('');
  const [password, setP] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [total, setTotal] = useState<number | null>(null);

  useEffect(() => {
    fetch('/api/auth/me')
      .then((r) => r.json())
      .then((j: { user?: unknown; totalUsers?: number }) => {
        setTotal(j.totalUsers ?? 0);
        if (j.user) router.replace(next as never);
      })
      .catch(() => undefined);
  }, [next, router]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setErr(null);
    setBusy(true);
    try {
      const r = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username, password }),
      });
      const j = (await r.json()) as { error?: string };
      if (!r.ok) {
        setErr(j.error ?? `HTTP ${r.status}`);
        return;
      }
      router.replace(next as never);
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <form
      onSubmit={submit}
      className="w-full max-w-sm space-y-4 rounded-lg border border-border bg-muted/10 p-6"
    >
      <div>
        <h1 className="text-lg font-semibold">Sign in to aistock</h1>
        <p className="mt-1 text-xs text-muted-foreground">
          {total === 0
            ? 'No accounts yet — register the first one to become admin.'
            : 'Or '}
          {total !== 0 ? (
            <Link className="text-blue-400 underline" href={`/register?next=${encodeURIComponent(next)}`}>
              create an account
            </Link>
          ) : null}
        </p>
      </div>
      <div className="space-y-1">
        <label className="text-xs text-muted-foreground" htmlFor="u">
          Username
        </label>
        <Input id="u" value={username} onChange={(e) => setU(e.target.value)} autoComplete="username" required />
      </div>
      <div className="space-y-1">
        <label className="text-xs text-muted-foreground" htmlFor="p">
          Password
        </label>
        <Input
          id="p"
          type="password"
          value={password}
          onChange={(e) => setP(e.target.value)}
          autoComplete="current-password"
          required
        />
      </div>
      {err ? <div className="text-xs text-red-500">{err}</div> : null}
      <div className="flex items-center justify-between">
        <Link
          href={`/register?next=${encodeURIComponent(next)}`}
          className="text-xs text-muted-foreground underline hover:text-foreground"
        >
          {total === 0 ? 'Register first user →' : 'Register'}
        </Link>
        <Button type="submit" size="sm" disabled={busy || !username || !password}>
          {busy ? 'Signing in…' : 'Sign in'}
        </Button>
      </div>
    </form>
  );
}

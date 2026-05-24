'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

export function GuestForm() {
  const router = useRouter();
  const sp = useSearchParams();
  const next = sp?.get('next') ?? '/research';
  const [username, setU] = useState('');
  const [password, setP] = useState('');
  const [confirm, setC] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setErr(null);
    if (password !== confirm) {
      setErr('passwords do not match');
      return;
    }
    if (password.length < 8) {
      setErr('password must be at least 8 characters');
      return;
    }
    setBusy(true);
    try {
      const r = await fetch('/api/auth/register-guest', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username, password }),
      });
      const j = (await r.json().catch(() => ({}))) as {
        ok?: boolean;
        error?: string;
        detail?: string;
      };
      if (!r.ok || !j.ok) {
        // Show server-side detail (e.g. "column does not exist") so the user
        // can report something actionable instead of a generic failure.
        const parts = [j.error ?? `HTTP ${r.status}`, j.detail].filter(Boolean);
        setErr(parts.join(' — '));
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
        <h1 className="text-lg font-semibold">Create a guest account</h1>
        <p className="mt-1 text-xs text-muted-foreground">
          Guest account — uses admin&apos;s API keys with a daily token cap. Your data is cleared
          every 7 days but your username stays.
        </p>
      </div>
      <div className="space-y-1">
        <label className="text-xs text-muted-foreground" htmlFor="u">
          Username
        </label>
        <Input
          id="u"
          value={username}
          onChange={(e) => setU(e.target.value)}
          autoComplete="username"
          required
          minLength={3}
        />
      </div>
      <div className="space-y-1">
        <label className="text-xs text-muted-foreground" htmlFor="p">
          Password (min 8 chars)
        </label>
        <Input
          id="p"
          type="password"
          value={password}
          onChange={(e) => setP(e.target.value)}
          autoComplete="new-password"
          required
          minLength={8}
        />
      </div>
      <div className="space-y-1">
        <label className="text-xs text-muted-foreground" htmlFor="c">
          Confirm password
        </label>
        <Input
          id="c"
          type="password"
          value={confirm}
          onChange={(e) => setC(e.target.value)}
          autoComplete="new-password"
          required
          minLength={8}
        />
      </div>
      {err ? <div className="text-xs text-red-500">{err}</div> : null}
      <div className="flex items-center justify-between">
        <Link
          href={`/register?next=${encodeURIComponent(next)}`}
          className="text-xs text-muted-foreground underline hover:text-foreground"
        >
          Full account instead
        </Link>
        <Button type="submit" size="sm" disabled={busy || !username || !password}>
          {busy ? 'Creating…' : 'Create guest account'}
        </Button>
      </div>
    </form>
  );
}

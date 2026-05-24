'use client';

import { useCallback, useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

interface CapStatus {
  current_token_cap: number | null;
  current_usd_cap: number | null;
  role: string | null;
  latest: {
    id: number;
    requested_token_cap: number | null;
    requested_usd_cap: number | null;
    reason: string | null;
    status: 'pending' | 'approved' | 'denied';
    created_at: string;
    decided_at: string | null;
  } | null;
}

/**
 * Sidebar footer button for non-admin users. Shows their current daily caps
 * and opens a small modal where they can request an increase. The admin sees
 * the request on /admin/users and can approve (auto-updates cap) or deny.
 *
 * Hidden entirely for admins (they have no caps) and for users whose caps
 * are both NULL = unlimited (nothing to ask for).
 */
export function CapRequestButton() {
  const [status, setStatus] = useState<CapStatus | null>(null);
  const [open, setOpen] = useState(false);

  const load = useCallback(async () => {
    try {
      const r = await fetch('/api/account/request-cap');
      if (!r.ok) return;
      const j = (await r.json()) as CapStatus;
      setStatus(j);
    } catch {
      /* ignore */
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (!status) return null;
  if (status.role === 'admin') return null;
  // No caps set at all → unlimited → nothing to request.
  if (status.current_token_cap == null && status.current_usd_cap == null) return null;

  const pending = status.latest?.status === 'pending';

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="mt-2 w-full rounded-md border border-dashed border-border px-2 py-1 text-left text-[10px] text-muted-foreground hover:bg-accent hover:text-foreground"
        title="Ask the admin for a higher daily token / USD cap"
      >
        <div className="font-medium">
          Daily cap:{' '}
          {status.current_token_cap != null
            ? `${status.current_token_cap.toLocaleString()} tok`
            : ''}
          {status.current_token_cap != null && status.current_usd_cap != null ? ' · ' : ''}
          {status.current_usd_cap != null ? `$${status.current_usd_cap.toFixed(4)}` : ''}
        </div>
        <div className="text-[10px]">
          {pending ? 'request pending…' : 'Click to request more →'}
        </div>
      </button>
      {open ? (
        <CapRequestModal status={status} onClose={() => setOpen(false)} onSubmitted={load} />
      ) : null}
    </>
  );
}

function CapRequestModal({
  status,
  onClose,
  onSubmitted,
}: {
  status: CapStatus;
  onClose: () => void;
  onSubmitted: () => void;
}) {
  const [tokens, setTokens] = useState<string>(
    status.current_token_cap != null ? String(status.current_token_cap * 2) : '',
  );
  const [usd, setUsd] = useState<string>(
    status.current_usd_cap != null ? String((status.current_usd_cap * 2).toFixed(2)) : '',
  );
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function submit() {
    setErr(null);
    setBusy(true);
    try {
      const body: Record<string, unknown> = {};
      if (tokens.trim() !== '') body.requested_token_cap = Number(tokens);
      if (usd.trim() !== '') body.requested_usd_cap = Number(usd);
      if (reason.trim() !== '') body.reason = reason.trim();
      const r = await fetch('/api/account/request-cap', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      const j = (await r.json().catch(() => ({}))) as { ok?: boolean; error?: string };
      if (!r.ok || !j.ok) {
        setErr(j.error ?? `HTTP ${r.status}`);
        return;
      }
      onSubmitted();
      onClose();
    } finally {
      setBusy(false);
    }
  }

  const pending = status.latest?.status === 'pending';

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-background/70 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="w-[min(28rem,90vw)] space-y-3 rounded-md border border-border bg-background p-5 shadow-lg"
        onClick={(e) => e.stopPropagation()}
      >
        <div>
          <h2 className="text-sm font-semibold">Request a higher cap</h2>
          <p className="mt-1 text-xs text-muted-foreground">
            Your current cap is{' '}
            {status.current_token_cap != null
              ? `${status.current_token_cap.toLocaleString()} tokens`
              : 'unlimited tokens'}
            {' · '}
            {status.current_usd_cap != null
              ? `$${status.current_usd_cap.toFixed(4)}`
              : 'unlimited USD'}{' '}
            per day. Admin gets a notification and can approve or deny.
          </p>
        </div>
        {pending ? (
          <div className="rounded border border-amber-500/40 bg-amber-500/10 p-2 text-xs text-amber-700 dark:text-amber-300">
            You already have a pending request. Wait for the admin to decide before submitting another.
          </div>
        ) : null}
        <div className="space-y-2">
          <label className="text-xs text-muted-foreground">New token cap / day</label>
          <Input
            inputMode="numeric"
            value={tokens}
            onChange={(e) => setTokens(e.target.value)}
            disabled={pending}
            placeholder="leave blank to skip"
          />
        </div>
        <div className="space-y-2">
          <label className="text-xs text-muted-foreground">New USD cap / day</label>
          <Input
            inputMode="decimal"
            value={usd}
            onChange={(e) => setUsd(e.target.value)}
            disabled={pending}
            placeholder="leave blank to skip"
          />
        </div>
        <div className="space-y-2">
          <label className="text-xs text-muted-foreground">Reason (optional)</label>
          <textarea
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            disabled={pending}
            rows={3}
            maxLength={500}
            className="w-full rounded-md border border-border bg-background px-2 py-1 text-sm"
            placeholder="why you need a bigger cap"
          />
        </div>
        {err ? <div className="text-xs text-red-500">{err}</div> : null}
        <div className="flex items-center justify-end gap-2">
          <Button variant="outline" size="sm" onClick={onClose}>
            Close
          </Button>
          <Button
            size="sm"
            onClick={submit}
            disabled={busy || pending || (tokens.trim() === '' && usd.trim() === '')}
          >
            {busy ? 'Submitting…' : 'Submit request'}
          </Button>
        </div>
      </div>
    </div>
  );
}

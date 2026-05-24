'use client';

import { useCallback, useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { PROVIDERS, PROVIDER_LABELS, type Provider } from '@/lib/llm/providers';
import { NEWS_PROVIDERS, NEWS_PROVIDER_LABELS, type NewsProvider } from '@/lib/news/providers';

export interface AdminUserRow {
  id: number;
  username: string;
  role: 'admin' | 'user' | 'guest';
  daily_token_cap: number | null;
  daily_usd_cap: number | null;
  expires_at: string | null;
  today_tokens: number;
  today_usd: number;
}

interface Props {
  initialUsers: AdminUserRow[];
  currentUserId: number;
}

type Status =
  | { kind: 'idle' }
  | { kind: 'busy' }
  | { kind: 'ok'; msg: string }
  | { kind: 'err'; msg: string };

export function UsersClient({ initialUsers, currentUserId }: Props) {
  const [rows, setRows] = useState<AdminUserRow[]>(initialUsers);
  const [keyModalUserId, setKeyModalUserId] = useState<number | null>(null);

  const refresh = useCallback(async () => {
    const r = await fetch('/api/admin/users');
    if (!r.ok) return;
    const j = (await r.json()) as { users: AdminUserRow[] };
    setRows(j.users ?? []);
  }, []);

  // Refresh once on mount so today's-usage figures stay current after a soft
  // nav from elsewhere in the app.
  useEffect(() => {
    void refresh();
  }, [refresh]);

  return (
    <div className="space-y-4">
      <div className="overflow-x-auto rounded-md border border-border">
        <table className="w-full text-sm">
          <thead className="bg-muted/40 text-xs uppercase tracking-wide text-muted-foreground">
            <tr>
              <th className="px-3 py-2 text-left font-medium">Username</th>
              <th className="px-3 py-2 text-left font-medium">Role</th>
              <th className="px-3 py-2 text-right font-medium">Token cap / day</th>
              <th className="px-3 py-2 text-right font-medium">USD cap / day</th>
              <th className="px-3 py-2 text-left font-medium">Expires</th>
              <th className="px-3 py-2 text-right font-medium">Today tokens</th>
              <th className="px-3 py-2 text-right font-medium">Today USD</th>
              <th className="px-3 py-2 text-right font-medium">Actions</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((u) => (
              <UserRow
                key={u.id}
                user={u}
                isSelf={u.id === currentUserId}
                onAssignKey={() => setKeyModalUserId(u.id)}
                onChanged={refresh}
              />
            ))}
            {rows.length === 0 ? (
              <tr>
                <td className="px-3 py-4 text-center text-muted-foreground" colSpan={8}>
                  No users.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>

      {keyModalUserId != null ? (
        <AssignKeyModal
          user={rows.find((r) => r.id === keyModalUserId) ?? null}
          onClose={() => setKeyModalUserId(null)}
        />
      ) : null}
    </div>
  );
}

function UserRow({
  user,
  isSelf,
  onAssignKey,
  onChanged,
}: {
  user: AdminUserRow;
  isSelf: boolean;
  onAssignKey: () => void;
  onChanged: () => void;
}) {
  const [tokenCap, setTokenCap] = useState<string>(
    user.daily_token_cap == null ? '' : String(user.daily_token_cap),
  );
  const [usdCap, setUsdCap] = useState<string>(
    user.daily_usd_cap == null ? '' : String(user.daily_usd_cap),
  );
  const [status, setStatus] = useState<Status>({ kind: 'idle' });

  // Keep local edits in sync if parent refreshes (e.g. after another save).
  useEffect(() => {
    setTokenCap(user.daily_token_cap == null ? '' : String(user.daily_token_cap));
    setUsdCap(user.daily_usd_cap == null ? '' : String(user.daily_usd_cap));
  }, [user.daily_token_cap, user.daily_usd_cap]);

  const dirty =
    tokenCap !== (user.daily_token_cap == null ? '' : String(user.daily_token_cap)) ||
    usdCap !== (user.daily_usd_cap == null ? '' : String(user.daily_usd_cap));

  async function save() {
    setStatus({ kind: 'busy' });
    const body: Record<string, unknown> = {};
    body.daily_token_cap = tokenCap.trim() === '' ? null : Number(tokenCap);
    body.daily_usd_cap = usdCap.trim() === '' ? null : Number(usdCap);
    if (
      (body.daily_token_cap != null && !Number.isFinite(body.daily_token_cap)) ||
      (body.daily_usd_cap != null && !Number.isFinite(body.daily_usd_cap))
    ) {
      setStatus({ kind: 'err', msg: 'invalid number' });
      return;
    }
    const r = await fetch(`/api/admin/users/${user.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!r.ok) {
      const j = (await r.json().catch(() => ({}))) as { error?: string };
      setStatus({ kind: 'err', msg: j.error ?? 'save failed' });
      return;
    }
    setStatus({ kind: 'ok', msg: 'saved' });
    onChanged();
  }

  async function remove() {
    if (
      !confirm(
        `Delete user "${user.username}"? This permanently removes their portfolios, chats, and saved keys.`,
      )
    ) {
      return;
    }
    setStatus({ kind: 'busy' });
    const r = await fetch(`/api/admin/users/${user.id}`, { method: 'DELETE' });
    if (!r.ok) {
      const j = (await r.json().catch(() => ({}))) as { error?: string };
      setStatus({ kind: 'err', msg: j.error ?? 'delete failed' });
      return;
    }
    onChanged();
  }

  return (
    <tr className="border-t border-border align-top">
      <td className="px-3 py-2">
        <div className="font-medium">{user.username}</div>
        {isSelf ? <div className="text-[10px] text-muted-foreground">(you)</div> : null}
      </td>
      <td className="px-3 py-2">
        <span
          className={
            user.role === 'admin'
              ? 'rounded bg-foreground/10 px-1.5 py-0.5 text-xs'
              : user.role === 'guest'
                ? 'rounded bg-yellow-500/10 px-1.5 py-0.5 text-xs text-yellow-500'
                : 'rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground'
          }
        >
          {user.role}
        </span>
      </td>
      <td className="px-3 py-2 text-right">
        <Input
          className="h-8 w-28 text-right"
          inputMode="numeric"
          placeholder="∞"
          value={tokenCap}
          onChange={(e) => setTokenCap(e.target.value)}
        />
      </td>
      <td className="px-3 py-2 text-right">
        <Input
          className="h-8 w-24 text-right"
          inputMode="decimal"
          placeholder="∞"
          value={usdCap}
          onChange={(e) => setUsdCap(e.target.value)}
        />
      </td>
      <td className="px-3 py-2 text-xs text-muted-foreground">
        {user.expires_at ? new Date(user.expires_at).toISOString().slice(0, 10) : '—'}
      </td>
      <td className="px-3 py-2 text-right tabular-nums">{user.today_tokens.toLocaleString()}</td>
      <td className="px-3 py-2 text-right tabular-nums">${user.today_usd.toFixed(4)}</td>
      <td className="px-3 py-2">
        <div className="flex items-center justify-end gap-2">
          <Button
            size="sm"
            onClick={save}
            disabled={!dirty || status.kind === 'busy'}
          >
            Save
          </Button>
          <Button variant="outline" size="sm" onClick={onAssignKey} disabled={status.kind === 'busy'}>
            Assign key
          </Button>
          <Button
            variant="destructive"
            size="sm"
            onClick={remove}
            disabled={status.kind === 'busy' || isSelf}
            title={isSelf ? 'cannot delete yourself' : 'delete user'}
          >
            Delete
          </Button>
        </div>
        {status.kind !== 'idle' && status.kind !== 'busy' ? (
          <div
            className={
              'mt-1 text-right text-xs ' +
              (status.kind === 'err' ? 'text-red-500' : 'text-green-500')
            }
          >
            {status.msg}
          </div>
        ) : null}
      </td>
    </tr>
  );
}

type AllProvider = Provider | NewsProvider;
const ALL_PROVIDER_OPTIONS: Array<{ value: AllProvider; label: string; group: 'LLM' | 'News' }> = [
  ...PROVIDERS.map((p) => ({ value: p, label: PROVIDER_LABELS[p], group: 'LLM' as const })),
  ...NEWS_PROVIDERS.map((p) => ({ value: p, label: NEWS_PROVIDER_LABELS[p], group: 'News' as const })),
];

function AssignKeyModal({
  user,
  onClose,
}: {
  user: AdminUserRow | null;
  onClose: () => void;
}) {
  const [provider, setProvider] = useState<AllProvider>('openai');
  const [apiKey, setApiKey] = useState('');
  const [status, setStatus] = useState<Status>({ kind: 'idle' });

  if (!user) return null;

  async function save() {
    if (!apiKey || !user) return;
    setStatus({ kind: 'busy' });
    const r = await fetch(`/api/admin/users/${user.id}/keys`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ provider, apiKey }),
    });
    if (!r.ok) {
      const j = (await r.json().catch(() => ({}))) as { error?: string };
      setStatus({ kind: 'err', msg: j.error ?? 'save failed' });
      return;
    }
    // Clear the field immediately — we never show this back to the admin.
    setApiKey('');
    setStatus({ kind: 'ok', msg: 'Key saved (not displayed again)' });
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-background/70 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="w-[min(28rem,90vw)] space-y-4 rounded-md border border-border bg-background p-5 shadow-lg"
        onClick={(e) => e.stopPropagation()}
      >
        <div>
          <h2 className="text-sm font-semibold">
            Assign API key for {user.username}
          </h2>
          <p className="text-xs text-muted-foreground">
            The key is encrypted at rest. You will not be able to view it after saving.
            It takes effect on the user&apos;s next request.
          </p>
        </div>
        <div className="space-y-2">
          <label className="block text-xs font-medium text-muted-foreground">Provider</label>
          <Select
            value={provider}
            onChange={(e) => setProvider(e.target.value as AllProvider)}
          >
            <optgroup label="LLM">
              {ALL_PROVIDER_OPTIONS.filter((o) => o.group === 'LLM').map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </optgroup>
            <optgroup label="News / data">
              {ALL_PROVIDER_OPTIONS.filter((o) => o.group === 'News').map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </optgroup>
          </Select>
        </div>
        <div className="space-y-2">
          <label className="block text-xs font-medium text-muted-foreground">API key</label>
          <Input
            type="password"
            autoComplete="off"
            placeholder="paste key (replaces any existing key for this provider)"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
          />
        </div>
        {status.kind !== 'idle' && status.kind !== 'busy' ? (
          <div
            className={
              'text-xs ' + (status.kind === 'err' ? 'text-red-500' : 'text-green-500')
            }
          >
            {status.msg}
          </div>
        ) : null}
        <div className="flex items-center justify-end gap-2">
          <Button variant="outline" size="sm" onClick={onClose}>
            Close
          </Button>
          <Button size="sm" onClick={save} disabled={!apiKey || status.kind === 'busy'}>
            Save key
          </Button>
        </div>
      </div>
    </div>
  );
}

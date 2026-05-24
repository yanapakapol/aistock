'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

interface Props {
  /** Provider slug — either an LLM provider ("openai") or news provider ("tavily"). */
  provider: string;
  /** Friendly label shown in the row header. */
  label: string;
  /** Vault namespace. The API route uses it to branch on save/delete; the test
   *  route already infers from the provider slug. Default keeps existing
   *  LLM-row callers unchanged. */
  kind?: 'llm' | 'news';
  saved: boolean;
  onChanged: () => void;
}

type Status =
  | { kind: 'idle' }
  | { kind: 'busy'; label: string }
  | { kind: 'ok'; msg: string }
  | { kind: 'err'; msg: string };

export function KeyRow({ provider, label, kind = 'llm', saved, onChanged }: Props) {
  const [value, setValue] = useState('');
  const [status, setStatus] = useState<Status>({ kind: 'idle' });

  async function probe() {
    if (!value) return;
    setStatus({ kind: 'busy', label: 'Testing' });
    const r = await fetch('/api/keys/test', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ provider, apiKey: value, kind }),
    });
    const j = (await r.json()) as { ok: boolean };
    setStatus(j.ok ? { kind: 'ok', msg: 'Key works' } : { kind: 'err', msg: 'Key rejected' });
  }

  async function save() {
    if (!value) return;
    setStatus({ kind: 'busy', label: 'Saving' });
    const r = await fetch('/api/keys', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ provider, apiKey: value, kind }),
    });
    if (!r.ok) {
      setStatus({ kind: 'err', msg: 'Save failed' });
      return;
    }
    setValue('');
    setStatus({ kind: 'ok', msg: 'Saved' });
    onChanged();
  }

  async function remove() {
    setStatus({ kind: 'busy', label: 'Removing' });
    const r = await fetch('/api/keys', {
      method: 'DELETE',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ provider, kind }),
    });
    if (!r.ok) {
      setStatus({ kind: 'err', msg: 'Delete failed' });
      return;
    }
    setStatus({ kind: 'ok', msg: 'Removed' });
    onChanged();
  }

  return (
    <div className="grid grid-cols-[160px_1fr_auto] items-center gap-3 border-b border-border py-3">
      <div className="text-sm">
        <div className="font-medium">{label}</div>
        <div className={saved ? 'text-xs text-green-500' : 'text-xs text-muted-foreground'}>
          {saved ? 'Key saved' : 'No key'}
        </div>
      </div>
      <Input
        type="password"
        autoComplete="off"
        placeholder={saved ? 'Enter to replace' : kind === 'news' ? 'paste key' : 'sk-...'}
        value={value}
        onChange={(e) => setValue(e.target.value)}
      />
      <div className="flex items-center gap-2">
        <Button variant="outline" size="sm" onClick={probe} disabled={!value || status.kind === 'busy'}>
          Test
        </Button>
        <Button size="sm" onClick={save} disabled={!value || status.kind === 'busy'}>
          Save
        </Button>
        {saved ? (
          <Button variant="destructive" size="sm" onClick={remove} disabled={status.kind === 'busy'}>
            Remove
          </Button>
        ) : null}
      </div>
      {status.kind !== 'idle' ? (
        <div
          className={
            'col-span-3 text-xs ' +
            (status.kind === 'err'
              ? 'text-red-500'
              : status.kind === 'ok'
                ? 'text-green-500'
                : 'text-muted-foreground')
          }
        >
          {status.kind === 'busy' ? `${status.label}…` : status.msg}
        </div>
      ) : null}
    </div>
  );
}

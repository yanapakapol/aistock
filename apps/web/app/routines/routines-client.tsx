'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { CronHelper } from '@/components/routines/cron-helper';
import { PushToggle } from '@/components/pwa/push-toggle';
import { RunRow, type RoutineRun } from '@/components/routines/run-row';

export interface RoutineDTO {
  id: number;
  name: string;
  prompt: string;
  tab: 'research' | 'analysis';
  model: string;
  fallbackModels: string[];
  cronExpr: string;
  tz: string;
  enabled: boolean;
  maxUsdPerRun: string;
  lastRunAt: string | null;
  lastRunStatus: 'pending' | 'running' | 'completed' | 'failed' | 'skipped' | null;
  createdAt: string;
}

interface Props {
  initialRoutines: RoutineDTO[];
}

function defaultTz(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Bangkok';
  } catch {
    return 'Asia/Bangkok';
  }
}

const STATUS_DOT: Record<NonNullable<RoutineDTO['lastRunStatus']>, string> = {
  pending: 'bg-zinc-400',
  running: 'bg-blue-400',
  completed: 'bg-green-500',
  failed: 'bg-red-500',
  skipped: 'bg-yellow-500',
};

export function RoutinesClient({ initialRoutines }: Props) {
  const [routines, setRoutines] = useState<RoutineDTO[]>(initialRoutines);
  const [selectedId, setSelectedId] = useState<number | null>(
    initialRoutines[0]?.id ?? null,
  );
  const [showNew, setShowNew] = useState(false);
  const [runs, setRuns] = useState<RoutineRun[]>([]);
  const [runsLoading, setRunsLoading] = useState(false);
  const [runNowBusy, setRunNowBusy] = useState(false);
  const [topError, setTopError] = useState<string | null>(null);

  const selected = useMemo(
    () => routines.find((r) => r.id === selectedId) ?? null,
    [routines, selectedId],
  );

  const refreshRoutines = useCallback(async () => {
    const r = await fetch('/api/routines');
    if (!r.ok) return;
    const j = (await r.json()) as { routines: unknown[] };
    // Server returns raw rows; normalize timestamps to strings.
    const next = j.routines.map((row) => {
      const o = row as Record<string, unknown>;
      return {
        id: o.id as number,
        name: o.name as string,
        prompt: o.prompt as string,
        tab: o.tab as 'research' | 'analysis',
        model: o.model as string,
        fallbackModels: (o.fallbackModels as string[]) ?? [],
        cronExpr: o.cronExpr as string,
        tz: o.tz as string,
        enabled: o.enabled as boolean,
        maxUsdPerRun: String(o.maxUsdPerRun ?? '1.00'),
        lastRunAt: o.lastRunAt ? String(o.lastRunAt) : null,
        lastRunStatus: (o.lastRunStatus as RoutineDTO['lastRunStatus']) ?? null,
        createdAt: String(o.createdAt),
      } satisfies RoutineDTO;
    });
    setRoutines(next);
    if (selectedId == null && next.length > 0) setSelectedId(next[0].id);
  }, [selectedId]);

  const refreshRuns = useCallback(async (routineId: number) => {
    setRunsLoading(true);
    try {
      const r = await fetch(`/api/routines/${routineId}/runs`);
      if (!r.ok) return;
      const j = (await r.json()) as { runs: unknown[] };
      const next = j.runs.map((row) => {
        const o = row as Record<string, unknown>;
        return {
          id: o.id as number,
          routineId: o.routineId as number,
          startedAt: String(o.startedAt),
          finishedAt: o.finishedAt ? String(o.finishedAt) : null,
          status: o.status as RoutineRun['status'],
          outputMd: (o.outputMd as string | null) ?? null,
          exportPath: (o.exportPath as string | null) ?? null,
          usdSpent: (o.usdSpent as string | null) ?? null,
        } satisfies RoutineRun;
      });
      setRuns(next);
    } finally {
      setRunsLoading(false);
    }
  }, []);

  useEffect(() => {
    if (selectedId != null) void refreshRuns(selectedId);
    else setRuns([]);
  }, [selectedId, refreshRuns]);

  // Light polling of runs for the selected routine. The run-now button has no
  // live stream yet — final result only — so this keeps the right pane fresh.
  useEffect(() => {
    if (selectedId == null) return;
    const hasInFlight = runs.some((r) => r.status === 'pending' || r.status === 'running');
    const intervalMs = hasInFlight ? 3000 : 15000;
    const t = setInterval(() => void refreshRuns(selectedId), intervalMs);
    return () => clearInterval(t);
  }, [selectedId, runs, refreshRuns]);

  async function toggleEnabled(routine: RoutineDTO) {
    const next = !routine.enabled;
    setRoutines((rs) => rs.map((r) => (r.id === routine.id ? { ...r, enabled: next } : r)));
    const r = await fetch(`/api/routines/${routine.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: next }),
    });
    if (!r.ok) {
      setTopError('Failed to toggle routine');
      void refreshRoutines();
    }
  }

  async function deleteRoutine(routine: RoutineDTO) {
    if (!confirm(`Delete routine "${routine.name}"? Run history will also be removed.`)) return;
    const r = await fetch(`/api/routines/${routine.id}`, { method: 'DELETE' });
    if (!r.ok) {
      setTopError('Failed to delete routine');
      return;
    }
    setRoutines((rs) => rs.filter((r) => r.id !== routine.id));
    if (selectedId === routine.id) setSelectedId(null);
  }

  async function runNow(routine: RoutineDTO) {
    setRunNowBusy(true);
    setTopError(null);
    try {
      const r = await fetch(`/api/routines/${routine.id}/run-now`, { method: 'POST' });
      if (!r.ok && r.status !== 202) {
        const j = await r.json().catch(() => ({}));
        setTopError(j?.detail || j?.error || 'Run now failed');
        return;
      }
      // Refresh runs so the user immediately sees a pending row.
      await refreshRuns(routine.id);
    } finally {
      setRunNowBusy(false);
    }
  }

  function handleCreated(routine: RoutineDTO) {
    setRoutines((rs) => [routine, ...rs]);
    setSelectedId(routine.id);
    setShowNew(false);
  }

  return (
    <div className="grid h-full grid-cols-[320px_1fr] gap-0 overflow-hidden">
      {/* Left pane — routine list */}
      <aside className="flex h-full flex-col border-r border-border">
        <div className="flex items-center justify-between gap-2 p-4">
          <h1 className="text-lg font-semibold">Routines</h1>
          <div className="flex items-center gap-2">
            <PushToggle />
            <Button size="sm" onClick={() => setShowNew(true)}>
              + New
            </Button>
          </div>
        </div>
        <div className="flex-1 overflow-auto px-2 pb-4">
          {routines.length === 0 ? (
            <div className="px-2 py-6 text-sm text-muted-foreground">
              No routines yet. Click <strong>+ New</strong> to schedule a prompt.
            </div>
          ) : (
            <ul className="space-y-1">
              {routines.map((r) => {
                const isSel = r.id === selectedId;
                return (
                  <li key={r.id}>
                    <button
                      type="button"
                      onClick={() => setSelectedId(r.id)}
                      className={
                        'group flex w-full items-start gap-2 rounded-md px-2 py-2 text-left text-sm transition-colors ' +
                        (isSel ? 'bg-accent' : 'hover:bg-accent/50')
                      }
                    >
                      <span
                        className={
                          'mt-1.5 inline-block h-2 w-2 rounded-full ' +
                          (r.lastRunStatus ? STATUS_DOT[r.lastRunStatus] : 'bg-zinc-700')
                        }
                        title={r.lastRunStatus ?? 'no runs yet'}
                      />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate font-medium">{r.name}</span>
                        <span className="block truncate text-xs text-muted-foreground">
                          {r.cronExpr} · {r.tz}
                        </span>
                      </span>
                      <span
                        className={
                          'self-center rounded px-1.5 py-0.5 text-[10px] font-medium uppercase ' +
                          (r.enabled
                            ? 'bg-green-500/10 text-green-400'
                            : 'bg-zinc-500/10 text-zinc-400')
                        }
                      >
                        {r.enabled ? 'on' : 'off'}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </aside>

      {/* Right pane — detail */}
      <main className="flex h-full flex-col overflow-hidden">
        {topError ? (
          <div className="border-b border-red-500/30 bg-red-500/10 px-4 py-2 text-xs text-red-400">
            {topError}{' '}
            <button className="underline" onClick={() => setTopError(null)}>
              dismiss
            </button>
          </div>
        ) : null}
        {selected ? (
          <div className="flex h-full flex-col overflow-hidden">
            <header className="flex items-start justify-between gap-4 border-b border-border p-4">
              <div className="min-w-0">
                <h2 className="truncate text-base font-semibold">{selected.name}</h2>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  {selected.tab} · {selected.model}
                  {selected.fallbackModels.length > 0
                    ? ` (fallbacks: ${selected.fallbackModels.join(', ')})`
                    : ''}
                </p>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  <code className="rounded bg-muted/40 px-1">{selected.cronExpr}</code> ·{' '}
                  {selected.tz} · max ${Number(selected.maxUsdPerRun).toFixed(2)}/run
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => toggleEnabled(selected)}
                >
                  {selected.enabled ? 'Disable' : 'Enable'}
                </Button>
                <Button size="sm" onClick={() => runNow(selected)} disabled={runNowBusy}>
                  {runNowBusy ? 'Queuing…' : 'Run now'}
                </Button>
                <Button
                  size="sm"
                  variant="destructive"
                  onClick={() => deleteRoutine(selected)}
                >
                  Delete
                </Button>
              </div>
            </header>

            <section className="border-b border-border p-4">
              <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                Prompt
              </h3>
              <pre className="mt-1 whitespace-pre-wrap break-words rounded bg-muted/30 p-3 text-xs">
                {selected.prompt}
              </pre>
            </section>

            <section className="flex-1 overflow-auto p-4">
              <div className="mb-2 flex items-center justify-between">
                <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  Recent runs (last 20)
                </h3>
                {runsLoading ? (
                  <span className="text-xs text-muted-foreground">refreshing…</span>
                ) : null}
              </div>
              {runs.length === 0 ? (
                <div className="text-sm text-muted-foreground">
                  No runs yet. Click <strong>Run now</strong> or wait for the schedule.
                </div>
              ) : (
                <div className="space-y-2">
                  {runs.map((run) => (
                    <RunRow key={run.id} run={run} routineName={selected.name} />
                  ))}
                </div>
              )}
            </section>
          </div>
        ) : (
          <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
            Select a routine, or create one to get started.
          </div>
        )}
      </main>

      {showNew ? (
        <NewRoutineModal
          onClose={() => setShowNew(false)}
          onCreated={handleCreated}
        />
      ) : null}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// New routine modal
// ─────────────────────────────────────────────────────────────────────────

interface ModalProps {
  onClose: () => void;
  onCreated: (r: RoutineDTO) => void;
}

function NewRoutineModal({ onClose, onCreated }: ModalProps) {
  const [name, setName] = useState('');
  const [prompt, setPrompt] = useState('');
  const [tab, setTab] = useState<'research' | 'analysis'>('analysis');
  const [model, setModel] = useState('');
  const [fallbacks, setFallbacks] = useState('');
  const [cronExpr, setCronExpr] = useState('0 8 * * *');
  const [tz, setTz] = useState<string>(defaultTz());
  const [maxUsd, setMaxUsd] = useState('1.00');
  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setErr(null);

    const fallbackList = fallbacks
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    const maxUsdNum = Number(maxUsd);
    if (!Number.isFinite(maxUsdNum) || maxUsdNum <= 0) {
      setErr('Max USD/run must be a positive number');
      return;
    }
    if (!name.trim() || !prompt.trim() || !model.trim() || !cronExpr.trim() || !tz.trim()) {
      setErr('Name, prompt, model, cron, and TZ are required');
      return;
    }

    setSubmitting(true);
    try {
      const r = await fetch('/api/routines', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name: name.trim(),
          prompt: prompt.trim(),
          tab,
          model: model.trim(),
          fallbackModels: fallbackList,
          cronExpr: cronExpr.trim(),
          tz: tz.trim(),
          maxUsdPerRun: maxUsdNum,
        }),
      });
      if (!r.ok) {
        const j = (await r.json().catch(() => ({}))) as { error?: string; detail?: string };
        setErr(j.detail || j.error || 'Create failed');
        return;
      }
      const j = (await r.json()) as { routine: Record<string, unknown> };
      const o = j.routine;
      const created: RoutineDTO = {
        id: o.id as number,
        name: o.name as string,
        prompt: o.prompt as string,
        tab: o.tab as 'research' | 'analysis',
        model: o.model as string,
        fallbackModels: (o.fallbackModels as string[]) ?? [],
        cronExpr: o.cronExpr as string,
        tz: o.tz as string,
        enabled: o.enabled as boolean,
        maxUsdPerRun: String(o.maxUsdPerRun ?? '1.00'),
        lastRunAt: o.lastRunAt ? String(o.lastRunAt) : null,
        lastRunStatus: (o.lastRunStatus as RoutineDTO['lastRunStatus']) ?? null,
        createdAt: String(o.createdAt),
      };
      onCreated(created);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/50 p-4"
      onClick={onClose}
    >
      <form
        onClick={(e) => e.stopPropagation()}
        onSubmit={submit}
        className="my-8 w-full max-w-xl space-y-4 rounded-lg border border-border bg-background p-5 shadow-xl"
      >
        <header className="flex items-center justify-between">
          <h2 className="text-base font-semibold">New routine</h2>
          <button
            type="button"
            onClick={onClose}
            className="text-sm text-muted-foreground hover:text-foreground"
          >
            ✕
          </button>
        </header>

        <Field label="Name">
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Daily NVDA morning brief" />
        </Field>

        <Field label="Prompt">
          <textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder="Summarize NVDA news from the last 24h, highlight events with prob > 0.5 …"
            rows={5}
            className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-foreground/30"
          />
        </Field>

        <div className="grid grid-cols-2 gap-3">
          <Field label="Tab">
            <Select value={tab} onChange={(e) => setTab(e.target.value as 'research' | 'analysis')}>
              <option value="analysis">analysis</option>
              <option value="research">research</option>
            </Select>
          </Field>
          <Field label="Model">
            <Input value={model} onChange={(e) => setModel(e.target.value)} placeholder="mistral-medium-latest" />
          </Field>
        </div>

        <Field label="Fallback models (comma-separated, optional)">
          <Input
            value={fallbacks}
            onChange={(e) => setFallbacks(e.target.value)}
            placeholder="mistral-small-latest, gpt-4o-mini"
          />
        </Field>

        <div className="grid grid-cols-2 gap-3">
          <Field
            label="Cron expression"
            hint='5-field cron, e.g. "0 8 * * *" runs daily at 08:00.'
          >
            <Input value={cronExpr} onChange={(e) => setCronExpr(e.target.value)} placeholder="0 8 * * *" />
          </Field>
          <Field label="Time zone (IANA)">
            <Input value={tz} onChange={(e) => setTz(e.target.value)} placeholder="Asia/Bangkok" />
          </Field>
        </div>

        <CronHelper expr={cronExpr} tz={tz} />

        <Field label="Max USD per run">
          <Input
            type="number"
            min="0.01"
            step="0.01"
            value={maxUsd}
            onChange={(e) => setMaxUsd(e.target.value)}
          />
        </Field>

        {err ? <div className="text-xs text-red-500">{err}</div> : null}

        <div className="flex items-center justify-end gap-2 pt-2">
          <Button type="button" variant="outline" onClick={onClose} disabled={submitting}>
            Cancel
          </Button>
          <Button type="submit" disabled={submitting}>
            {submitting ? 'Creating…' : 'Create routine'}
          </Button>
        </div>
      </form>
    </div>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block space-y-1">
      <span className="block text-xs font-medium text-muted-foreground">{label}</span>
      {children}
      {hint ? <span className="block text-[11px] text-muted-foreground">{hint}</span> : null}
    </label>
  );
}

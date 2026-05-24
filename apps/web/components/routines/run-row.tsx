'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';

export interface RoutineRun {
  id: number;
  routineId: number;
  startedAt: string;
  finishedAt: string | null;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'skipped';
  outputMd: string | null;
  exportPath: string | null;
  usdSpent: string | null;
}

interface Props {
  run: RoutineRun;
  routineName: string;
}

type ExportFormat = 'md' | 'docx' | 'pdf';

type ExportStatus =
  | { kind: 'idle' }
  | { kind: 'busy'; fmt: ExportFormat }
  | { kind: 'err'; msg: string };

const STATUS_COLOR: Record<RoutineRun['status'], string> = {
  pending: 'bg-zinc-500/20 text-zinc-300',
  running: 'bg-blue-500/20 text-blue-400',
  completed: 'bg-green-500/20 text-green-400',
  failed: 'bg-red-500/20 text-red-400',
  skipped: 'bg-yellow-500/20 text-yellow-400',
};

function fmtDate(s: string | null) {
  if (!s) return '—';
  try {
    return new Date(s).toLocaleString();
  } catch {
    return s;
  }
}

function safeFilename(s: string) {
  return s.replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 80) || 'routine';
}

export function RunRow({ run, routineName }: Props) {
  const [expanded, setExpanded] = useState(false);
  const [exportStatus, setExportStatus] = useState<ExportStatus>({ kind: 'idle' });

  async function doExport(fmt: ExportFormat) {
    if (!run.outputMd) return;
    setExportStatus({ kind: 'busy', fmt });
    try {
      const r = await fetch('/api/export', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          format: fmt,
          content_md: run.outputMd,
          filename: `${safeFilename(routineName)}-${run.id}.${fmt}`,
        }),
      });
      if (!r.ok) {
        setExportStatus({ kind: 'err', msg: `Export failed (${r.status})` });
        return;
      }
      const blob = await r.blob();
      const href = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = href;
      a.download = `${safeFilename(routineName)}-${run.id}.${fmt}`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(href);
      setExportStatus({ kind: 'idle' });
    } catch (err) {
      setExportStatus({ kind: 'err', msg: (err as Error).message });
    }
  }

  const canExport = run.status === 'completed' && !!run.outputMd;
  const busy = exportStatus.kind === 'busy';

  return (
    <div className="border border-border rounded-md p-3 text-sm space-y-2">
      <div className="flex items-center gap-3 flex-wrap">
        <span
          className={`inline-flex items-center rounded px-2 py-0.5 text-xs font-medium ${STATUS_COLOR[run.status]}`}
        >
          {run.status}
        </span>
        <span className="text-xs text-muted-foreground">
          started {fmtDate(run.startedAt)} · finished {fmtDate(run.finishedAt)}
        </span>
        {run.usdSpent ? (
          <span className="text-xs text-muted-foreground">
            ${Number(run.usdSpent).toFixed(4)}
          </span>
        ) : null}
        <div className="ml-auto flex items-center gap-1">
          <Button
            size="sm"
            variant="ghost"
            onClick={() => setExpanded((v) => !v)}
            disabled={!run.outputMd}
          >
            {expanded ? 'Hide' : 'View output'}
          </Button>
        </div>
      </div>

      {canExport ? (
        <div className="flex items-center gap-2">
          <span className="text-xs text-muted-foreground">Export:</span>
          {(['md', 'docx', 'pdf'] as const).map((fmt) => (
            <Button
              key={fmt}
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() => doExport(fmt)}
            >
              {busy && exportStatus.fmt === fmt ? `${fmt.toUpperCase()}…` : fmt.toUpperCase()}
            </Button>
          ))}
          {exportStatus.kind === 'err' ? (
            <span className="text-xs text-red-500">{exportStatus.msg}</span>
          ) : null}
        </div>
      ) : null}

      {expanded && run.outputMd ? (
        <pre className="mt-2 max-h-96 overflow-auto rounded bg-muted/30 p-3 text-xs whitespace-pre-wrap break-words">
          {run.outputMd}
        </pre>
      ) : null}
    </div>
  );
}

'use client';

import { useMemo } from 'react';
import { CronExpressionParser } from 'cron-parser';

interface Props {
  expr: string;
  tz: string;
}

/**
 * Renders a small live preview of the next 3 fire times for a cron
 * expression in the chosen TZ. Pure client-side — uses `cron-parser`,
 * which is already a dep of the app. If parsing fails we show a red
 * inline error rather than the preview.
 */
export function CronHelper({ expr, tz }: Props) {
  const result = useMemo(() => {
    const trimmed = expr.trim();
    if (!trimmed) return { ok: false as const, err: 'enter a cron expression' };
    try {
      const it = CronExpressionParser.parse(trimmed, { tz: tz || 'UTC' });
      const times: Date[] = [];
      for (let i = 0; i < 3; i++) times.push(it.next().toDate());
      return { ok: true as const, times };
    } catch (err) {
      return { ok: false as const, err: (err as Error).message };
    }
  }, [expr, tz]);

  if (!result.ok) {
    return <div className="text-xs text-red-500">Invalid cron: {result.err}</div>;
  }

  const fmt = new Intl.DateTimeFormat(undefined, {
    timeZone: tz || undefined,
    dateStyle: 'medium',
    timeStyle: 'short',
  });

  return (
    <div className="text-xs text-muted-foreground space-y-0.5">
      <div>Next 3 fires ({tz || 'UTC'}):</div>
      <ul className="pl-3 list-disc">
        {result.times.map((t, i) => (
          <li key={i}>{fmt.format(t)}</li>
        ))}
      </ul>
    </div>
  );
}

'use client';

import { useCallback } from 'react';
import { cn } from '@/lib/utils';

// ---------------------------------------------------------------------------
// Risk-tolerance options. Wire format — must match /api/picker/scan.
// The ordering is meaningful (low → aggressive) and the slider position
// derives its `value` from the array index, so don't shuffle.
// ---------------------------------------------------------------------------
export const RISK_TOLERANCES = [
  {
    id: 'low',
    label: 'Low',
    subtitle: 'e.g. retirees, conservative',
    blurb: 'Stable income, defensive, large-cap. Risk-protection >=70.',
  },
  {
    id: 'medium',
    label: 'Medium',
    subtitle: 'balanced portfolio',
    blurb: 'Balanced mix. Standard caps on boom-prob and risk-protection.',
  },
  {
    id: 'high',
    label: 'High',
    subtitle: 'growth-seeking',
    blurb: 'Growth-tilted, mid-cap, momentum OK. Risk-protection >=40.',
  },
  {
    id: 'aggressive',
    label: 'Aggressive',
    subtitle: 'e.g. day-trader, high-conviction',
    blurb: 'Speculative, small-cap, emerging tech. No risk-protection floor.',
  },
] as const;

export type RiskTolerance = (typeof RISK_TOLERANCES)[number]['id'];

interface Props {
  value: RiskTolerance;
  onChange: (next: RiskTolerance) => void;
}

export function RiskToleranceSlider({ value, onChange }: Props) {
  // Slider position = index of selected option. Native range input gives us
  // keyboard nav + screen-reader value-now for free, then we render visual
  // "stops" on top so it doesn't look like a generic Windows 95 slider.
  const idx = Math.max(
    0,
    RISK_TOLERANCES.findIndex((r) => r.id === value),
  );
  const current = RISK_TOLERANCES[idx] ?? RISK_TOLERANCES[1];

  const onSliderChange = useCallback(
    (n: number) => {
      const clamped = Math.min(RISK_TOLERANCES.length - 1, Math.max(0, n));
      const next = RISK_TOLERANCES[clamped];
      if (next && next.id !== value) onChange(next.id);
    },
    [onChange, value],
  );

  return (
    <div className="flex flex-col gap-4">
      {/* Stop labels — clickable so users on a wide screen can jump rather
          than dragging. On narrow screens these stack visually below. */}
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        {RISK_TOLERANCES.map((r, i) => {
          const selected = r.id === value;
          return (
            <button
              key={r.id}
              type="button"
              role="radio"
              aria-checked={selected}
              onClick={() => onSliderChange(i)}
              className={cn(
                'flex flex-col items-start gap-0.5 rounded-md border p-3 text-left transition-colors',
                'hover:border-foreground/40 hover:bg-accent',
                'focus:outline-none focus-visible:ring-2 focus-visible:ring-foreground',
                selected
                  ? 'border-foreground bg-accent'
                  : 'border-border bg-transparent',
              )}
            >
              <span className="text-sm font-semibold">{r.label}</span>
              <span className="text-[11px] text-muted-foreground">
                {r.subtitle}
              </span>
            </button>
          );
        })}
      </div>

      {/* Native range — keeps a11y intact (keyboard arrows, value-now) while
          the visual selection happens in the cards above. */}
      <div className="flex flex-col gap-2">
        <input
          type="range"
          min={0}
          max={RISK_TOLERANCES.length - 1}
          step={1}
          value={idx}
          onChange={(e) => onSliderChange(Number(e.target.value))}
          aria-label="Risk tolerance"
          aria-valuetext={current?.label}
          className="w-full accent-foreground"
        />
        <div className="flex justify-between text-[10px] uppercase tracking-wide text-muted-foreground">
          {RISK_TOLERANCES.map((r) => (
            <span key={r.id}>{r.label}</span>
          ))}
        </div>
      </div>

      {/* Blurb for the current pick — sits below so the user can read a
          one-liner explaining what they're about to send to the model. */}
      <div className="rounded-md border border-border bg-accent/40 p-3 text-xs text-muted-foreground">
        <span className="font-medium text-foreground">{current?.label}:</span>{' '}
        {current?.blurb}
      </div>
    </div>
  );
}

'use client';

import { useEffect, useState } from 'react';
import { cn } from '@/lib/utils';

export type Effort = 'low' | 'medium' | 'high' | 'max';

const LS_KEY = (tab: string) => `aistock:effort:${tab}`;

const LEVELS: Array<{ value: Effort; label: string; hint: string }> = [
  { value: 'low', label: 'Low', hint: '3 tool calls · ≤1.5K tok · ~$0.05/turn' },
  { value: 'medium', label: 'Med', hint: '6 tool calls · ≤4K tok · ~$0.15/turn' },
  { value: 'high', label: 'High', hint: '12 tool calls · ≤8K tok · ~$0.40/turn · reasoning=high' },
  { value: 'max', label: 'Max', hint: '30 tool calls · ≤16K tok · ~$1.00/turn · reasoning=high' },
];

interface Props {
  tab: 'research' | 'analysis';
  onChange?: (e: Effort) => void;
}

/**
 * Tiny segmented picker for chat effort. Persists per-tab in localStorage.
 * Exposed effort is read by the chat client and posted in the request body.
 */
export function EffortPicker({ tab, onChange }: Props) {
  const [effort, setEffortState] = useState<Effort>('medium');
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    try {
      const raw = localStorage.getItem(LS_KEY(tab));
      if (raw && ['low', 'medium', 'high', 'max'].includes(raw)) {
        setEffortState(raw as Effort);
      }
    } catch {
      /* ignore */
    }
    setHydrated(true);
  }, [tab]);

  function set(e: Effort) {
    setEffortState(e);
    try {
      localStorage.setItem(LS_KEY(tab), e);
    } catch {
      /* ignore */
    }
    onChange?.(e);
  }

  if (!hydrated) return null;

  return (
    <div
      className="inline-flex items-center gap-px rounded-md border border-border bg-muted/30 p-0.5"
      role="radiogroup"
      aria-label="Effort"
    >
      {LEVELS.map((lv) => (
        <button
          key={lv.value}
          type="button"
          role="radio"
          aria-checked={effort === lv.value}
          onClick={() => set(lv.value)}
          title={lv.hint}
          className={cn(
            'rounded px-2 py-0.5 text-[10px] font-medium transition-colors',
            effort === lv.value
              ? 'bg-foreground text-background'
              : 'text-muted-foreground hover:text-foreground',
          )}
        >
          {lv.label}
        </button>
      ))}
    </div>
  );
}

export function getStoredEffort(tab: 'research' | 'analysis'): Effort {
  if (typeof window === 'undefined') return 'medium';
  try {
    const raw = localStorage.getItem(LS_KEY(tab));
    if (raw && ['low', 'medium', 'high', 'max'].includes(raw)) {
      return raw as Effort;
    }
  } catch {
    /* ignore */
  }
  return 'medium';
}

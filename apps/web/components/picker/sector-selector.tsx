'use client';

import { useCallback, useState, type KeyboardEvent } from 'react';
import { Plus, X } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

interface Props {
  options: readonly string[];
  value: string[];
  onChange: (next: string[]) => void;
  max: number;
}

// Normalize for dedupe — case-insensitive, trims whitespace, collapses inner
// runs. This means "  tech  " and "Tech" both round-trip to "Tech" and won't
// produce two chips.
function canonical(s: string): string {
  return s.trim().replace(/\s+/g, ' ');
}

function sameCanonical(a: string, b: string): boolean {
  return canonical(a).toLowerCase() === canonical(b).toLowerCase();
}

export function SectorSelector({ options, value, onChange, max }: Props) {
  const [draft, setDraft] = useState('');

  const isSelected = useCallback(
    (s: string) => value.some((v) => sameCanonical(v, s)),
    [value],
  );

  const atCap = value.length >= max;

  const toggle = useCallback(
    (s: string) => {
      const canon = canonical(s);
      if (!canon) return;
      if (isSelected(canon)) {
        onChange(value.filter((v) => !sameCanonical(v, canon)));
        return;
      }
      // Silently no-op past the cap rather than throwing — visually the
      // checkbox is already disabled, this is just defence in depth for the
      // custom-input path.
      if (value.length >= max) return;
      onChange([...value, canon]);
    },
    [isSelected, onChange, value, max],
  );

  const addCustom = useCallback(() => {
    const canon = canonical(draft);
    if (!canon) return;
    if (isSelected(canon)) {
      // Already there — clear the input so the user knows it landed.
      setDraft('');
      return;
    }
    if (value.length >= max) return;
    onChange([...value, canon]);
    setDraft('');
  }, [draft, isSelected, onChange, value, max]);

  const onDraftKey = useCallback(
    (e: KeyboardEvent<HTMLInputElement>) => {
      // Enter or comma both submit the chip. Comma is convenient when typing
      // a list off the top of your head ("Robotics, Drones, AI Infra").
      if (e.key === 'Enter' || e.key === ',') {
        e.preventDefault();
        addCustom();
      }
    },
    [addCustom],
  );

  const removeChip = useCallback(
    (s: string) => onChange(value.filter((v) => !sameCanonical(v, s))),
    [onChange, value],
  );

  // Split selected chips into "known" and "custom" only for the chip area —
  // the checkbox grid below shows known sectors as checkboxes already, and
  // we still want custom chips visible somewhere persistent. We render
  // ALL selected chips together at the top so users have a single
  // truthful view of what they're about to send.
  return (
    <div className="flex flex-col gap-4">
      {/* Selected chips — always visible, single source of truth. */}
      {value.length > 0 ? (
        <div className="flex flex-wrap gap-2">
          {value.map((s) => (
            <span
              key={s}
              className="inline-flex items-center gap-1.5 rounded-full border border-border bg-accent px-3 py-1 text-xs"
            >
              {s}
              <button
                type="button"
                onClick={() => removeChip(s)}
                className="rounded-full p-0.5 hover:bg-foreground/10"
                aria-label={`Remove ${s}`}
              >
                <X className="h-3 w-3" />
              </button>
            </span>
          ))}
        </div>
      ) : (
        <p className="text-xs text-muted-foreground">No sectors selected yet.</p>
      )}

      {/* Curated GICS-ish checkbox grid. */}
      <div
        role="group"
        aria-label="Sectors"
        className="grid grid-cols-1 gap-2 sm:grid-cols-2"
      >
        {options.map((opt) => {
          const checked = isSelected(opt);
          const disabled = !checked && atCap;
          return (
            <label
              key={opt}
              className={cn(
                'flex cursor-pointer items-center gap-2 rounded-md border px-3 py-2 text-sm transition-colors',
                checked
                  ? 'border-foreground bg-accent'
                  : 'border-border hover:bg-accent',
                disabled && 'cursor-not-allowed opacity-50 hover:bg-transparent',
              )}
            >
              <input
                type="checkbox"
                className="h-4 w-4 accent-foreground"
                checked={checked}
                disabled={disabled}
                onChange={() => toggle(opt)}
              />
              <span>{opt}</span>
            </label>
          );
        })}
      </div>

      {/* Custom sector input — adds a chip into the same selection state. */}
      <div className="flex flex-col gap-1.5">
        <label htmlFor="custom-sector" className="text-xs text-muted-foreground">
          Add a custom sector
        </label>
        <div className="flex gap-2">
          <Input
            id="custom-sector"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={onDraftKey}
            placeholder="e.g. Robotics, Drones, AI Infra"
            disabled={atCap}
            className="flex-1"
          />
          <Button
            type="button"
            variant="outline"
            onClick={addCustom}
            disabled={atCap || canonical(draft).length === 0}
            aria-label="Add custom sector"
          >
            <Plus className="h-4 w-4" />
            Add
          </Button>
        </div>
        {atCap ? (
          <p className="text-xs text-muted-foreground">
            Max {max} sectors. Remove one to add another.
          </p>
        ) : (
          <p className="text-xs text-muted-foreground">
            Press Enter or comma to add.
          </p>
        )}
      </div>
    </div>
  );
}

'use client';

import { useCallback, useState, type KeyboardEvent } from 'react';
import { Plus, Sparkles, X } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

// Stable id is what we send to the API — labels and emoji change freely
// without breaking the backend contract.
export interface Market {
  id: string;
  label: string;
  exchanges: string[];
}

// Curated list. The order roughly mirrors trading-day overlap with US session
// so a US-based user scrolling top-to-bottom moves chronologically through
// the day. Each `id` is the stable wire value — do not rename without coordinating
// with /api/picker/scan.
export const MARKETS: readonly Market[] = [
  { id: 'US', label: '\u{1F1FA}\u{1F1F8} US (NASDAQ/NYSE)', exchanges: ['NASDAQ', 'NYSE'] },
  { id: 'HK', label: '\u{1F1ED}\u{1F1F0} Hong Kong (HKEX)', exchanges: ['HKEX'] },
  { id: 'CN', label: '\u{1F1E8}\u{1F1F3} Shanghai / Shenzhen', exchanges: ['SSE', 'SZSE'] },
  { id: 'TH', label: '\u{1F1F9}\u{1F1ED} Thailand (SET)', exchanges: ['SET'] },
  { id: 'JP', label: '\u{1F1EF}\u{1F1F5} Japan (TSE)', exchanges: ['TSE'] },
  { id: 'KR', label: '\u{1F1F0}\u{1F1F7} Korea (KRX)', exchanges: ['KRX'] },
  { id: 'UK', label: '\u{1F1EC}\u{1F1E7} UK (LSE)', exchanges: ['LSE'] },
  { id: 'DE', label: '\u{1F1E9}\u{1F1EA} Germany (Xetra)', exchanges: ['XETR'] },
  { id: 'FR', label: '\u{1F1EB}\u{1F1F7} France (Euronext)', exchanges: ['EPA'] },
  { id: 'TW', label: '\u{1F1F9}\u{1F1FC} Taiwan (TWSE)', exchanges: ['TWSE'] },
] as const;

// Contract surfaced to picker-client. Three mutually-exclusive intents share
// this shape so the API can stay single-endpoint:
//   - autoPickMarket = true                  → backend picks the booming market(s)
//   - market != null                         → predefined exchange scan
//   - customCountries.length > 0             → free-form country list
// The picker-client validates "at least one of the three is set" before POST.
export interface MarketSelection {
  market: Market | null;
  customCountries: string[];
  autoPickMarket: boolean;
}

interface Props {
  markets: readonly Market[];
  value: MarketSelection;
  onChange: (next: MarketSelection) => void;
  /** Max custom-country chips before the input disables. Defensive cap, not a
   *  hard product requirement — just keeps the query string sane. */
  maxCustomCountries?: number;
}

const DEFAULT_MAX_COUNTRIES = 8;

function canonical(s: string): string {
  return s.trim().replace(/\s+/g, ' ');
}
function sameCanonical(a: string, b: string): boolean {
  return canonical(a).toLowerCase() === canonical(b).toLowerCase();
}

export function MarketSelector({
  markets,
  value,
  onChange,
  maxCustomCountries = DEFAULT_MAX_COUNTRIES,
}: Props) {
  const { market, customCountries, autoPickMarket } = value;
  const [draft, setDraft] = useState('');

  const toggleAuto = useCallback(() => {
    // Selecting auto blanks the other two intents — they're mutually exclusive
    // by product spec and we want the UI to make that obvious without a
    // separate "deselect first" step.
    if (autoPickMarket) {
      onChange({ market: null, customCountries: [], autoPickMarket: false });
    } else {
      onChange({ market: null, customCountries: [], autoPickMarket: true });
    }
  }, [autoPickMarket, onChange]);

  const selectMarket = useCallback(
    (m: Market) => {
      // Selecting a predefined market clears auto + customCountries to keep
      // the API contract unambiguous about which intent the user picked.
      onChange({ market: m, customCountries: [], autoPickMarket: false });
    },
    [onChange],
  );

  const atCountryCap = customCountries.length >= maxCustomCountries;

  const addCountry = useCallback(() => {
    const canon = canonical(draft);
    if (!canon) return;
    if (customCountries.some((c) => sameCanonical(c, canon))) {
      setDraft('');
      return;
    }
    if (customCountries.length >= maxCustomCountries) return;
    // Adding a country implicitly turns off auto and clears the predefined
    // market — same exclusivity rule as the auto toggle above.
    onChange({
      market: null,
      customCountries: [...customCountries, canon],
      autoPickMarket: false,
    });
    setDraft('');
  }, [draft, customCountries, maxCustomCountries, onChange]);

  const removeCountry = useCallback(
    (s: string) => {
      onChange({
        ...value,
        customCountries: customCountries.filter((c) => !sameCanonical(c, s)),
      });
    },
    [customCountries, onChange, value],
  );

  const onDraftKey = useCallback(
    (e: KeyboardEvent<HTMLInputElement>) => {
      // Enter and comma both submit so users can paste "Singapore, Vietnam,
      // India" or type them one at a time — both feel natural.
      if (e.key === 'Enter' || e.key === ',') {
        e.preventDefault();
        addCountry();
      }
    },
    [addCountry],
  );

  return (
    <div className="flex flex-col gap-5">
      {/* Auto-pick toggle — top-level prominent because it's the "I don't
          want to think about it" path. Looks like a checkbox/button hybrid
          (button semantics, aria-pressed for accessibility). */}
      <button
        type="button"
        onClick={toggleAuto}
        aria-pressed={autoPickMarket}
        className={cn(
          'group flex items-center justify-between gap-3 rounded-lg border p-4 text-left transition-colors',
          'hover:border-foreground/40 hover:bg-accent',
          'focus:outline-none focus-visible:ring-2 focus-visible:ring-foreground',
          autoPickMarket ? 'border-foreground bg-accent' : 'border-border',
        )}
      >
        <div className="flex items-center gap-3">
          <Sparkles
            className={cn(
              'h-5 w-5 shrink-0 transition-colors',
              autoPickMarket ? 'text-foreground' : 'text-muted-foreground',
            )}
          />
          <div className="flex flex-col">
            <span className="text-sm font-medium">
              Auto-pick most likely booming markets
            </span>
            <span className="text-xs text-muted-foreground">
              Let the AI choose the market(s) showing the strongest momentum right now.
            </span>
          </div>
        </div>
        <span
          className={cn(
            'rounded-full border px-2 py-0.5 text-xs font-medium transition-colors',
            autoPickMarket
              ? 'border-foreground bg-foreground text-background'
              : 'border-border text-muted-foreground',
          )}
        >
          {autoPickMarket ? 'On' : 'Off'}
        </span>
      </button>

      {/* Predefined markets grid. Visually dimmed when auto is on so the
          user understands the exclusivity without us having to disable the
          buttons outright (clicking still works and turns auto off). */}
      <div>
        <div className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
          Pick a market
        </div>
        <div
          role="radiogroup"
          aria-label="Market"
          className={cn(
            'grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 transition-opacity',
            autoPickMarket && 'opacity-50',
          )}
        >
          {markets.map((m) => {
            const selected = !autoPickMarket && market?.id === m.id;
            return (
              <button
                key={m.id}
                type="button"
                role="radio"
                aria-checked={selected}
                onClick={() => selectMarket(m)}
                className={cn(
                  'group flex flex-col items-start gap-1 rounded-lg border p-4 text-left transition-colors',
                  'hover:border-foreground/40 hover:bg-accent',
                  'focus:outline-none focus-visible:ring-2 focus-visible:ring-foreground',
                  selected
                    ? 'border-foreground bg-accent'
                    : 'border-border bg-transparent',
                )}
              >
                <span className="text-base font-medium">{m.label}</span>
                <span className="text-xs text-muted-foreground">
                  {m.exchanges.join(' · ')}
                </span>
              </button>
            );
          })}
        </div>
      </div>

      {/* Custom-country chip input. Lives below the market grid because it's
          the "I want something specific that isn't listed" escape hatch. */}
      <div className="flex flex-col gap-2">
        <label
          htmlFor="custom-country"
          className="text-xs font-medium uppercase tracking-wide text-muted-foreground"
        >
          Or specify countries (free-form)
        </label>

        {customCountries.length > 0 ? (
          <div className="flex flex-wrap gap-2">
            {customCountries.map((c) => (
              <span
                key={c}
                className="inline-flex items-center gap-1.5 rounded-full border border-border bg-accent px-3 py-1 text-xs"
              >
                {c}
                <button
                  type="button"
                  onClick={() => removeCountry(c)}
                  className="rounded-full p-0.5 hover:bg-foreground/10"
                  aria-label={`Remove ${c}`}
                >
                  <X className="h-3 w-3" />
                </button>
              </span>
            ))}
          </div>
        ) : null}

        <div className="flex gap-2">
          <Input
            id="custom-country"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={onDraftKey}
            placeholder="e.g. Singapore, Vietnam, India, Brazil"
            disabled={atCountryCap}
            className="flex-1"
          />
          <Button
            type="button"
            variant="outline"
            onClick={addCountry}
            disabled={atCountryCap || canonical(draft).length === 0}
            aria-label="Add country"
          >
            <Plus className="h-4 w-4" />
            Add
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">
          {atCountryCap
            ? `Max ${maxCustomCountries} countries. Remove one to add another.`
            : 'Press Enter or comma to add. Adding a country clears the market selection above.'}
        </p>
      </div>
    </div>
  );
}

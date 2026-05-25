'use client';

import { useCallback } from 'react';
import { cn } from '@/lib/utils';

// ---------------------------------------------------------------------------
// Stock-type catalogue. The 16 keys here ARE the wire format — /api/picker/scan
// must mirror this enum. Adding a new type means updating both ends.
// Each entry carries a short user-facing description and a "key metrics" hint
// so the card can explain itself without a tooltip.
// ---------------------------------------------------------------------------
export const STOCK_TYPES = [
  {
    id: 'growth',
    label: 'Growth',
    description: 'High revenue/EPS growth, often unprofitable early-stage.',
    metrics: 'Revenue YoY >20%, EPS growth, gross-margin trend.',
  },
  {
    id: 'value',
    label: 'Value',
    description: 'Undervalued by traditional metrics.',
    metrics: 'P/E <15, P/B <1.5, FCF yield >5%.',
  },
  {
    id: 'dividend',
    label: 'Dividend',
    description: 'High sustainable yield from stable payers.',
    metrics: 'Yield >3%, payout ratio <70%, dividend growth >=5y.',
  },
  {
    id: 'garp',
    label: 'GARP',
    description: 'Growth at a reasonable price.',
    metrics: 'PEG <1, growth + reasonable valuation combo.',
  },
  {
    id: 'quality',
    label: 'Quality',
    description: 'Durable moat and clean balance sheet.',
    metrics: 'ROE >15%, debt/equity <0.5, consistent FCF.',
  },
  {
    id: 'momentum',
    label: 'Momentum',
    description: 'Strong recent uptrend riding a catalyst.',
    metrics: '6m return >15%, RSI 60-75, breakout pattern.',
  },
  {
    id: 'defensive',
    label: 'Defensive',
    description: 'Recession-resistant, low beta.',
    metrics: 'Beta <0.8, staples/healthcare/utilities exposure.',
  },
  {
    id: 'cyclical',
    label: 'Cyclical',
    description: 'Sensitive to the economic cycle.',
    metrics: 'Beta >1, industrials/financials/materials/autos.',
  },
  {
    // NOTE: ids use underscores (small_cap, mid_cap, large_cap, emerging_tech)
    // to MATCH the /api/picker/scan Zod enum. Hyphens here would 400 the
    // request — found and fixed in commit after the first picker rollout.
    id: 'small_cap',
    label: 'Small-cap',
    description: 'Higher growth potential and volatility.',
    metrics: 'Market cap <$2B.',
  },
  {
    id: 'mid_cap',
    label: 'Mid-cap',
    description: 'Balanced growth-vs-stability profile.',
    metrics: 'Market cap $2B-$10B.',
  },
  {
    id: 'large_cap',
    label: 'Large-cap',
    description: 'Stable, liquid market leaders.',
    metrics: 'Market cap >$10B.',
  },
  {
    id: 'speculative',
    label: 'Speculative',
    description: 'High risk / high reward, often pre-revenue.',
    metrics: 'Catalyst-driven, low float, binary outcomes.',
  },
  {
    id: 'income',
    label: 'Income',
    description: 'Stable cash flow tailored for income investors.',
    metrics: 'REITs, utilities, telcos, MLPs.',
  },
  {
    id: 'turnaround',
    label: 'Turnaround',
    description: 'Recovering from operational or financial trouble.',
    metrics: 'Revenue/margin inflection, new management.',
  },
  {
    id: 'emerging_tech',
    label: 'Emerging Tech',
    description: 'AI, biotech, EVs, robotics, quantum.',
    metrics: 'TAM expansion, R&D-heavy, frontier exposure.',
  },
  {
    id: 'esg',
    label: 'ESG',
    description: 'Strong sustainability ratings.',
    metrics: 'Low carbon, board diversity, supply-chain ethics.',
  },
] as const;

export type StockType = (typeof STOCK_TYPES)[number]['id'];

interface Props {
  value: StockType[];
  onChange: (next: StockType[]) => void;
  /** Soft cap — default 3 per spec. */
  max?: number;
}

const DEFAULT_MAX = 3;

export function StockTypeSelector({ value, onChange, max = DEFAULT_MAX }: Props) {
  const atCap = value.length >= max;

  const toggle = useCallback(
    (id: StockType) => {
      if (value.includes(id)) {
        onChange(value.filter((v) => v !== id));
        return;
      }
      // Silently no-op past cap — disabled styling already communicates this
      // visually, but defence-in-depth in case the click happens via keyboard.
      if (value.length >= max) return;
      onChange([...value, id]);
    },
    [value, onChange, max],
  );

  return (
    <div className="flex flex-col gap-3">
      <p className="text-xs text-muted-foreground">
        Optional. Pick up to {max}. Leave empty for "any type".
      </p>
      <div
        role="group"
        aria-label="Stock types"
        className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3"
      >
        {STOCK_TYPES.map((t) => {
          const selected = value.includes(t.id);
          const disabled = !selected && atCap;
          return (
            <button
              key={t.id}
              type="button"
              role="checkbox"
              aria-checked={selected}
              disabled={disabled}
              onClick={() => toggle(t.id)}
              className={cn(
                'group flex flex-col items-start gap-1 rounded-lg border p-3 text-left transition-colors',
                'hover:border-foreground/40 hover:bg-accent',
                'focus:outline-none focus-visible:ring-2 focus-visible:ring-foreground',
                selected
                  ? 'border-foreground bg-accent'
                  : 'border-border bg-transparent',
                disabled && 'cursor-not-allowed opacity-50 hover:bg-transparent hover:border-border',
              )}
            >
              <span className="text-sm font-semibold">{t.label}</span>
              <span className="text-xs text-muted-foreground">{t.description}</span>
              <span className="mt-1 text-[11px] leading-snug text-muted-foreground/80">
                <span className="font-medium text-muted-foreground">Key metrics:</span>{' '}
                {t.metrics}
              </span>
            </button>
          );
        })}
      </div>
      {atCap ? (
        <p className="text-xs text-muted-foreground">
          Max {max} types selected. Deselect one to swap.
        </p>
      ) : null}
    </div>
  );
}

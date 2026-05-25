'use client';

import { Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import { StockCardView } from '@/components/picker/stock-card';
import type { StockCard } from '@/app/picker/picker-client';

interface Props {
  cards: StockCard[];
  loading: boolean;
}

const SKELETON_COUNT = 6;

export function StockCardGrid({ cards, loading }: Props) {
  if (loading) {
    return (
      <div className="flex flex-col gap-3">
        <div
          role="status"
          aria-live="polite"
          className="flex items-center gap-2 text-sm text-muted-foreground"
        >
          <Loader2 className="h-4 w-4 animate-spin" />
          <span>
            Searching news across 10-20 sources... this may take 20-40 seconds.
          </span>
        </div>
        <SkeletonGrid />
      </div>
    );
  }

  if (cards.length === 0) {
    return (
      <div className="flex h-32 items-center justify-center text-sm text-muted-foreground">
        No stocks returned. Try a different market or sector.
      </div>
    );
  }

  return (
    <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
      {cards.map((c) => (
        // exchange + symbol uniquely identifies a listing (e.g. NESN exists on
        // both SIX and OTC); using either alone could produce duplicate keys.
        <StockCardView key={`${c.exchange}:${c.symbol}`} card={c} />
      ))}
    </div>
  );
}

function SkeletonGrid() {
  return (
    <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
      {Array.from({ length: SKELETON_COUNT }).map((_, i) => (
        // The shimmer is just an animated gradient on each block — no extra
        // CSS needed because Tailwind's `animate-pulse` already does this and
        // the bg-muted-ish colour works in both themes via `bg-accent`.
        <div
          key={i}
          className={cn(
            'flex max-h-[640px] min-h-[480px] flex-col gap-3 rounded-lg border border-border bg-background p-4',
            'animate-pulse',
          )}
        >
          <div className="h-5 w-24 rounded bg-accent" />
          <div className="h-3 w-40 rounded bg-accent" />
          <div className="h-3 w-32 rounded bg-accent" />
          <div className="mt-2 h-16 rounded bg-accent" />
          <div className="h-16 rounded bg-accent" />
          <div className="h-12 rounded bg-accent" />
          <div className="mt-auto flex gap-2">
            <div className="h-8 flex-1 rounded bg-accent" />
            <div className="h-8 flex-1 rounded bg-accent" />
          </div>
        </div>
      ))}
    </div>
  );
}

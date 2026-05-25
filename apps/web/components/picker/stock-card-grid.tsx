'use client';

import { StockCardView } from '@/components/picker/stock-card';
import { ScanProgress, type ScanEvent } from '@/components/picker/scan-progress';
import type { StockCard } from '@/app/picker/picker-client';

interface Props {
  cards: StockCard[];
  loading: boolean;
  // SSE-driven event log from picker-client. Optional + defaulted because the
  // /api/picker/scan agent ships the streaming endpoint separately — until it
  // lands, picker-client can omit this and we'll just render an empty
  // ScanProgress that ticks the elapsed timer.
  events?: ScanEvent[];
  // Epoch ms when the scan started. Optional for the same reason; defaults to
  // "now" at first render which gives a sensible 0s elapsed reading.
  startedAt?: number;
}

export function StockCardGrid({ cards, loading, events, startedAt }: Props) {
  if (loading) {
    // Live progress replaces the old skeleton placeholder. The component
    // self-ticks its elapsed timer so even a 0-event stream shows movement.
    return (
      <ScanProgress
        events={events ?? []}
        startedAt={startedAt ?? Date.now()}
      />
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

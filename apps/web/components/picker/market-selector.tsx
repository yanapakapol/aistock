'use client';

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

interface Props {
  markets: readonly Market[];
  value: Market | null;
  onSelect: (m: Market) => void;
}

export function MarketSelector({ markets, value, onSelect }: Props) {
  return (
    <div
      role="radiogroup"
      aria-label="Market"
      className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3"
    >
      {markets.map((m) => {
        const selected = value?.id === m.id;
        return (
          <button
            key={m.id}
            type="button"
            role="radio"
            aria-checked={selected}
            onClick={() => onSelect(m)}
            className={cn(
              'group flex flex-col items-start gap-1 rounded-lg border p-4 text-left transition-colors',
              'hover:border-foreground/40 hover:bg-accent',
              'focus:outline-none focus-visible:ring-2 focus-visible:ring-foreground',
              selected
                ? 'border-foreground bg-accent'
                : 'border-border bg-transparent',
            )}
          >
            <span className="text-lg font-medium">{m.label}</span>
            <span className="text-xs text-muted-foreground">
              {m.exchanges.join(' · ')}
            </span>
          </button>
        );
      })}
    </div>
  );
}

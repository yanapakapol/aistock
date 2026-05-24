'use client';

import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

export interface Bubble {
  id: string;
  label: string;
  prompt: string;
}

interface Props {
  bubbles: Bubble[];
  onPick: (b: Bubble) => void;
  disabled?: boolean;
  className?: string;
}

/**
 * Horizontal scrollable strip of pill-shaped prompt bubbles. Renders as small
 * ghost buttons. Fades the right edge when the row overflows.
 */
export function BubbleStrip({ bubbles, onPick, disabled, className }: Props) {
  return (
    <div className={cn('relative', className)}>
      <div
        className="flex gap-2 overflow-x-auto scroll-smooth pr-8 pb-1"
        style={{ scrollbarWidth: 'thin' }}
      >
        {bubbles.map((b) => (
          <Button
            key={b.id}
            type="button"
            variant="ghost"
            size="sm"
            disabled={disabled}
            onClick={() => onPick(b)}
            className="shrink-0 rounded-full border border-border whitespace-nowrap"
            title={b.prompt}
          >
            {b.label}
          </Button>
        ))}
      </div>
      {/* right-edge fade hint for overflow */}
      <div
        className="pointer-events-none absolute right-0 top-0 h-full w-8"
        style={{
          background:
            'linear-gradient(to right, transparent, hsl(var(--background)) 80%)',
        }}
      />
    </div>
  );
}

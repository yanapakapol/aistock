'use client';

interface Props {
  tokensIn: number;
  tokensOut: number;
  usd: number;
}

export function CostPill({ tokensIn, tokensOut, usd }: Props) {
  if (tokensIn === 0 && tokensOut === 0 && usd === 0) return null;
  const total = tokensIn + tokensOut;
  return (
    <div className="pointer-events-none fixed bottom-32 right-3 z-40 sm:bottom-24 sm:right-4">
      <div className="pointer-events-auto rounded-full border border-border bg-background/90 px-3 py-1 text-[11px] font-mono text-muted-foreground shadow-sm backdrop-blur">
        <span className="text-foreground">{total.toLocaleString()}</span> tokens
        <span className="mx-1.5 opacity-50">·</span>
        <span className="text-foreground">${usd.toFixed(4)}</span>
      </div>
    </div>
  );
}

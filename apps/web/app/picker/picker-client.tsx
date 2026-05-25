'use client';

import { useCallback, useMemo, useState } from 'react';
import { ChevronLeft, AlertTriangle, RotateCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { MARKETS, MarketSelector, type Market } from '@/components/picker/market-selector';
import { SectorSelector } from '@/components/picker/sector-selector';
import { StockCardGrid } from '@/components/picker/stock-card-grid';

// ---------------------------------------------------------------------------
// PUBLIC CONTRACT — the parallel agent owning /api/picker/scan must mirror this
// shape exactly. Importing from this file keeps the two ends in lockstep
// without either side having to depend on a shared package.
//
// Numbers are 0-100 for both bars (boomProbability + riskProtection). For
// riskProtection, HIGHER means SAFER — we render it green→red left to right
// in the card so the visual matches that orientation. The API agent should
// pre-clamp to [0,100]; the renderer also clamps defensively because LLM
// output is famously creative about staying in range.
// ---------------------------------------------------------------------------
export interface StockCard {
  symbol: string;
  exchange: string;
  name: string;
  industry: string;
  industryContext: string;
  financialStatus: string;
  performance: {
    '1m'?: number;
    '3m'?: number;
    '1y'?: number;
    note?: string;
  };
  upcomingEvents: Array<{ date: string; title: string }>;
  boomProbability: number; // 0-100
  boomTriggers: string[];
  riskProtection: number; // 0-100, higher = safer
  riskWhy: string;
  consensus: string;
  sources: string[]; // 1-3 cited URLs
  // Optional pre-fetched quote so the card can render a live price line even
  // before the per-symbol /api/stocks/quote round-trip. Strictly best-effort
  // — the card renders fine without it.
  price?: number;
  changePct?: number;
  currency?: string;
}

export interface PickerScanResponse {
  cards: StockCard[];
  sources: string[];
}

// Curated list — keep small enough to scan visually but cover the 11 GICS
// sectors. The `+ Custom sector` chip flow inside SectorSelector lets users
// add anything missing without us having to ship a 200-entry industry tree.
export const DEFAULT_SECTORS = [
  'Technology',
  'Healthcare',
  'Financials',
  'Consumer Discretionary',
  'Consumer Staples',
  'Industrials',
  'Energy',
  'Materials',
  'Utilities',
  'Real Estate',
  'Communication Services',
] as const;

const MAX_SECTORS = 5;

type Step = 1 | 2 | 3;

interface ScanState {
  status: 'idle' | 'loading' | 'success' | 'error';
  cards: StockCard[];
  sources: string[];
  error: string | null;
}

const INITIAL_SCAN: ScanState = {
  status: 'idle',
  cards: [],
  sources: [],
  error: null,
};

export function PickerClient() {
  const [step, setStep] = useState<Step>(1);
  const [market, setMarket] = useState<Market | null>(null);
  const [sectors, setSectors] = useState<string[]>([]);
  const [scan, setScan] = useState<ScanState>(INITIAL_SCAN);

  const canSubmit = sectors.length >= 1 && sectors.length <= MAX_SECTORS && !!market;

  const runScan = useCallback(async () => {
    if (!market || sectors.length === 0) return;
    setScan({ status: 'loading', cards: [], sources: [], error: null });
    setStep(3);
    try {
      const res = await fetch('/api/picker/scan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ market: market.id, sectors }),
      });
      if (!res.ok) {
        // Best-effort to surface server-shaped errors; fall back to status text
        // if the body isn't JSON or doesn't include a message.
        let msg = `Scan failed (${res.status})`;
        try {
          const j = (await res.json()) as { error?: string; detail?: string };
          if (j?.error) msg = j.detail ? `${j.error}: ${j.detail}` : j.error;
        } catch {
          /* non-JSON body — keep status-based message */
        }
        throw new Error(msg);
      }
      const data = (await res.json()) as PickerScanResponse;
      const cards = Array.isArray(data?.cards) ? data.cards : [];
      const sources = Array.isArray(data?.sources) ? data.sources : [];
      setScan({ status: 'success', cards, sources, error: null });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      setScan({ status: 'error', cards: [], sources: [], error: message });
    }
  }, [market, sectors]);

  const resetToStart = useCallback(() => {
    setStep(1);
    setMarket(null);
    setSectors([]);
    setScan(INITIAL_SCAN);
  }, []);

  const goBack = useCallback(() => {
    if (step === 3) {
      // Don't keep stale results behind the back button — if the user goes
      // back to tweak sectors they almost certainly want a fresh scan, not
      // the previous one half-visible underneath.
      setScan(INITIAL_SCAN);
      setStep(2);
    } else if (step === 2) {
      setStep(1);
    }
  }, [step]);

  // Memoize the markets array reference — MARKETS is module-level so this is
  // really just to keep the prop identity stable across re-renders.
  const markets = useMemo(() => MARKETS, []);

  return (
    <div className="flex h-full flex-col overflow-hidden">
      {/* Header — step indicator + back button. Sticky-ish via flex layout
          rather than position:sticky so the inner scroll containers (results
          grid in step 3) work without a z-index war. */}
      <div className="flex shrink-0 items-center justify-between border-b border-border px-4 py-3">
        <div className="flex items-center gap-3">
          {step > 1 ? (
            <Button
              variant="ghost"
              size="sm"
              onClick={goBack}
              aria-label="Back"
            >
              <ChevronLeft className="h-4 w-4" />
              Back
            </Button>
          ) : null}
          <h1 className="text-base font-semibold">Stock Picker</h1>
        </div>
        <StepDots step={step} />
      </div>

      {/* Body — single scroll container per step. overflow-hidden on the
          outer flex column + overflow-y-auto here prevents the page itself
          from scrolling horizontally even when a 3-up card grid is wider
          than the viewport on a narrow window. */}
      <div className="flex-1 overflow-y-auto overflow-x-hidden p-4">
        {step === 1 ? (
          <Step1
            markets={markets}
            value={market}
            onSelect={(m) => {
              setMarket(m);
              setStep(2);
            }}
          />
        ) : null}

        {step === 2 ? (
          <Step2
            market={market!}
            sectors={sectors}
            setSectors={setSectors}
            canSubmit={canSubmit}
            onSubmit={runScan}
          />
        ) : null}

        {step === 3 ? (
          <Step3
            status={scan.status}
            cards={scan.cards}
            error={scan.error}
            onRetry={runScan}
            onReset={resetToStart}
          />
        ) : null}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Step shells — kept in this file because they're thin composition wrappers
// and don't need to be reused. The chunky parts (market grid, sector chips,
// card grid) are in components/picker/*.
// ---------------------------------------------------------------------------

function Step1({
  markets,
  value,
  onSelect,
}: {
  markets: readonly Market[];
  value: Market | null;
  onSelect: (m: Market) => void;
}) {
  return (
    <section className="mx-auto max-w-4xl">
      <h2 className="mb-1 text-lg font-semibold">Choose a market</h2>
      <p className="mb-4 text-sm text-muted-foreground">
        Pick the exchange or region you want to scan.
      </p>
      <MarketSelector markets={markets} value={value} onSelect={onSelect} />
    </section>
  );
}

function Step2({
  market,
  sectors,
  setSectors,
  canSubmit,
  onSubmit,
}: {
  market: Market;
  sectors: string[];
  setSectors: (s: string[]) => void;
  canSubmit: boolean;
  onSubmit: () => void;
}) {
  return (
    <section className="mx-auto flex max-w-4xl flex-col gap-4">
      <div>
        <h2 className="mb-1 text-lg font-semibold">Choose sectors</h2>
        <p className="text-sm text-muted-foreground">
          Market: <span className="font-medium text-foreground">{market.label}</span> ·
          Pick 1 to {MAX_SECTORS} sectors.
        </p>
      </div>
      <SectorSelector
        options={DEFAULT_SECTORS}
        value={sectors}
        onChange={setSectors}
        max={MAX_SECTORS}
      />
      <div className="sticky bottom-0 -mx-4 mt-2 border-t border-border bg-background/95 px-4 py-3 backdrop-blur">
        <Button
          onClick={onSubmit}
          disabled={!canSubmit}
          className="w-full sm:w-auto"
        >
          Find Stocks
          {sectors.length > 0 ? (
            <span className="ml-1 text-xs opacity-70">
              ({sectors.length}/{MAX_SECTORS})
            </span>
          ) : null}
        </Button>
      </div>
    </section>
  );
}

function Step3({
  status,
  cards,
  error,
  onRetry,
  onReset,
}: {
  status: ScanState['status'];
  cards: StockCard[];
  error: string | null;
  onRetry: () => void;
  onReset: () => void;
}) {
  if (status === 'error') {
    return (
      <section className="mx-auto max-w-4xl">
        <div
          role="alert"
          className="flex flex-col gap-3 rounded-md border border-red-500/40 bg-red-500/10 p-4 text-sm text-red-200"
        >
          <div className="flex items-start gap-2">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
            <div>
              <div className="font-medium">Scan failed</div>
              <div className="mt-1 break-words opacity-90">
                {error ?? 'Unknown error'}
              </div>
            </div>
          </div>
          <div className="flex gap-2">
            <Button size="sm" onClick={onRetry}>
              <RotateCw className="h-3.5 w-3.5" />
              Try again
            </Button>
            <Button size="sm" variant="outline" onClick={onReset}>
              Start over
            </Button>
          </div>
        </div>
      </section>
    );
  }

  return (
    <section className="mx-auto max-w-7xl">
      <StockCardGrid
        cards={cards}
        loading={status === 'loading'}
      />
    </section>
  );
}

// ---------------------------------------------------------------------------
// Step dots — tiny visual indicator. Pure decoration; the real step gate is
// the back button and Find Stocks button.
// ---------------------------------------------------------------------------
function StepDots({ step }: { step: Step }) {
  return (
    <div className="flex items-center gap-1.5" aria-label={`Step ${step} of 3`}>
      {[1, 2, 3].map((n) => (
        <span
          key={n}
          className={cn(
            'h-1.5 w-6 rounded-full transition-colors',
            n <= step ? 'bg-foreground' : 'bg-border',
          )}
        />
      ))}
    </div>
  );
}

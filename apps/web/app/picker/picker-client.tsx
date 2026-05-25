'use client';

import { useCallback, useMemo, useState } from 'react';
import { ChevronLeft, AlertTriangle, RotateCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import {
  MARKETS,
  MarketSelector,
  type Market,
  type MarketSelection,
} from '@/components/picker/market-selector';
import { SectorSelector } from '@/components/picker/sector-selector';
import {
  StockTypeSelector,
  type StockType,
} from '@/components/picker/stock-type-selector';
import {
  RiskToleranceSlider,
  type RiskTolerance,
} from '@/components/picker/risk-tolerance-slider';
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

// Re-export the new wire-level enums so the API agent can `import type` them
// from a single canonical location without us shipping a shared package.
export type { StockType } from '@/components/picker/stock-type-selector';
export type { RiskTolerance } from '@/components/picker/risk-tolerance-slider';

// Wire shape for the POST body. Keeps the API contract explicit and lets the
// parallel /api/picker/scan agent import this type instead of re-deriving it.
export interface PickerScanRequest {
  /** Predefined market id, or null when using customCountries / auto. */
  market: string | null;
  /** Free-form country names. Empty array when not used. */
  customCountries: string[];
  /** True when the user wants the model to pick the booming market(s). */
  autoPickMarket: boolean;
  sectors: string[];
  stockTypes: StockType[];
  riskTolerance: RiskTolerance;
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

type Step = 1 | 2 | 3 | 4;

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

const INITIAL_MARKET_SELECTION: MarketSelection = {
  market: null,
  customCountries: [],
  autoPickMarket: false,
};

// "Have they picked something that uniquely identifies an intent for step 1?"
// Co-located with the component so the back/next gating reads off a single
// source of truth.
function hasMarketIntent(sel: MarketSelection): boolean {
  return sel.autoPickMarket || !!sel.market || sel.customCountries.length > 0;
}

export function PickerClient() {
  const [step, setStep] = useState<Step>(1);
  const [marketSel, setMarketSel] = useState<MarketSelection>(INITIAL_MARKET_SELECTION);
  const [sectors, setSectors] = useState<string[]>([]);
  const [stockTypes, setStockTypes] = useState<StockType[]>([]);
  const [risk, setRisk] = useState<RiskTolerance>('medium');
  const [scan, setScan] = useState<ScanState>(INITIAL_SCAN);

  // Per-step gating — keep these derived rather than stored so we never have
  // a stale "can I advance" boolean lurking in state.
  const canAdvanceStep1 = hasMarketIntent(marketSel);
  const canAdvanceStep2 = sectors.length >= 1 && sectors.length <= MAX_SECTORS;
  const canSubmit = canAdvanceStep1 && canAdvanceStep2; // stock-types optional, risk has default

  const runScan = useCallback(async () => {
    if (!canSubmit) return;
    setScan({ status: 'loading', cards: [], sources: [], error: null });
    setStep(4);

    const body: PickerScanRequest = {
      market: marketSel.market?.id ?? null,
      customCountries: marketSel.customCountries,
      autoPickMarket: marketSel.autoPickMarket,
      sectors,
      stockTypes,
      riskTolerance: risk,
    };

    try {
      const res = await fetch('/api/picker/scan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
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
  }, [canSubmit, marketSel, sectors, stockTypes, risk]);

  const resetToStart = useCallback(() => {
    setStep(1);
    setMarketSel(INITIAL_MARKET_SELECTION);
    setSectors([]);
    setStockTypes([]);
    setRisk('medium');
    setScan(INITIAL_SCAN);
  }, []);

  const goBack = useCallback(() => {
    if (step === 4) {
      // Don't keep stale results behind the back button — if the user goes
      // back to tweak inputs they almost certainly want a fresh scan, not
      // the previous one half-visible underneath.
      setScan(INITIAL_SCAN);
      setStep(3);
    } else if (step === 3) {
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
          grid in step 4) work without a z-index war. */}
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
            value={marketSel}
            onChange={setMarketSel}
            canAdvance={canAdvanceStep1}
            onNext={() => setStep(2)}
          />
        ) : null}

        {step === 2 ? (
          <Step2
            marketSel={marketSel}
            sectors={sectors}
            setSectors={setSectors}
            canAdvance={canAdvanceStep2}
            onNext={() => setStep(3)}
          />
        ) : null}

        {step === 3 ? (
          <Step3
            stockTypes={stockTypes}
            setStockTypes={setStockTypes}
            risk={risk}
            setRisk={setRisk}
            canSubmit={canSubmit}
            onSubmit={runScan}
          />
        ) : null}

        {step === 4 ? (
          <Step4
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
// stock-type cards, risk slider, card grid) are in components/picker/*.
// ---------------------------------------------------------------------------

function Step1({
  markets,
  value,
  onChange,
  canAdvance,
  onNext,
}: {
  markets: readonly Market[];
  value: MarketSelection;
  onChange: (next: MarketSelection) => void;
  canAdvance: boolean;
  onNext: () => void;
}) {
  return (
    <section className="mx-auto flex max-w-4xl flex-col gap-4">
      <div>
        <h2 className="mb-1 text-lg font-semibold">Choose a market</h2>
        <p className="text-sm text-muted-foreground">
          Pick an exchange, type specific countries, or let us auto-pick.
        </p>
      </div>
      <MarketSelector markets={markets} value={value} onChange={onChange} />
      <StickyFooter>
        <Button
          onClick={onNext}
          disabled={!canAdvance}
          className="w-full sm:w-auto"
        >
          Next
        </Button>
      </StickyFooter>
    </section>
  );
}

function Step2({
  marketSel,
  sectors,
  setSectors,
  canAdvance,
  onNext,
}: {
  marketSel: MarketSelection;
  sectors: string[];
  setSectors: (s: string[]) => void;
  canAdvance: boolean;
  onNext: () => void;
}) {
  return (
    <section className="mx-auto flex max-w-4xl flex-col gap-4">
      <div>
        <h2 className="mb-1 text-lg font-semibold">Choose sectors</h2>
        <p className="text-sm text-muted-foreground">
          Scanning: <MarketSummary sel={marketSel} /> · Pick 1 to {MAX_SECTORS} sectors.
        </p>
      </div>
      <SectorSelector
        options={DEFAULT_SECTORS}
        value={sectors}
        onChange={setSectors}
        max={MAX_SECTORS}
      />
      <StickyFooter>
        <Button
          onClick={onNext}
          disabled={!canAdvance}
          className="w-full sm:w-auto"
        >
          Next
          {sectors.length > 0 ? (
            <span className="ml-1 text-xs opacity-70">
              ({sectors.length}/{MAX_SECTORS})
            </span>
          ) : null}
        </Button>
      </StickyFooter>
    </section>
  );
}

function Step3({
  stockTypes,
  setStockTypes,
  risk,
  setRisk,
  canSubmit,
  onSubmit,
}: {
  stockTypes: StockType[];
  setStockTypes: (next: StockType[]) => void;
  risk: RiskTolerance;
  setRisk: (next: RiskTolerance) => void;
  canSubmit: boolean;
  onSubmit: () => void;
}) {
  return (
    <section className="mx-auto flex max-w-4xl flex-col gap-6">
      <div>
        <h2 className="mb-1 text-lg font-semibold">Style and risk</h2>
        <p className="text-sm text-muted-foreground">
          Tune what kind of stocks you want and how much risk to allow.
        </p>
      </div>

      <div className="flex flex-col gap-2">
        <h3 className="text-sm font-semibold">Stock type</h3>
        <StockTypeSelector value={stockTypes} onChange={setStockTypes} />
      </div>

      <div className="flex flex-col gap-2">
        <h3 className="text-sm font-semibold">Risk tolerance</h3>
        <RiskToleranceSlider value={risk} onChange={setRisk} />
      </div>

      <StickyFooter>
        <Button
          onClick={onSubmit}
          disabled={!canSubmit}
          className="w-full sm:w-auto"
        >
          Find Stocks
        </Button>
      </StickyFooter>
    </section>
  );
}

function Step4({
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

  // NOTE: The richer scan-progress UI lives in components/picker/scan-progress.tsx,
  // which is owned by a parallel agent. Until that ships we lean on the
  // existing grid's loading skeleton — it's a complete fallback, not a stub.
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
// Shared bits — kept inline to avoid yet another file for tiny presentational
// wrappers.
// ---------------------------------------------------------------------------

function StickyFooter({ children }: { children: React.ReactNode }) {
  return (
    <div className="sticky bottom-0 -mx-4 mt-2 border-t border-border bg-background/95 px-4 py-3 backdrop-blur">
      {children}
    </div>
  );
}

function MarketSummary({ sel }: { sel: MarketSelection }) {
  if (sel.autoPickMarket) {
    return <span className="font-medium text-foreground">Auto-pick</span>;
  }
  if (sel.market) {
    return <span className="font-medium text-foreground">{sel.market.label}</span>;
  }
  if (sel.customCountries.length > 0) {
    return (
      <span className="font-medium text-foreground">
        {sel.customCountries.join(', ')}
      </span>
    );
  }
  return <span className="font-medium text-foreground">—</span>;
}

// Step dots — tiny visual indicator. Pure decoration; the real step gate is
// the back button and the per-step Next/Find Stocks button.
function StepDots({ step }: { step: Step }) {
  return (
    <div className="flex items-center gap-1.5" aria-label={`Step ${step} of 4`}>
      {[1, 2, 3, 4].map((n) => (
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

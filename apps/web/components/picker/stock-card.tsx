'use client';

import { useCallback, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  ArrowRight,
  Calendar,
  Check,
  Loader2,
  Plus,
  ShieldCheck,
  TrendingUp,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import type { StockCard } from '@/app/picker/picker-client';

interface Props {
  card: StockCard;
}

// Clamp helper — LLM bar values are notoriously creative about staying in
// range. Render-time guard so a 137 doesn't blow past 100% width and break
// the layout.
function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  if (n < 0) return 0;
  if (n > 100) return 100;
  return n;
}

// Format a signed percentage. Returns null for non-finite input so callers
// can decide whether to render a dash or skip the field entirely.
function fmtPct(n: number | undefined): string | null {
  if (typeof n !== 'number' || !Number.isFinite(n)) return null;
  const sign = n > 0 ? '+' : '';
  return `${sign}${n.toFixed(2)}%`;
}

type AddState =
  | { kind: 'idle' }
  | { kind: 'saving' }
  | { kind: 'added'; stockId: number }
  | { kind: 'error'; message: string };

export function StockCardView({ card }: Props) {
  const router = useRouter();
  const [addState, setAddState] = useState<AddState>({ kind: 'idle' });

  const onAdd = useCallback(async () => {
    if (addState.kind === 'saving' || addState.kind === 'added') return;
    setAddState({ kind: 'saving' });
    try {
      const res = await fetch('/api/portfolio', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          symbol: card.symbol,
          exchange: card.exchange,
          name: card.name,
          // currency may be undefined; the API zod schema treats it as
          // optional, so we either pass a real value or omit the key
          // entirely rather than send `null` (which would fail .optional()).
          ...(card.currency ? { currency: card.currency } : {}),
        }),
      });
      if (!res.ok) {
        let msg = `Add failed (${res.status})`;
        try {
          const j = (await res.json()) as { error?: string; detail?: string };
          if (j?.error) msg = j.detail ? `${j.error}: ${j.detail}` : j.error;
        } catch {
          /* non-JSON */
        }
        throw new Error(msg);
      }
      const data = (await res.json()) as {
        stock?: { id?: number };
        created?: boolean;
      };
      const id = data?.stock?.id;
      if (typeof id !== 'number') {
        // Idempotent path on the server returns the existing row too — only
        // path here that produces no id is a malformed body, which we want to
        // surface, not silently disable the button.
        throw new Error('Server returned no stock id');
      }
      setAddState({ kind: 'added', stockId: id });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      setAddState({ kind: 'error', message });
    }
  }, [addState.kind, card.currency, card.exchange, card.name, card.symbol]);

  const onResearch = useCallback(() => {
    if (addState.kind !== 'added') return;
    // Use router.push (client-side) so the existing /research client doesn't
    // remount from scratch — it can pick up the new `?stock=` param via its
    // own searchParams hook.
    router.push(`/research?stock=${addState.stockId}`);
  }, [addState, router]);

  const priceLabel = formatPriceLabel(card.price, card.currency);
  const changeLabel = fmtPct(card.changePct);

  return (
    <article
      // Card is a flex column with internal scroll. max-h plus overflow-y-auto
      // contains tall LLM essays without letting the outer page scroll
      // horizontally on small screens. min-h keeps the grid visually uniform
      // when one card returns very little content.
      className={cn(
        'flex max-h-[640px] min-h-[480px] flex-col overflow-hidden rounded-lg border border-border bg-background shadow-sm',
      )}
    >
      <div className="flex-1 overflow-y-auto p-4">
        {/* Header — ticker + name + market chip + evidence chip.
            The evidence chip is the critical-mode sanity check on the LLM:
            zero sources is a red flag, low source count gets a soft warn. */}
        <header className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <h3 className="truncate text-xl font-bold leading-tight">
              {card.symbol}
            </h3>
            <p className="truncate text-sm text-muted-foreground">{card.name}</p>
            {card.industry ? (
              <p className="mt-0.5 truncate text-xs text-muted-foreground/80">
                {card.industry}
              </p>
            ) : null}
            {isWeakEvidence(card) ? (
              <span
                className="mt-1.5 inline-flex items-center gap-1 rounded-full border border-amber-500/40 bg-amber-500/10 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-amber-400"
                title="The LLM gave a strong rating with little supporting evidence — verify before trusting."
              >
                🧐 Weak evidence
              </span>
            ) : null}
          </div>
          <div className="flex shrink-0 flex-col items-end gap-1">
            <span className="rounded-full border border-border bg-accent px-2 py-0.5 text-[10px] uppercase tracking-wide">
              {card.exchange}
            </span>
            <EvidenceChip count={card.sources?.length ?? 0} />
          </div>
        </header>

        {/* Price row — only renders when the API actually sent a number.
            Skipping the row entirely is cleaner than rendering a dash. */}
        {priceLabel ? (
          <div className="mt-3 flex items-baseline gap-2">
            <span className="text-lg font-semibold tabular-nums">
              {priceLabel}
            </span>
            {changeLabel ? (
              <span
                className={cn(
                  'text-sm tabular-nums',
                  (card.changePct ?? 0) >= 0 ? 'text-green-500' : 'text-red-500',
                )}
              >
                {changeLabel}
              </span>
            ) : null}
          </div>
        ) : null}

        {/* Industry context */}
        <Section title="Industry context">
          <p className="text-sm leading-relaxed text-muted-foreground">
            {card.industryContext || '—'}
          </p>
        </Section>

        {/* Financial status */}
        <Section title="Financial status">
          <p className="text-sm leading-relaxed text-muted-foreground">
            {card.financialStatus || '—'}
          </p>
        </Section>

        {/* Performance */}
        <Section title="Performance">
          <PerformanceLine perf={card.performance} />
        </Section>

        {/* Upcoming events */}
        {card.upcomingEvents && card.upcomingEvents.length > 0 ? (
          <Section title="Soon events">
            <ul className="space-y-1.5 text-sm">
              {card.upcomingEvents.slice(0, 3).map((ev, i) => (
                <li key={`${ev.date}-${i}`} className="flex gap-2">
                  <Calendar className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                  <span className="min-w-0">
                    <span className="font-medium tabular-nums text-foreground">
                      {ev.date}
                    </span>
                    <span className="text-muted-foreground"> — {ev.title}</span>
                  </span>
                </li>
              ))}
            </ul>
          </Section>
        ) : null}

        {/* Boom probability — critical-mode bands. The label calls the rating
            what it is so the user can't miss a 90% "verify" warning. */}
        <Section
          title="Boom probability"
          icon={<TrendingUp className="h-3.5 w-3.5" />}
        >
          <CriticalBar kind="boom" value={clamp01(card.boomProbability)} />
          {card.boomTriggers && card.boomTriggers.length > 0 ? (
            <p className="mt-2 text-xs italic leading-relaxed text-muted-foreground">
              {card.boomTriggers.join(' · ')}
            </p>
          ) : null}
        </Section>

        {/* Risk protection — same banded treatment. Higher = safer. */}
        <Section
          title="Risk protection"
          icon={<ShieldCheck className="h-3.5 w-3.5" />}
        >
          <CriticalBar kind="risk" value={clamp01(card.riskProtection)} />
          {card.riskWhy ? (
            <p className="mt-2 text-xs italic leading-relaxed text-muted-foreground">
              {card.riskWhy}
            </p>
          ) : null}
        </Section>

        {/* Consensus */}
        <Section title="Consensus">
          <p className="text-sm text-muted-foreground">{card.consensus || '—'}</p>
        </Section>

        {/* Sources */}
        {card.sources && card.sources.length > 0 ? (
          <Section title="Sources">
            <ul className="space-y-1 text-xs">
              {card.sources.slice(0, 3).map((url, i) => (
                <li key={i} className="truncate">
                  <a
                    href={url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-blue-400 underline-offset-2 hover:underline"
                  >
                    {url}
                  </a>
                </li>
              ))}
            </ul>
          </Section>
        ) : null}
      </div>

      {/* Footer — actions. Sticks to the card bottom so the buttons are always
          reachable without scrolling inside the card. */}
      <footer className="shrink-0 border-t border-border bg-background/50 p-3">
        {addState.kind === 'error' ? (
          <p className="mb-2 text-xs text-red-400">{addState.message}</p>
        ) : null}
        <div className="flex gap-2">
          <Button
            size="sm"
            variant={addState.kind === 'added' ? 'outline' : 'default'}
            onClick={onAdd}
            disabled={addState.kind === 'saving' || addState.kind === 'added'}
            className="flex-1"
          >
            {addState.kind === 'saving' ? (
              <>
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                Adding...
              </>
            ) : addState.kind === 'added' ? (
              <>
                <Check className="h-3.5 w-3.5" />
                Added
              </>
            ) : (
              <>
                <Plus className="h-3.5 w-3.5" />
                Add to portfolio
              </>
            )}
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={onResearch}
            disabled={addState.kind !== 'added'}
            className="flex-1"
            title={
              addState.kind === 'added'
                ? 'Open research for this stock'
                : 'Add to portfolio first'
            }
          >
            Research
            <ArrowRight className="h-3.5 w-3.5" />
          </Button>
        </div>
      </footer>
    </article>
  );
}

// ---------------------------------------------------------------------------
// Small presentational helpers — kept in-file so the card is self-contained.
// ---------------------------------------------------------------------------

function Section({
  title,
  icon,
  children,
}: {
  title: string;
  icon?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="mt-3">
      <h4 className="mb-1 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        {icon}
        {title}
      </h4>
      {children}
    </div>
  );
}

function PerformanceLine({ perf }: { perf: StockCard['performance'] }) {
  const items: Array<{ key: string; label: string; value: number | undefined }> = [
    { key: '1m', label: '1M', value: perf['1m'] },
    { key: '3m', label: '3M', value: perf['3m'] },
    { key: '1y', label: '1Y', value: perf['1y'] },
  ];
  const hasAny = items.some((i) => typeof i.value === 'number' && Number.isFinite(i.value));
  if (!hasAny && !perf.note) {
    return <p className="text-sm text-muted-foreground">{'—'}</p>;
  }
  return (
    <div className="space-y-1">
      <div className="flex flex-wrap gap-3 text-sm">
        {items.map((i) => {
          const v = fmtPct(i.value);
          if (!v) return null;
          const pos = (i.value ?? 0) >= 0;
          return (
            <span key={i.key} className="flex items-baseline gap-1 tabular-nums">
              <span className="text-xs uppercase text-muted-foreground">{i.label}</span>
              <span className={pos ? 'text-green-500' : 'text-red-500'}>{v}</span>
            </span>
          );
        })}
      </div>
      {perf.note ? (
        <p className="text-xs text-muted-foreground">{perf.note}</p>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Critical-mode bars + evidence chip. The picker is now stricter about its
// own ratings — these helpers translate raw 0-100 numbers into human-legible
// risk language so the user can spot over-confident calls at a glance.
// ---------------------------------------------------------------------------

// Color bands for the boom-probability bar.
// Thresholds are inclusive on the upper end (matches the "0-30 / 31-60 /
// 61-80 / 81-100" spec). A 100 lands in the gold "verify" band so the LLM
// pegging the meter is treated as suspicious, not as a buy signal.
function boomBand(v: number): { fill: string; text: string; label: string } {
  if (v <= 30) return { fill: 'bg-red-500', text: 'text-red-400', label: 'low conviction' };
  if (v <= 60) return { fill: 'bg-amber-500', text: 'text-amber-400', label: 'moderate' };
  if (v <= 80) return { fill: 'bg-green-500', text: 'text-green-400', label: 'high conviction' };
  return { fill: 'bg-yellow-500', text: 'text-yellow-400', label: 'very high — verify' };
}

// Color bands for the risk-protection bar (higher = safer).
function riskBand(v: number): { fill: string; text: string; label: string } {
  if (v <= 40) return { fill: 'bg-red-500', text: 'text-red-400', label: '🔴 high risk' };
  if (v <= 70) return { fill: 'bg-amber-500', text: 'text-amber-400', label: '🟡 moderate risk' };
  return { fill: 'bg-green-500', text: 'text-green-400', label: '🟢 low risk' };
}

function CriticalBar({
  kind,
  value,
}: {
  kind: 'boom' | 'risk';
  value: number; // 0-100, already clamped
}) {
  const band = kind === 'boom' ? boomBand(value) : riskBand(value);
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-2">
        <div
          className="h-2 flex-1 overflow-hidden rounded-full bg-accent"
          role="progressbar"
          aria-valuenow={value}
          aria-valuemin={0}
          aria-valuemax={100}
        >
          <div
            className={cn('h-full transition-[width] duration-300', band.fill)}
            style={{ width: `${value}%` }}
          />
        </div>
        <span className="w-10 text-right text-xs tabular-nums text-muted-foreground">
          {Math.round(value)}%
        </span>
      </div>
      <span className={cn('text-[11px] font-medium uppercase tracking-wide', band.text)}>
        {band.label}
      </span>
    </div>
  );
}

// Source-count chip rendered top-right of the card. Zero sources is a hard
// red flag — the LLM is supposed to cite evidence; the absence usually means
// either a parsing failure upstream or a hallucinated pick.
function EvidenceChip({ count }: { count: number }) {
  if (count === 0) {
    return (
      <span
        className="inline-flex items-center gap-1 rounded-full border border-red-500/40 bg-red-500/10 px-2 py-0.5 text-[10px] font-medium text-red-400"
        title="No sources cited — treat this pick with extreme suspicion."
      >
        ⚠️ no sources
      </span>
    );
  }
  return (
    <span
      className="inline-flex items-center gap-1 rounded-full border border-border bg-accent px-2 py-0.5 text-[10px] font-medium text-muted-foreground"
      title={`${count} source${count === 1 ? '' : 's'} cited`}
    >
      📰 {count} src
    </span>
  );
}

// Weak-evidence rule. Two triggers, kept close together so the UI message and
// the threshold logic don't drift:
//   1. Fewer than 2 sources overall — the floor we expect any pick to clear.
//   2. A very high boom probability (>80) with fewer than 3 sources — a high
//      conviction call demands more than a single article behind it.
function isWeakEvidence(card: StockCard): boolean {
  const n = card.sources?.length ?? 0;
  if (n < 2) return true;
  if (card.boomProbability > 80 && n < 3) return true;
  return false;
}

function formatPriceLabel(
  price: number | undefined,
  currency: string | undefined,
): string | null {
  if (typeof price !== 'number' || !Number.isFinite(price)) return null;
  // Intl.NumberFormat is more correct than concatenating, but currency codes
  // from the LLM are not guaranteed to be valid ISO 4217 — fall back to a
  // plain numeric format if the constructor throws.
  if (currency) {
    try {
      return new Intl.NumberFormat(undefined, {
        style: 'currency',
        currency,
        maximumFractionDigits: 2,
      }).format(price);
    } catch {
      /* fall through */
    }
  }
  return price.toFixed(2);
}

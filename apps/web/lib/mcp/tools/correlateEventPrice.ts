import { z } from 'zod';
import { and, between, eq, asc } from 'drizzle-orm';
import { db } from '@/lib/db/client';
import { events, pricesDaily, stocks } from '@/lib/db/schema';
import { getAdapter } from '@/lib/market';
import type { Exchange, Ohlcv } from '@/lib/market/types';
import type { ToolHandler } from '../types';

const input = z.object({
  event_id: z.number().int().positive(),
  window_days: z.number().int().min(1).max(60).default(5),
});
type Input = z.infer<typeof input>;

const output = z.object({
  event_id: z.number().int(),
  event_date: z.string(),
  window_days: z.number().int(),
  pre_return: z
    .number()
    .nullable()
    .describe('(close_at_event - close_window_start) / close_window_start'),
  post_return: z
    .number()
    .nullable()
    .describe('(close_window_end - close_at_event) / close_at_event'),
  benchmark_symbol: z
    .string()
    .nullable()
    .describe('Yahoo symbol of the index used as the market baseline, or null if unresolved'),
  relative_to_market: z
    .object({
      pre: z
        .number()
        .nullable()
        .describe('stock pre_return minus benchmark pre_return, as a fractional delta'),
      post: z
        .number()
        .nullable()
        .describe('stock post_return minus benchmark post_return, as a fractional delta'),
    })
    .nullable()
    .describe('Excess return vs. the exchange-appropriate market index, or null if unavailable.'),
  bars_used: z.number().int(),
  notes: z.array(z.string()),
});
type Output = z.infer<typeof output>;

const MS_PER_DAY = 86_400_000;

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * Pick a market-index Yahoo symbol for a given exchange. Anything not in this
 * map falls back to the S&P 500 — see the tool's `notes` output for callers
 * that need to detect a fallback.
 */
function benchmarkForExchange(exchange: string): string {
  const ex = exchange.toUpperCase();
  switch (ex) {
    case 'US':
      return '^GSPC';
    case 'HK':
      return '^HSI';
    case 'T': // Tokyo (Yahoo .T suffix)
    case 'JP':
      return '^N225';
    case 'KS':
    case 'KQ':
    case 'KR':
      return '^KS11';
    case 'TW':
      return '^TWII';
    case 'BK':
    case 'TH':
      return '^SET.BK';
    case 'SS':
    case 'SZ':
      return '000001.SS';
    case 'L':
    case 'UK':
      return '^FTSE';
    case 'DE':
      return '^GDAXI';
    case 'PA':
    case 'FR':
      return '^FCHI';
    case 'AS':
      return '^AEX';
    default:
      return '^GSPC';
  }
}

function computeReturns(bars: Ohlcv[] | Array<{ date: string; close: number }>, eventDateStr: string): {
  pre: number | null;
  post: number | null;
  atIdx: number;
} {
  if (bars.length === 0) return { pre: null, post: null, atIdx: -1 };
  let atIdx = -1;
  for (let i = 0; i < bars.length; i++) {
    const bar = bars[i];
    if (!bar) continue;
    if (bar.date <= eventDateStr) atIdx = i;
    else break;
  }
  const first = bars[0];
  const last = bars[bars.length - 1];
  const atBar = atIdx >= 0 ? bars[atIdx] : null;
  const firstClose = first ? Number(first.close) : null;
  const lastClose = last ? Number(last.close) : null;
  const atClose = atBar ? Number(atBar.close) : null;
  const pre =
    atClose != null && firstClose != null && firstClose !== 0
      ? (atClose - firstClose) / firstClose
      : null;
  const post =
    lastClose != null && atClose != null && atClose !== 0
      ? (lastClose - atClose) / atClose
      : null;
  return { pre, post, atIdx };
}

export const correlateEventPrice: ToolHandler<Input, Output> = {
  name: 'correlate_event_price',
  description:
    'Given an event id, fetch ±window_days of daily closes and report the pre/post returns, plus market-relative excess return vs. the exchange-appropriate index (e.g. ^GSPC for US, ^HSI for HK).',
  input,
  output,
  async execute({ event_id, window_days }) {
    const ev = (
      await db.select().from(events).where(eq(events.id, event_id)).limit(1)
    )[0];
    if (!ev) throw new Error(`event ${event_id} not found`);

    const eventDateStr = ev.eventDate as unknown as string;
    const center = new Date(eventDateStr + 'T00:00:00Z');
    const fromDate = new Date(center.getTime() - window_days * MS_PER_DAY);
    const toDate = new Date(center.getTime() + window_days * MS_PER_DAY);
    const from = isoDate(fromDate);
    const to = isoDate(toDate);

    const bars = await db
      .select()
      .from(pricesDaily)
      .where(
        and(
          eq(pricesDaily.stockId, ev.stockId),
          between(pricesDaily.date, from, to),
        ),
      )
      .orderBy(asc(pricesDaily.date));

    const notes: string[] = [];

    // Look up stock to know which exchange / which benchmark applies.
    const stockRow = (
      await db
        .select({ exchange: stocks.exchange })
        .from(stocks)
        .where(eq(stocks.id, ev.stockId))
        .limit(1)
    )[0];
    const exchange = (stockRow?.exchange ?? 'US') as Exchange;
    const benchmarkSymbol = benchmarkForExchange(exchange);

    if (bars.length === 0) {
      return {
        event_id,
        event_date: eventDateStr,
        window_days,
        pre_return: null,
        post_return: null,
        benchmark_symbol: benchmarkSymbol,
        relative_to_market: null,
        bars_used: 0,
        notes: [...notes, 'no prices_daily rows in window'],
      };
    }

    const stockBars = bars
      .map((b) => {
        const d = b.date as unknown as string | null;
        if (!d) return null;
        return { date: d, close: Number(b.close) };
      })
      .filter((x): x is { date: string; close: number } => x != null);

    const { pre: preReturn, post: postReturn, atIdx } = computeReturns(stockBars, eventDateStr);
    if (atIdx < 0) notes.push('no bar at or before event_date — pre_return is null');

    // Fetch benchmark window. On any failure or insufficient bars, leave
    // relative_to_market null and record a note.
    let relativeToMarket: { pre: number | null; post: number | null } | null = null;
    try {
      const adapter = getAdapter();
      // Always call with exchange='US' for indices: the adapter's
      // toYahooSymbol() appends an exchange suffix to bare tickers like
      // ^GSPC (no dot), which would corrupt the symbol. Indices that
      // already include a dot (e.g. 000001.SS, ^SET.BK) are passed through
      // unchanged. The 'US' value also skips pence-scaling.
      const benchmarkBars = await adapter.getDailyOhlcv(
        benchmarkSymbol,
        'US' as Exchange,
        fromDate,
        toDate,
      );
      if (benchmarkBars.length < 2) {
        notes.push('benchmark unavailable');
      } else {
        const { pre: bPre, post: bPost } = computeReturns(benchmarkBars, eventDateStr);
        const relPre =
          preReturn != null && bPre != null ? preReturn - bPre : null;
        const relPost =
          postReturn != null && bPost != null ? postReturn - bPost : null;
        relativeToMarket = { pre: relPre, post: relPost };
      }
    } catch {
      notes.push('benchmark unavailable');
    }

    return {
      event_id,
      event_date: eventDateStr,
      window_days,
      pre_return: preReturn,
      post_return: postReturn,
      benchmark_symbol: benchmarkSymbol,
      relative_to_market: relativeToMarket,
      bars_used: bars.length,
      notes,
    };
  },
};

import YahooFinance from 'yahoo-finance2';

// v3: the default export IS the class — must be instantiated.
const yahooFinance = new YahooFinance();
import type {
  Exchange,
  IntradayBar,
  IntradayInterval,
  MarketAdapter,
  Ohlcv,
  SymbolSearchResult,
} from './types';

// Exchanges whose Yahoo prices come in minor units (pence) and must be /100.
const PENCE_EXCHANGES = new Set<Exchange>(['L']);

// Map of plain exchange code -> Yahoo suffix appended to bare symbol.
// US has no suffix; TW uses `.TW` (already a Yahoo suffix).
const SUFFIX_MAP: Record<string, string> = {
  US: '',
  SS: '.SS',
  SZ: '.SZ',
  HK: '.HK',
  KS: '.KS',
  KQ: '.KQ',
  T: '.T',
  BK: '.BK',
  L: '.L',
  DE: '.DE',
  PA: '.PA',
  AS: '.AS',
  BR: '.BR',
  LS: '.LS',
  MI: '.MI',
  TW: '.TW',
};

export function toYahooSymbol(symbol: string, exchange: Exchange): string {
  if (symbol.includes('.')) return symbol;
  const ex = exchange.toUpperCase();
  const suffix = SUFFIX_MAP[ex] ?? '';
  let bare = symbol;
  // Hong Kong: pad to 4 digits with leading zeros if numeric.
  if (ex === 'HK' && /^\d+$/.test(bare)) {
    bare = bare.padStart(4, '0');
  }
  return suffix ? `${bare}${suffix}` : bare;
}

function suffixToExchange(sym: string): Exchange {
  const dot = sym.lastIndexOf('.');
  if (dot < 0) return 'US';
  const sfx = sym.slice(dot);
  const entry = Object.entries(SUFFIX_MAP).find(([, v]) => v === sfx);
  return (entry?.[0] as Exchange | undefined) ?? 'US';
}

function scaleClose(value: number, exchange: Exchange): number {
  return PENCE_EXCHANGES.has(exchange) ? value / 100 : value;
}

interface YahooFinanceLike {
  search: (q: string, opts?: unknown, runtimeOpts?: unknown) => Promise<unknown>;
  chart: (s: string, opts: unknown, runtimeOpts?: unknown) => Promise<unknown>;
}

interface ChartQuote {
  date: Date;
  open: number | null;
  high: number | null;
  low: number | null;
  close: number | null;
  volume: number | null;
}

interface ChartResult {
  quotes: ChartQuote[];
}

interface SearchQuote {
  symbol?: string;
  shortname?: string;
  longname?: string;
  exchange?: string;
  quoteType?: string;
  score?: number;
  currency?: string;
}

interface SearchResult {
  quotes: SearchQuote[];
}

export class YahooAdapter implements MarketAdapter {
  readonly name = 'yahoo';
  private readonly client: YahooFinanceLike;

  constructor(client?: YahooFinanceLike) {
    this.client = client ?? (yahooFinance as unknown as YahooFinanceLike);
  }

  async searchSymbols(q: string, exchange?: Exchange): Promise<SymbolSearchResult[]> {
    const raw = (await this.client.search(
      q,
      { quotesCount: 20, newsCount: 0 },
      { validateResult: false },
    )) as SearchResult;
    const all = (raw.quotes ?? [])
      .filter((it) => typeof it.symbol === 'string')
      .map((it) => {
        const sym = it.symbol as string;
        const ex = suffixToExchange(sym);
        const result: SymbolSearchResult = {
          symbol: sym,
          exchange: ex,
          name: it.longname ?? it.shortname ?? sym,
          currency: it.currency,
          quoteType: it.quoteType,
          score: it.score,
        };
        return result;
      });
    if (!exchange) return all;
    const want = exchange.toUpperCase();
    return all.filter((r) => r.exchange.toUpperCase() === want);
  }

  async getDailyOhlcv(
    symbol: string,
    exchange: Exchange,
    from: Date,
    to: Date,
  ): Promise<Ohlcv[]> {
    const ySym = toYahooSymbol(symbol, exchange);
    let raw: ChartResult;
    try {
      raw = (await this.client.chart(
        ySym,
        { period1: from, period2: to, interval: '1d' },
        { validateResult: false },
      )) as ChartResult;
    } catch (err) {
      // Yahoo sometimes 404s newly-listed Chinese/HK tickers or throws on
      // weird suffixes. Surface a clear error so the route's 502 includes it.
      throw new Error(
        `yahoo chart for ${ySym} failed: ${(err as Error)?.message ?? 'unknown'}`,
      );
    }
    return (raw.quotes ?? [])
      .filter((q) => q.open != null && q.high != null && q.low != null && q.close != null)
      .map((q) => ({
        date: toISODate(q.date),
        open: scaleClose(q.open as number, exchange),
        high: scaleClose(q.high as number, exchange),
        low: scaleClose(q.low as number, exchange),
        close: scaleClose(q.close as number, exchange),
        volume: q.volume ?? 0,
      }));
  }

  async getIntradayOhlcv(
    symbol: string,
    exchange: Exchange,
    fromTs: Date,
    toTs: Date,
    interval: IntradayInterval,
  ): Promise<IntradayBar[]> {
    const ySym = toYahooSymbol(symbol, exchange);
    const raw = (await this.client.chart(
      ySym,
      { period1: fromTs, period2: toTs, interval },
      { validateResult: false },
    )) as ChartResult;
    return (raw.quotes ?? [])
      .filter((q) => q.close != null)
      .map((q) => ({
        ts: q.date.toISOString(),
        open: scaleClose((q.open ?? q.close) as number, exchange),
        high: scaleClose((q.high ?? q.close) as number, exchange),
        low: scaleClose((q.low ?? q.close) as number, exchange),
        close: scaleClose(q.close as number, exchange),
        volume: q.volume ?? 0,
        interval,
      }));
  }
}

function toISODate(d: Date): string {
  const iso = d.toISOString();
  return iso.slice(0, 10);
}

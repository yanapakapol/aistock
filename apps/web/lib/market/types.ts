export type Exchange =
  | 'US'
  | 'SS'
  | 'SZ'
  | 'HK'
  | 'KS'
  | 'KQ'
  | 'T'
  | 'BK'
  | 'L'
  | 'DE'
  | 'PA'
  | 'AS'
  | 'BR'
  | 'LS'
  | 'MI'
  | 'TW'
  | string;

export type IntradayInterval = '1m' | '2m' | '5m' | '15m' | '30m' | '60m' | '90m' | '1h';

export interface SymbolSearchResult {
  symbol: string;
  exchange: Exchange;
  name: string;
  currency?: string;
  mic?: string;
  quoteType?: string;
  score?: number;
}

export interface Ohlcv {
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface IntradayBar {
  ts: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  interval: IntradayInterval;
}

export interface MarketAdapter {
  readonly name: string;
  searchSymbols(q: string, exchange?: Exchange): Promise<SymbolSearchResult[]>;
  getDailyOhlcv(symbol: string, exchange: Exchange, from: Date, to: Date): Promise<Ohlcv[]>;
  getIntradayOhlcv(
    symbol: string,
    exchange: Exchange,
    fromTs: Date,
    toTs: Date,
    interval: IntradayInterval,
  ): Promise<IntradayBar[]>;
}

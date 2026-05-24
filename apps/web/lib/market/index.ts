import type { MarketAdapter } from './types';
import { YahooAdapter } from './yahoo';

export type MarketProvider = 'yahoo' | 'twelvedata' | 'alphavantage' | 'finnhub' | 'eodhd';

let cached: MarketAdapter | undefined;

export function getAdapter(provider?: MarketProvider): MarketAdapter {
  const p = (provider ?? (process.env.MARKET_PROVIDER as MarketProvider | undefined) ?? 'yahoo');
  if (cached && cached.name === p) return cached;
  switch (p) {
    case 'yahoo':
      cached = new YahooAdapter();
      return cached;
    case 'twelvedata':
    case 'alphavantage':
    case 'finnhub':
    case 'eodhd':
      throw new Error(`MarketProvider '${p}' not yet implemented; falling back requires explicit wiring`);
    default:
      cached = new YahooAdapter();
      return cached;
  }
}

export function resetAdapterCache(): void {
  cached = undefined;
}

export type { MarketAdapter } from './types';
export * from './types';

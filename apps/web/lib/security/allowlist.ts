import 'server-only';
import { LLM_HOSTS } from '../llm/providers';

/**
 * Market-data hosts the app is allowed to reach. yahoo-finance2 hits both
 * `query1` and `query2` depending on the call type; the paid alternatives
 * (Twelve Data, Alpha Vantage, Finnhub, EODHD) are listed for parity with
 * the M2/M7 plan even if not all are wired up yet.
 */
export const MARKET_DATA_HOSTS = new Set<string>([
  'query1.finance.yahoo.com',
  'query2.finance.yahoo.com',
  'api.twelvedata.com',
  'www.alphavantage.co',
  'finnhub.io',
  'eodhd.com',
]);

/** News-research providers. Tavily is primary, Exa is fallback. */
export const NEWS_HOSTS = new Set<string>(['api.tavily.com', 'api.exa.ai']);

/**
 * The union of every hostname `secureFetch` is allowed to talk to.
 * Anything not in this set throws before a request leaves the process.
 */
export const OUTBOUND_HOSTS: Set<string> = new Set<string>([
  ...LLM_HOSTS,
  ...MARKET_DATA_HOSTS,
  ...NEWS_HOSTS,
]);

export function isHostAllowed(host: string): boolean {
  return OUTBOUND_HOSTS.has(host.toLowerCase());
}

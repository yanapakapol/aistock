import 'server-only';
import type { ToolHandler } from '../types';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyToolHandler = ToolHandler<any, any>;
type ToolLoader = () => Promise<AnyToolHandler>;

// Each entry is a lazy import; the actual tool module only loads when
// `getToolsByNames` pulls its name. Saves ~200-500KB of cold-start bundle
// when only a subset is needed (research tab without dbMode uses ~8 of 15;
// analysis uses all 15).
//
// Keys MUST match each tool's runtime `.name` (the wire name the LLM sees),
// not the exported binding name, so the chat route's `allowedNames` set
// indexes into here cleanly.
const LOADERS: Record<string, ToolLoader> = {
  search_stocks: async () => (await import('./searchStocks')).searchStocks,
  get_prices: async () => (await import('./getPrices')).getPrices,
  get_prices_intraday: async () => (await import('./getPricesIntraday')).getPricesIntraday,
  get_events: async () => (await import('./getEvents')).getEvents,
  get_future_events: async () => (await import('./getFutureEvents')).getFutureEvents,
  get_business_context: async () => (await import('./getBusinessContext')).getBusinessContext,
  get_fundamentals: async () => (await import('./getFundamentals')).getFundamentals,
  search_news: async () => (await import('./searchNews')).searchNews,
  upsert_event: async () => (await import('./upsertEvent')).upsertEvent,
  upsert_future_event: async () => (await import('./upsertFutureEvent')).upsertFutureEvent,
  upsert_business_context: async () =>
    (await import('./upsertBusinessContext')).upsertBusinessContext,
  correlate_event_price: async () => (await import('./correlateEventPrice')).correlateEventPrice,
  create_routine: async () => (await import('./createRoutine')).createRoutine,
  consolidate_events: async () => (await import('./consolidateEvents')).consolidateEvents,
  get_current_datetime: async () => (await import('./getCurrentDatetime')).getCurrentDatetime,
};

/**
 * Load only the handlers whose names appear in `names`, preserving the
 * caller-supplied order. Unknown names are silently dropped so the chat
 * route's allow-list can stay declarative.
 */
export async function getToolsByNames(names: string[]): Promise<AnyToolHandler[]> {
  const ordered = names.filter((n) => n in LOADERS);
  const loaded = await Promise.all(ordered.map((n) => LOADERS[n]!()));
  return loaded;
}

/** Every tool name the registry knows about, in declaration order. */
export function allToolNames(): string[] {
  return Object.keys(LOADERS);
}

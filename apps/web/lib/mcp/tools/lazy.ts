import 'server-only';
import type { ToolHandler } from '../types';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyToolHandler = ToolHandler<any, any>;
type ToolLoader = () => Promise<AnyToolHandler>;

/**
 * createRoutine.ts statically imports `@/lib/scheduler`, whose `./run`
 * sub-module in turn statically imports `TOOLS` from `./index.ts`. That barrel
 * imports `createRoutine` back. The cycle USED to resolve cleanly because the
 * chat route eagerly loaded `index.ts` at module-eval time, which guaranteed
 * a deterministic top-down eval order: index → createRoutine → scheduler →
 * run (which only *binds* TOOLS, never *reads* it at the top level) → back
 * up to index, which finishes filling `TOOLS` and runs `TOOLS.push(createRoutine)`
 * AFTER createRoutine.ts's `export const` has finally executed.
 *
 * Once `lazy.ts` started doing `await import('./createRoutine')` directly, the
 * eval root changed — createRoutine.ts now runs FIRST, drags in scheduler→
 * run, which then evaluates index.ts. Index reaches line 33 (`TOOLS.push(
 * createRoutine)`) while the originating createRoutine.ts hasn't finished its
 * top-level eval yet, so `createRoutine` is in the temporal dead zone and
 * Node throws "Cannot access 'createRoutine' before initialization". The chat
 * route surfaced this as an empty-body 500 (no top-level catch existed).
 *
 * Workaround within this file (cross-file refactor would be ideal — moving
 * createRoutine's scheduler call to a dynamic import — but lib/scheduler is
 * outside this agent's ownership): when `create_routine` is requested, route
 * the load through the barrel so the cycle resolves in the same order as
 * before. The barrel is also kept on a one-shot promise so repeated calls
 * within a single cold container reuse the same module record.
 */
let barrelP: Promise<typeof import('./index')> | null = null;
function viaBarrel<K extends keyof typeof import('./index')>(
  exportName: K,
): () => Promise<AnyToolHandler> {
  return async () => {
    barrelP ??= import('./index');
    const mod = await barrelP;
    return mod[exportName] as unknown as AnyToolHandler;
  };
}

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
  // Route the cycle-triggering tools through the barrel — see comment above.
  // createRoutine drags in scheduler→run→index, and consolidateEvents/
  // correlateEventPrice etc. may indirectly do the same through schema
  // re-exports, so we route them all through the same one-shot to be safe.
  create_routine: viaBarrel('createRoutine'),
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

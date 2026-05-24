import type { ToolHandler } from '../types';
import { searchStocks } from './searchStocks';
import { getPrices } from './getPrices';
import { getPricesIntraday } from './getPricesIntraday';
import { getEvents } from './getEvents';
import { getFutureEvents } from './getFutureEvents';
import { getBusinessContext } from './getBusinessContext';
import { getFundamentals } from './getFundamentals';
import { searchNews } from './searchNews';
import { upsertEvent } from './upsertEvent';
import { upsertFutureEvent } from './upsertFutureEvent';
import { upsertBusinessContext } from './upsertBusinessContext';
import { correlateEventPrice } from './correlateEventPrice';
import { createRoutine } from './createRoutine';
import { consolidateEvents } from './consolidateEvents';
import { getCurrentDatetime } from './getCurrentDatetime';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const TOOLS: ToolHandler<any, any>[] = [
  searchStocks,
  getPrices,
  getPricesIntraday,
  getEvents,
  getFutureEvents,
  getBusinessContext,
  getFundamentals,
  searchNews,
  upsertEvent,
  upsertFutureEvent,
  upsertBusinessContext,
  correlateEventPrice,
];
TOOLS.push(createRoutine);
TOOLS.push(consolidateEvents);
TOOLS.push(getCurrentDatetime);

export {
  searchStocks,
  getPrices,
  getPricesIntraday,
  getEvents,
  getFutureEvents,
  getBusinessContext,
  getFundamentals,
  searchNews,
  upsertEvent,
  upsertFutureEvent,
  upsertBusinessContext,
  correlateEventPrice,
  createRoutine,
  consolidateEvents,
  getCurrentDatetime,
};

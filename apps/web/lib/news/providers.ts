

// Single source of truth for the news-provider literal union lives in
// `@/lib/db/schema` (alongside the unconstrained `api_keys.provider` text
// column). We re-export it here so news-side callers don't have to reach into
// the schema module for what is really a domain concept.
export { NEWS_PROVIDERS, type NewsProvider } from '@/lib/db/schema';

import type { NewsProvider } from '@/lib/db/schema';

export const NEWS_PROVIDER_LABELS: Record<NewsProvider, string> = {
  tavily: 'Tavily',
  exa: 'Exa',
  finnhub: 'Finnhub',
  eodhd: 'EODHD',
};

import { z } from 'zod';
import { getAdapter } from '@/lib/market';
import type { ToolHandler } from '../types';

const input = z.object({
  query: z.string().min(1).describe('Free-form symbol or company name'),
  exchange: z
    .string()
    .optional()
    .describe('Optional exchange filter, e.g. "US", "HK", "T", "BK"'),
});
type Input = z.infer<typeof input>;

const output = z.object({
  results: z.array(
    z.object({
      symbol: z.string(),
      exchange: z.string(),
      name: z.string(),
      currency: z.string().optional(),
      mic: z.string().optional(),
      quoteType: z.string().optional(),
      score: z.number().optional(),
    }),
  ),
});
type Output = z.infer<typeof output>;

export const searchStocks: ToolHandler<Input, Output> = {
  name: 'search_stocks',
  description:
    'Cross-exchange symbol lookup. Returns ticker, exchange, display name, and currency for each match.',
  input,
  output,
  async execute({ query, exchange }) {
    const adapter = getAdapter();
    const results = await adapter.searchSymbols(query, exchange);
    return { results };
  },
};

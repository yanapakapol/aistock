import 'server-only';
import { createOpenAI } from '@ai-sdk/openai';
import { createAnthropic } from '@ai-sdk/anthropic';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createMistral } from '@ai-sdk/mistral';
import { createDeepSeek } from '@ai-sdk/deepseek';
import { createMoonshotAI } from '@ai-sdk/moonshotai';
import type { Provider } from './providers';

/**
 * Maps a (provider, modelId, apiKey) triple to an AI SDK v6 LanguageModel
 * suitable for `streamText({ model, ... })`.
 *
 * The same logic currently lives inline in `app/api/chat/route.ts` (`buildModel`).
 * Kept here so the scheduler (`lib/scheduler/run.ts`) and any future caller can
 * share it without re-importing the chat route. When the chat route is next
 * touched, its `buildModel` should be replaced with a call to this helper.
 */
export function clientFor(provider: Provider, modelId: string, apiKey: string) {
  switch (provider) {
    case 'openai':
      return createOpenAI({ apiKey })(modelId);
    case 'anthropic':
      return createAnthropic({ apiKey })(modelId);
    case 'google':
      return createGoogleGenerativeAI({ apiKey })(modelId);
    case 'mistral':
      return createMistral({ apiKey })(modelId);
    case 'deepseek':
      return createDeepSeek({ apiKey })(modelId);
    case 'moonshot':
      return createMoonshotAI({ apiKey })(modelId);
  }
}

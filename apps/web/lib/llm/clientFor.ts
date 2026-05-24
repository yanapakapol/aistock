import 'server-only';
import type { Provider } from './providers';

/**
 * Maps a (provider, modelId, apiKey) triple to an AI SDK v6 LanguageModel
 * suitable for `streamText({ model, ... })`.
 *
 * IMPORTANT — lazy provider imports.
 *
 * The naive version of this file static-imported all 6 `@ai-sdk/<provider>`
 * packages at module load. Each one is 50-500KB of code and pulls in its
 * own transitive deps. On a Vercel serverless cold start, Node had to
 * evaluate ALL six bundles before the chat route could begin handling
 * a request — adding 1-3 seconds of bundle-load latency to EVERY cold
 * invocation, even though only the user's chosen provider is needed.
 *
 * Now we `await import(...)` only the provider being used. Node's module
 * cache means warm requests still pay no cost; cold starts only load the
 * one provider's package. Net effect on cold-start TTFT: ~1-2s saved.
 *
 * Awaitable signature is mandatory now — callers must `await clientFor(...)`.
 */
export async function clientFor(
  provider: Provider,
  modelId: string,
  apiKey: string,
) {
  switch (provider) {
    case 'openai': {
      const { createOpenAI } = await import('@ai-sdk/openai');
      return createOpenAI({ apiKey })(modelId);
    }
    case 'anthropic': {
      const { createAnthropic } = await import('@ai-sdk/anthropic');
      return createAnthropic({ apiKey })(modelId);
    }
    case 'google': {
      const { createGoogleGenerativeAI } = await import('@ai-sdk/google');
      return createGoogleGenerativeAI({ apiKey })(modelId);
    }
    case 'mistral': {
      const { createMistral } = await import('@ai-sdk/mistral');
      return createMistral({ apiKey })(modelId);
    }
    case 'deepseek': {
      const { createDeepSeek } = await import('@ai-sdk/deepseek');
      return createDeepSeek({ apiKey })(modelId);
    }
    case 'moonshot': {
      const { createMoonshotAI } = await import('@ai-sdk/moonshotai');
      return createMoonshotAI({ apiKey })(modelId);
    }
  }
}

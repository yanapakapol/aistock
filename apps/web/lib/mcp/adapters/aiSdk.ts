import { tool } from 'ai';
import { scrubSecrets, sanitizeError } from '@/lib/security/scrub';
import type { ToolHandler } from '../types';

/**
 * Wraps a `ToolHandler` as a Vercel AI SDK `tool({...})`. Every value the
 * handler returns is run through `scrubSecrets` before the LLM sees it, and
 * every thrown error is funneled through `sanitizeError` so we never echo
 * Authorization headers or response bodies back into the model context.
 */
export function toAiSdkTool<I, O>(handler: ToolHandler<I, O>) {
  return tool({
    description: handler.description,
    inputSchema: handler.input,
    execute: async (input: I) => {
      try {
        const result = await handler.execute(input, {});
        return scrubSecrets(result);
      } catch (err) {
        // Throwing here would surface the raw error to the model. Returning
        // a sanitized object keeps the call traceable without leaking.
        return { error: sanitizeError(err) };
      }
    },
  });
}

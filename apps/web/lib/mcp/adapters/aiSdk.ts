import { tool } from 'ai';
import { scrubSecrets, sanitizeError } from '@/lib/security/scrub';
import type { ToolCtx, ToolHandler } from '../types';

/**
 * Wraps a `ToolHandler` as a Vercel AI SDK `tool({...})`. Every value the
 * handler returns is run through `scrubSecrets` before the LLM sees it, and
 * every thrown error is funneled through `sanitizeError` so we never echo
 * Authorization headers or response bodies back into the model context.
 *
 * `ctx` is captured in a closure so each tool instance carries the
 * authenticated caller's user id. The chat route builds the tool list
 * fresh per request with `toAiSdkTool(t, { userId })`, so a tool can never
 * be invoked without the caller's identity.
 */
export function toAiSdkTool<I, O>(handler: ToolHandler<I, O>, ctx: ToolCtx = {}) {
  return tool({
    description: handler.description,
    inputSchema: handler.input,
    execute: async (input: I) => {
      try {
        const result = await handler.execute(input, ctx);
        return scrubSecrets(result);
      } catch (err) {
        return { error: sanitizeError(err) };
      }
    },
  });
}

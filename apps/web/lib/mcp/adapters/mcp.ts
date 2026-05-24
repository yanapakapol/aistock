import { z } from 'zod';
import { scrubSecrets, sanitizeError } from '@/lib/security/scrub';
import type { ToolHandler } from '../types';

/**
 * Minimal structural type for the `McpServer` we register against. We accept
 * anything with a `registerTool` method so this file does not need to import
 * the SDK at the type level (keeps test round-trip lightweight and avoids
 * pinning to a specific SDK minor version).
 */
export interface McpServerLike {
  registerTool: (
    name: string,
    config: { description: string; inputSchema: Record<string, z.ZodTypeAny> },
    handler: (
      args: Record<string, unknown>,
    ) => Promise<{ content: Array<{ type: 'text'; text: string }>; isError?: boolean }>,
  ) => void;
}

/**
 * The MCP SDK's `registerTool` expects a `ZodRawShape` (i.e. the `.shape` of
 * a `z.object`). When the handler's input schema is a `ZodObject` we hand
 * the shape over directly; for anything else we register an empty shape and
 * rely on the handler's own `parse` (called below) for validation.
 */
function zodSchemaToShape(schema: z.ZodTypeAny): Record<string, z.ZodTypeAny> {
  const anySchema = schema as unknown as { shape?: Record<string, z.ZodTypeAny> };
  if (anySchema.shape && typeof anySchema.shape === 'object') return anySchema.shape;
  return {};
}

export function registerOnMcp<I, O>(server: McpServerLike, handler: ToolHandler<I, O>): void {
  server.registerTool(
    handler.name,
    {
      description: handler.description,
      inputSchema: zodSchemaToShape(handler.input),
    },
    async (args: Record<string, unknown>) => {
      try {
        // Re-validate even when MCP did its own pass: the empty-shape fallback
        // above means non-object schemas would otherwise reach execute() raw.
        const parsed = handler.input.parse(args) as I;
        const result = await handler.execute(parsed, {});
        const scrubbed = scrubSecrets(result);
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(scrubbed) }],
        };
      } catch (err) {
        return {
          content: [
            { type: 'text' as const, text: JSON.stringify({ error: sanitizeError(err) }) },
          ],
          isError: true,
        };
      }
    },
  );
}

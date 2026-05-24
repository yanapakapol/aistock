import type { z } from 'zod';

/**
 * Optional execution-time context threaded through every tool call. The
 * adapters pass `{}` by default; the chat pipeline may pass `stockIdHint`
 * (to bias ambiguous lookups) and `provenance` (so write tools can refuse
 * un-resummarized `search_news` payloads — see plan section "Security
 * model" point 6).
 */
export type ToolCtx = {
  stockIdHint?: number;
  provenance?: 'web' | 'db' | 'user';
  /**
   * Authenticated caller's user id. The chat route injects this from the
   * session cookie before dispatching to tools. Stock-scoped tools MUST
   * filter their queries by `EXISTS (SELECT 1 FROM stocks s JOIN
   * portfolios p ON p.id=s.portfolio_id WHERE s.id=$stockId AND p.user_id=
   * $userId)` (or equivalent) before returning data, otherwise a malicious
   * LLM could read another user's events by guessing stock ids.
   *
   * `undefined` means "no authenticated user" — tools should refuse to
   * return any stock-scoped data in that case.
   */
  userId?: number;
};

/**
 * The single core abstraction. Every tool lives in `lib/mcp/tools/*.ts` as
 * one `ToolHandler<I, O>` value and is exposed to both the in-process
 * Vercel AI SDK (`adapters/aiSdk.ts`) and the external MCP server
 * (`adapters/mcp.ts`). Handlers MUST NOT import either SDK directly — that
 * is what prevents schema drift.
 */
export interface ToolHandler<I, O> {
  name: string;
  description: string;
  /** Use `z.ZodTypeAny` so schemas with `.default()` (where input is optional
   *  but parsed output is required) still satisfy the constraint. */
  input: z.ZodType<I, z.ZodTypeDef, unknown>;
  output: z.ZodType<O, z.ZodTypeDef, unknown>;
  execute: (input: I, ctx: ToolCtx) => Promise<O>;
}

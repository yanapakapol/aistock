import { z } from 'zod';
import { CronExpressionParser } from 'cron-parser';
import { db } from '@/lib/db/client';
import { routines } from '@/lib/db/schema';
import type { ToolHandler } from '../types';

// NOTE — DO NOT static-import `@/lib/scheduler` at the top of this file.
// Doing so creates a circular dependency:
//   createRoutine → lib/scheduler/index → runner → run → mcp/tools/index
//   → re-imports createRoutine while it's still mid-init → TDZ error
//   "Cannot access 'createRoutine' before initialization" in the webpack
//   minified prod bundle, manifesting as `/api/chat` returning empty 500s
//   for EVERY request (not just create_routine ones — the whole chat module
//   fails to load).
// The `viaBarrel` workaround in lazy.ts hid the cycle in dev but webpack's
// production hoisting still tripped it. Lazy-importing inside `execute()`
// breaks the static cycle entirely: scheduler only loads at request time,
// long after all module init has settled.

const input = z.object({
  name: z.string().min(1).max(120),
  prompt: z.string().min(1).max(8000),
  tab: z.enum(['research', 'analysis']),
  model: z.string().min(1).max(128),
  fallbackModels: z.array(z.string().min(1).max(128)).max(8).optional(),
  cronExpr: z.string().min(1).max(64),
  tz: z.string().min(1).max(64).optional(),
  maxUsdPerRun: z.number().positive().max(100).optional(),
});
type Input = z.infer<typeof input>;

const output = z.object({
  routineId: z.number().int(),
  nextRunAt: z.string().nullable().describe('ISO timestamp of the next scheduled fire, or null if it could not be derived'),
});
type Output = z.infer<typeof output>;

export const createRoutine: ToolHandler<Input, Output> = {
  name: 'create_routine',
  description:
    'Create a scheduled routine that re-runs a prompt on a cron. Validates the cron expression in the given timezone (defaults to Asia/Bangkok), inserts the row, and arms the in-process scheduler so the routine is live immediately.',
  input,
  output,
  async execute(args, ctx) {
    // Mirror the assertOwnsStock contract: writes require an authenticated
    // caller. The MCP HTTP endpoint can call tools without a session cookie,
    // and we MUST NOT let it create unowned (orphan) routines that any user
    // could then trip over via id-guessing.
    if (!ctx.userId) {
      throw new Error('forbidden: no authenticated user');
    }

    const tz = args.tz ?? 'Asia/Bangkok';

    // Validate cron and derive next fire.
    let nextRunAt: string | null = null;
    try {
      const iter = CronExpressionParser.parse(args.cronExpr, { tz });
      try {
        nextRunAt = iter.next().toDate().toISOString();
      } catch {
        nextRunAt = null;
      }
    } catch (err) {
      const detail = (err as Error).message || 'invalid cron expression';
      throw new Error(`invalid cron expression '${args.cronExpr}' for tz '${tz}': ${detail}`);
    }

    const [inserted] = await db
      .insert(routines)
      .values({
        userId: ctx.userId,
        name: args.name,
        prompt: args.prompt,
        tab: args.tab,
        model: args.model,
        fallbackModels: args.fallbackModels ?? [],
        cronExpr: args.cronExpr,
        tz,
        // numeric columns take strings in Drizzle
        ...(args.maxUsdPerRun != null
          ? { maxUsdPerRun: args.maxUsdPerRun.toFixed(4) }
          : {}),
      })
      .returning({ id: routines.id });

    const routineId = inserted?.id;
    if (routineId == null) throw new Error('create_routine: insert returned no id');

    // Best-effort arm the scheduler. If it's not running (e.g. tests, or
    // Vercel serverless where the in-process scheduler is intentionally
    // disabled), swallow. Lazy-import so the static import cycle above is
    // never re-created.
    try {
      const { getScheduler } = await import('@/lib/scheduler');
      await getScheduler().reload(routineId);
    } catch {
      // non-fatal
    }

    return { routineId, nextRunAt };
  },
};

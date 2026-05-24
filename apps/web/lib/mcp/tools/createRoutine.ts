import { z } from 'zod';
import { CronExpressionParser } from 'cron-parser';
import { db } from '@/lib/db/client';
import { routines } from '@/lib/db/schema';
import { getScheduler } from '@/lib/scheduler';
import type { ToolHandler } from '../types';

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

    // Best-effort arm the scheduler. If it's not running (e.g. tests), swallow.
    try {
      await getScheduler().reload(routineId);
    } catch {
      // non-fatal
    }

    return { routineId, nextRunAt };
  },
};

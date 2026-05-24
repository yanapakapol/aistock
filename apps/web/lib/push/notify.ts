import 'server-only';
import { sendPushToAll } from './send';

/**
 * Fire a "routine done" push to every active subscription. Called at the very
 * end of a successful routine run from `lib/scheduler/run.ts`. Failure here
 * must never mark the routine itself failed — we swallow + log so a missing
 * VAPID key (or push-service outage) is a degraded notification experience,
 * not a broken routine.
 */
export async function notifyRoutineDone(
  routine: { name: string; userId?: number | null },
  outputMd: string,
): Promise<void> {
  try {
    const body = (outputMd ?? '').slice(0, 140);
    // Scope to the routine owner when known so a routine's "done" push only
    // lands on that user's devices. Pre-multi-tenant rows may carry
    // userId === null; for those we fall back to broadcast (current behavior).
    const userId =
      typeof routine.userId === 'number' && Number.isFinite(routine.userId)
        ? routine.userId
        : undefined;
    await sendPushToAll(
      {
        title: `Routine done: ${routine.name}`,
        body,
        url: '/routines',
      },
      userId != null ? { userId } : {},
    );
  } catch (err) {
    // Most likely: missing VAPID keys in env. Log once and move on.
    console.warn(
      '[push/notify] sendPushToAll failed (non-fatal):',
      err instanceof Error ? err.message : String(err),
    );
  }
}

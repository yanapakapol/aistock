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
  routine: { name: string },
  outputMd: string,
): Promise<void> {
  try {
    const body = (outputMd ?? '').slice(0, 140);
    await sendPushToAll({
      title: `Routine done: ${routine.name}`,
      body,
      url: '/routines',
    });
  } catch (err) {
    // Most likely: missing VAPID keys in env. Log once and move on.
    console.warn(
      '[push/notify] sendPushToAll failed (non-fatal):',
      err instanceof Error ? err.message : String(err),
    );
  }
}

import 'server-only';
import { and, eq, isNull } from 'drizzle-orm';
import webPush from 'web-push';
import { db } from '../db/client';
import { outboundAudit, pushSubscriptions } from '../db/schema';

export interface PushPayload {
  title: string;
  body: string;
  url?: string;
}

interface VapidKeys {
  publicKey: string;
  privateKey: string;
  subject: string;
}

/**
 * Read the VAPID env triple and validate it. Throws a helpful error if any
 * piece is missing — callers (notify hooks) should catch and swallow so push
 * misconfiguration never fails the underlying business action.
 */
export function getVapidKeys(): VapidKeys {
  const publicKey = process.env.VAPID_PUBLIC_KEY;
  const privateKey = process.env.VAPID_PRIVATE_KEY;
  const subject = process.env.VAPID_SUBJECT;
  const missing: string[] = [];
  if (!publicKey) missing.push('VAPID_PUBLIC_KEY');
  if (!privateKey) missing.push('VAPID_PRIVATE_KEY');
  if (!subject) missing.push('VAPID_SUBJECT');
  if (missing.length > 0) {
    throw new Error(
      `Web Push disabled — missing env: ${missing.join(', ')}. ` +
        `Generate a pair with \`npx tsx scripts/generate-vapid.ts\` and set them in .env.`,
    );
  }
  if (!subject!.startsWith('mailto:') && !subject!.startsWith('https://')) {
    throw new Error('VAPID_SUBJECT must be a mailto: or https: URL');
  }
  return { publicKey: publicKey!, privateKey: privateKey!, subject: subject! };
}

let vapidConfigured = false;
function ensureVapidConfigured(keys: VapidKeys): void {
  if (vapidConfigured) return;
  webPush.setVapidDetails(keys.subject, keys.publicKey, keys.privateKey);
  vapidConfigured = true;
}

function hostOf(endpoint: string): string {
  try {
    return new URL(endpoint).host;
  } catch {
    return 'unknown';
  }
}

interface SendResult {
  sent: number;
  disabled: number;
  errored: number;
}

/**
 * Fan-out a push payload to every active subscription. The payload is
 * stringified and consumed by the SW's `push` listener, which forwards
 * `{title, body, url}` to `showNotification`.
 *
 *  - On 410 Gone or 404 Not Found, the subscription is hard-revoked: we set
 *    `disabled_at = now()` so future runs skip it.
 *  - On any other error, we record an `outbound_audit` row (kind='push.send',
 *    host = endpoint host, status = err.statusCode) and move on. No payload
 *    or headers are persisted (matches the audit policy in lib/security).
 *  - On success, we stamp `last_sent_at`.
 */
export async function sendPushToAll(payload: PushPayload): Promise<SendResult> {
  const keys = getVapidKeys();
  ensureVapidConfigured(keys);

  const subs = await db
    .select()
    .from(pushSubscriptions)
    .where(isNull(pushSubscriptions.disabledAt));

  const json = JSON.stringify({
    title: payload.title,
    body: payload.body,
    url: payload.url ?? '/',
  });

  const result: SendResult = { sent: 0, disabled: 0, errored: 0 };

  // Sequential keeps the load on the push service modest and the audit log
  // ordered. Subscription counts are expected to be tiny (single-user app).
  for (const sub of subs) {
    try {
      await webPush.sendNotification(
        {
          endpoint: sub.endpoint,
          keys: { p256dh: sub.p256dh, auth: sub.auth },
        },
        json,
      );
      result.sent += 1;
      await db
        .update(pushSubscriptions)
        .set({ lastSentAt: new Date() })
        .where(eq(pushSubscriptions.id, sub.id));
    } catch (err) {
      const status = (err as { statusCode?: number }).statusCode ?? 0;
      const host = hostOf(sub.endpoint);

      if (status === 410 || status === 404) {
        // Subscription is dead — push service has dropped it. Soft-disable
        // so the next fan-out skips it. The next subscribe POST from the
        // same browser will clear `disabled_at` and re-arm it.
        await db
          .update(pushSubscriptions)
          .set({ disabledAt: new Date() })
          .where(
            and(eq(pushSubscriptions.id, sub.id), isNull(pushSubscriptions.disabledAt)),
          );
        result.disabled += 1;
      } else {
        result.errored += 1;
      }

      // Audit the failure regardless. No payload or headers — only the
      // shape needed to spot push-service outages or rate limiting.
      try {
        await db.insert(outboundAudit).values({
          kind: 'push.send',
          host,
          status: status || null,
          latencyMs: null,
        });
      } catch {
        // Audit write failure is non-fatal; we don't want push errors to
        // cascade into DB errors that abort an entire routine run.
      }
    }
  }

  return result;
}

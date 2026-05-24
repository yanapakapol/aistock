/**
 * Generate a fresh VAPID key pair for Web Push.
 *
 * Usage:
 *   npx tsx scripts/generate-vapid.ts
 *
 * Then copy the two lines into `apps/web/.env` (alongside VAPID_SUBJECT).
 * Rotating these keys invalidates every existing push subscription —
 * browsers will silently fail until users re-subscribe.
 */
import webPush from 'web-push';

function main() {
  const keys = webPush.generateVAPIDKeys();
  // Plain process.stdout.write — keep output paste-friendly, no banners.
  process.stdout.write(
    [
      '# Generated VAPID key pair — set these in apps/web/.env',
      `VAPID_PUBLIC_KEY=${keys.publicKey}`,
      `VAPID_PRIVATE_KEY=${keys.privateKey}`,
      '# VAPID_SUBJECT must be a mailto: or https: URL the push service can contact you at.',
      'VAPID_SUBJECT=mailto:you@example.com',
      '',
    ].join('\n'),
  );
}

main();

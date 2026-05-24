/**
 * Convert a URL-safe base64 string (VAPID public key) into the Uint8Array
 * that `pushManager.subscribe({applicationServerKey})` requires.
 *
 * Standard PWA recipe — see
 * https://developer.mozilla.org/en-US/docs/Web/API/PushManager/subscribe
 */
export function urlBase64ToUint8Array(b64: string): Uint8Array {
  const padding = '='.repeat((4 - (b64.length % 4)) % 4);
  const base64 = (b64 + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = typeof atob === 'function' ? atob(base64) : Buffer.from(base64, 'base64').toString('binary');
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

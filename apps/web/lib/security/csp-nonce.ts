import { randomBytes } from 'node:crypto';

/**
 * Generate a per-request CSP nonce. Use in middleware to set
 * `Content-Security-Policy: script-src 'self' 'nonce-<value>'` and pass the
 * nonce to the Next.js render via a request header (`x-nonce`) the layout
 * can read with `headers()`.
 *
 * Kept minimal — wire-up happens when we lock down inline scripts in M7+.
 */
export function generateCspNonce(): string {
  return randomBytes(16).toString('base64');
}

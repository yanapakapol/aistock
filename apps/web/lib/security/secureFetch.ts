import 'server-only';
import { db } from '../db/client';
import { outboundAudit } from '../db/schema';
import { isHostAllowed } from './allowlist';

export interface SecureFetchOpts {
  /** Short category for audit row, e.g. "llm.openai", "market.yahoo", "news.tavily". */
  kind: string;
}

function hostFromInput(input: RequestInfo | URL): string {
  if (typeof input === 'string') return new URL(input).host;
  if (input instanceof URL) return input.host;
  // Request
  return new URL(input.url).host;
}

/**
 * `fetch` wrapper that:
 *  1. Refuses to hit any host not in `OUTBOUND_HOSTS`.
 *  2. Writes a single row to `outbound_audit` (host, status, latency) regardless of
 *     success or failure. Headers and body are never stored.
 *
 * Token-cost columns are left null here; the chat pipeline updates them after the
 * response is metered (see `lib/cost/meter.ts`).
 */
export async function secureFetch(
  input: RequestInfo | URL,
  init?: RequestInit,
  opts: SecureFetchOpts = { kind: 'unknown' },
): Promise<Response> {
  const host = hostFromInput(input);
  if (!isHostAllowed(host)) {
    // Audit the rejection so silent allowlist drift is visible.
    void recordAudit(opts.kind, host, 0, 0).catch(() => {});
    throw new Error('outbound host not allowlisted: ' + host);
  }

  const start = Date.now();
  let status = 0;
  try {
    const res = await fetch(input, init);
    status = res.status;
    return res;
  } finally {
    const latencyMs = Date.now() - start;
    void recordAudit(opts.kind, host, status, latencyMs).catch(() => {});
  }
}

async function recordAudit(kind: string, host: string, status: number, latencyMs: number) {
  await db.insert(outboundAudit).values({
    kind,
    host,
    status: status || null,
    latencyMs,
  });
}

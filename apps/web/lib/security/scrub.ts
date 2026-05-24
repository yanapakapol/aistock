/**
 * Secret scrubber. Allowlist mindset: anything that *looks* like an API key
 * gets replaced with `[REDACTED]` before it is shown to the LLM, written to
 * disk, or returned in an error. Applied to every tool result and every error
 * message bubbled out of the chat pipeline.
 *
 * Intentionally not deps on `server-only` so it can be unit-tested under
 * `node --test`.
 */

const REDACTED = '[REDACTED]';

// Known-shape provider keys. Order matters — more specific first.
const KNOWN_KEY_PATTERNS: RegExp[] = [
  /sk-ant-[A-Za-z0-9_\-]{16,}/g, // Anthropic
  /sk-[A-Za-z0-9_\-]{16,}/g, // OpenAI / DeepSeek / Moonshot
  /AIza[0-9A-Za-z_\-]{20,}/g, // Google
];

// Trigger words for the generic high-entropy rule. A 32+ char token within 32
// chars of one of these triggers gets redacted.
const KEY_LIKE_TRIGGER = /(?:key|token|secret|bearer|authorization|api[_-]?key)/gi;
const HIGH_ENTROPY_TOKEN = /[A-Za-z0-9_\-]{32,}/g;

// Header-style keys we drop wholesale from objects.
const DROP_KEYS = new Set(['authorization', 'x-api-key', 'cookie', 'set-cookie']);

function scrubString(input: string): string {
  let out = input;
  for (const re of KNOWN_KEY_PATTERNS) {
    out = out.replace(re, REDACTED);
  }

  // Generic rule: walk every high-entropy token and redact if any trigger word
  // sits within 32 chars on either side.
  const tokens: Array<{ start: number; end: number }> = [];
  for (const m of out.matchAll(HIGH_ENTROPY_TOKEN)) {
    tokens.push({ start: m.index ?? 0, end: (m.index ?? 0) + m[0].length });
  }
  if (tokens.length === 0) return out;

  const triggers: Array<{ start: number; end: number }> = [];
  for (const m of out.matchAll(KEY_LIKE_TRIGGER)) {
    triggers.push({ start: m.index ?? 0, end: (m.index ?? 0) + m[0].length });
  }
  if (triggers.length === 0) return out;

  // Replace from the right so indexes stay valid.
  const toRedact = tokens.filter((tok) =>
    triggers.some((tr) => {
      const gap = tok.start >= tr.end ? tok.start - tr.end : tr.start - tok.end;
      return gap <= 32;
    }),
  );
  for (let i = toRedact.length - 1; i >= 0; i--) {
    const t = toRedact[i];
    out = out.slice(0, t.start) + REDACTED + out.slice(t.end);
  }
  return out;
}

/**
 * Recursively walks any value, returning a structurally-identical clone with
 * suspected secrets redacted. Cycle-safe.
 */
export function scrubSecrets(value: unknown, seen: WeakSet<object> = new WeakSet()): unknown {
  if (value == null) return value;
  if (typeof value === 'string') return scrubString(value);
  if (typeof value !== 'object') return value;

  if (seen.has(value as object)) return '[Circular]';
  seen.add(value as object);

  if (Array.isArray(value)) {
    return value.map((v) => scrubSecrets(v, seen));
  }

  // Plain object: drop forbidden keys, recurse on the rest.
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (DROP_KEYS.has(k.toLowerCase())) continue;
    out[k] = scrubSecrets(v, seen);
  }
  return out;
}

export interface SanitizedError {
  status?: number;
  code?: string;
  message: string;
}

/**
 * Turns any thrown thing into a flat `{status?, code?, message}` object with
 * the message run through `scrubSecrets`. Anything else on the original error
 * (stack, headers, response body) is discarded — those routinely echo the
 * caller's Authorization header back.
 */
export function sanitizeError(err: unknown): SanitizedError {
  if (err == null) return { message: 'unknown error' };

  if (typeof err === 'string') {
    return { message: scrubString(err) };
  }

  if (typeof err !== 'object') {
    return { message: scrubString(String(err)) };
  }

  const e = err as Record<string, unknown>;
  const out: SanitizedError = {
    message: scrubString(typeof e.message === 'string' ? e.message : String(err)),
  };
  if (typeof e.status === 'number') out.status = e.status;
  if (typeof e.code === 'string') out.code = e.code;
  return out;
}

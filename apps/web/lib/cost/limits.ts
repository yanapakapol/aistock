import 'server-only';

/**
 * Per-provider daily USD cap, env-driven.
 *
 * Resolves a per-provider $ ceiling for the GLOBAL daily ledger spend
 * (sum of every user's calls to that provider in a UTC day). This is the
 * "runaway-script" safety net — distinct from:
 *   - per-user `users.daily_usd_cap`         (admin can set per user)
 *   - per-turn `EFFORT_PRESETS[effort].usd`   (caps one chat turn)
 *   - per-run `routines.max_usd_per_run`      (caps one routine run)
 *
 * Previously the chat + scheduler routes passed the per-turn / per-run cap
 * as if it were a daily cap, so the moment the daily ledger crossed the
 * per-turn budget (e.g. $0.15) every subsequent call failed with
 * `budget_exceeded`. That was a bug; this module is the replacement.
 *
 * Env wiring (checked in order):
 *   1. `PROVIDER_DAILY_USD_CAP_<PROVIDER>`   per-provider override
 *      e.g. PROVIDER_DAILY_USD_CAP_MISTRAL=20
 *   2. `PROVIDER_DAILY_USD_CAP`              global default for any provider
 *   3. fallback: $50/day
 *
 * Set a value to `0` or `disabled` to turn the cap off for that provider
 * (returns `null`, which `checkBudgetOrThrow` treats as no cap).
 */
const DEFAULT_DAILY_USD_CAP = 50;

function parseCap(raw: string | undefined): number | null | undefined {
  if (raw === undefined) return undefined; // env var unset → try next source
  const trimmed = raw.trim().toLowerCase();
  if (trimmed === '' || trimmed === 'disabled' || trimmed === 'off') return null;
  const n = Number(trimmed);
  if (!Number.isFinite(n)) return undefined; // ignore garbage, fall through
  if (n <= 0) return null; // explicit zero → cap disabled
  return n;
}

export function getProviderDailyCap(provider: string): number {
  const upper = provider.toUpperCase().replace(/[^A-Z0-9_]/g, '_');
  const perProvider = parseCap(process.env[`PROVIDER_DAILY_USD_CAP_${upper}`]);
  if (perProvider !== undefined) return perProvider ?? 0;

  const generic = parseCap(process.env.PROVIDER_DAILY_USD_CAP);
  if (generic !== undefined) return generic ?? 0;

  return DEFAULT_DAILY_USD_CAP;
}

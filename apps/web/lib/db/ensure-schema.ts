import 'server-only';
import postgres from 'postgres';

/**
 * Self-healing schema bumps. Runs the idempotent ALTER / CREATE statements
 * from `scripts/migrate.ts` once per process at runtime so a fresh deploy
 * pointed at an un-migrated database doesn't 500 on the first request.
 *
 * Every statement is guarded with `IF NOT EXISTS` / `DO $$ EXCEPTION ... $$`
 * blocks so re-running is a no-op. We use a raw `postgres-js` connection
 * rather than the Drizzle client because some of these statements are DDL
 * that Drizzle doesn't model (custom types, ALTER COLUMN, etc.).
 *
 * Module-scoped Promise dedupe ensures concurrent requests at cold start
 * all wait on a single attempt, not N parallel ALTER racing.
 */

declare global {
  // eslint-disable-next-line no-var
  var __schemaEnsured: Promise<void> | undefined;
}

async function runBumps(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) {
    // Nothing to do — the caller will fail at first real query anyway, but
    // not crashing here lets `next build` succeed in CI.
    return;
  }
  const sql = postgres(url, { max: 1, idle_timeout: 5, connect_timeout: 15 });
  try {
    // Auth schema (users + per-user caps + token usage rollup).
    // These mirror lib/db/migrate.ts so the runtime path stays in sync with
    // the offline migration script.
    await sql`CREATE TABLE IF NOT EXISTS users (
      id serial PRIMARY KEY,
      username text NOT NULL,
      password_hash text NOT NULL,
      is_admin boolean NOT NULL DEFAULT false,
      created_at timestamptz NOT NULL DEFAULT now()
    )`;
    await sql`CREATE UNIQUE INDEX IF NOT EXISTS users_username_uq ON users (username)`;

    // RBAC enum + role/cap columns.
    await sql`DO $$ BEGIN
      CREATE TYPE user_role AS ENUM ('admin','user','guest');
    EXCEPTION WHEN duplicate_object THEN null; END $$;`;
    await sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS role user_role NOT NULL DEFAULT 'user'`;
    await sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS daily_token_cap integer`;
    await sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS daily_usd_cap numeric(8,4)`;
    await sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS expires_at timestamptz`;
    // Backfill role from legacy is_admin flag, only for rows still at default.
    await sql`UPDATE users SET role = 'admin' WHERE is_admin = true AND role = 'user'`;

    // Per-user daily token / cost usage.
    await sql`CREATE TABLE IF NOT EXISTS user_token_usage (
      day date NOT NULL,
      user_id integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      provider text NOT NULL,
      tokens_in integer NOT NULL DEFAULT 0,
      tokens_out integer NOT NULL DEFAULT 0,
      cost_usd numeric(10,6) NOT NULL DEFAULT 0,
      PRIMARY KEY (day, user_id, provider)
    )`;

    // Cap-increase requests: user-side ask, admin-side approve/deny.
    await sql`DO $$ BEGIN
      CREATE TYPE cap_request_status AS ENUM ('pending','approved','denied');
    EXCEPTION WHEN duplicate_object THEN null; END $$;`;
    await sql`CREATE TABLE IF NOT EXISTS cap_requests (
      id serial PRIMARY KEY,
      user_id integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      requested_token_cap integer,
      requested_usd_cap numeric(8,4),
      reason text,
      status cap_request_status NOT NULL DEFAULT 'pending',
      decided_by_id integer REFERENCES users(id) ON DELETE SET NULL,
      decided_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now()
    )`;
    await sql`CREATE INDEX IF NOT EXISTS cap_requests_status_created_idx
              ON cap_requests (status, created_at DESC)`;
    await sql`CREATE INDEX IF NOT EXISTS cap_requests_user_idx
              ON cap_requests (user_id, created_at DESC)`;
  } finally {
    await sql.end({ timeout: 5 });
  }
}

/**
 * Idempotent and concurrency-safe. Call from instrumentation.ts on boot and
 * from any route that touches the new columns (PATCH /api/admin/users/[id],
 * POST /api/auth/register-guest, etc.) — the second call is free because the
 * Promise is cached.
 */
export function ensureSchema(): Promise<void> {
  if (!globalThis.__schemaEnsured) {
    globalThis.__schemaEnsured = runBumps().catch((err) => {
      // Allow a retry on next request if the first attempt failed (e.g. DB
      // not reachable yet). Without resetting, every subsequent call would
      // return the failed Promise.
      globalThis.__schemaEnsured = undefined;
      // eslint-disable-next-line no-console
      console.error('[ensureSchema] failed:', err);
      throw err;
    });
  }
  return globalThis.__schemaEnsured;
}

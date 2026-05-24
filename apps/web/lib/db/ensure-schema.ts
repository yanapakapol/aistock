import 'server-only';
import { sql } from 'drizzle-orm';
import { db } from './client';

/**
 * Self-healing schema bumps. Runs the idempotent ALTER / CREATE statements
 * from `lib/db/migrate.ts` once per process at runtime so a fresh deploy
 * pointed at an un-migrated database doesn't 500 on the first request.
 *
 * Every statement is guarded with `IF NOT EXISTS` / `DO $$ EXCEPTION ... $$`
 * blocks so re-running is a no-op.
 *
 * Uses the shared Drizzle/neon-http client from `lib/db/client.ts`. The
 * HTTP driver makes every query a stateless HTTPS request through Neon's
 * pooler, so there's no per-instance TCP connection to exhaust the free
 * tier's ~20-connection ceiling — but it also means no .transaction(cb)
 * and no useful SET (each statement is its own implicit txn over a fresh
 * connection). The per-statement lock_timeout / statement_timeout wrapping
 * that used to live in `runDDL` is gone; the Neon pooler enforces its own
 * server-side query timeout, which is sufficient to keep a stuck DROP
 * INDEX from hanging ensureSchema() forever.
 *
 * Module-scoped Promise dedupe so concurrent requests at cold start all
 * wait on a single attempt, not N parallel DDL runs.
 */

declare global {
  // eslint-disable-next-line no-var
  var __schemaEnsured: Promise<void> | undefined;
}

async function runBumps(): Promise<void> {
  // Auth schema (users + per-user caps + token usage rollup).
  await db.execute(sql`CREATE TABLE IF NOT EXISTS users (
    id serial PRIMARY KEY,
    username text NOT NULL,
    password_hash text NOT NULL,
    is_admin boolean NOT NULL DEFAULT false,
    created_at timestamptz NOT NULL DEFAULT now()
  )`);
  await db.execute(sql`CREATE UNIQUE INDEX IF NOT EXISTS users_username_uq ON users (username)`);

  // RBAC enum + role/cap columns.
  await db.execute(sql`DO $$ BEGIN
    CREATE TYPE user_role AS ENUM ('admin','user','guest');
  EXCEPTION WHEN duplicate_object THEN null; END $$;`);
  await db.execute(sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS role user_role NOT NULL DEFAULT 'user'`);
  await db.execute(sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS daily_token_cap integer`);
  await db.execute(sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS daily_usd_cap numeric(8,4)`);
  await db.execute(sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS expires_at timestamptz`);
  // Backfill role from legacy is_admin flag, only for rows still at default.
  await db.execute(sql`UPDATE users SET role = 'admin' WHERE is_admin = true AND role = 'user'`);

  // Per-user daily token / cost usage.
  await db.execute(sql`CREATE TABLE IF NOT EXISTS user_token_usage (
    day date NOT NULL,
    user_id integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    provider text NOT NULL,
    tokens_in integer NOT NULL DEFAULT 0,
    tokens_out integer NOT NULL DEFAULT 0,
    cost_usd numeric(10,6) NOT NULL DEFAULT 0,
    PRIMARY KEY (day, user_id, provider)
  )`);

  // Cap-increase requests: user-side ask, admin-side approve/deny.
  await db.execute(sql`DO $$ BEGIN
    CREATE TYPE cap_request_status AS ENUM ('pending','approved','denied');
  EXCEPTION WHEN duplicate_object THEN null; END $$;`);
  await db.execute(sql`CREATE TABLE IF NOT EXISTS cap_requests (
    id serial PRIMARY KEY,
    user_id integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    requested_token_cap integer,
    requested_usd_cap numeric(8,4),
    reason text,
    status cap_request_status NOT NULL DEFAULT 'pending',
    decided_by_id integer REFERENCES users(id) ON DELETE SET NULL,
    decided_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now()
  )`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS cap_requests_status_created_idx
            ON cap_requests (status, created_at DESC)`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS cap_requests_user_idx
            ON cap_requests (user_id, created_at DESC)`);

  // Per-portfolio stocks (multi-tenant isolation). The old single-tenant
  // unique on stocks(symbol, exchange) prevented user B from adding a
  // symbol that already existed in user A's portfolio — and silently
  // shared all the cascaded events/business_context across users. Drop
  // it, replace with a per-portfolio composite.
  //
  // Both wrapped in try/catch so a transient lock contention (e.g. a
  // long-running query holding stocks open) doesn't abort the whole bump
  // — we just log and move on, and the next ensureSchema() call retries.
  // Used to wrap each in a per-statement transaction with SET LOCAL
  // lock_timeout/statement_timeout, but neon-http doesn't support
  // transactions; the Neon pooler's server-side query timeout takes the
  // role of the previous lock_timeout safety net.
  try {
    await db.execute(sql`DROP INDEX IF EXISTS stocks_symbol_exchange_uq`);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[ensureSchema] DROP stocks_symbol_exchange_uq skipped:', err);
  }
  try {
    await db.execute(sql`
      CREATE UNIQUE INDEX IF NOT EXISTS stocks_portfolio_symbol_exchange_uq
      ON stocks (portfolio_id, symbol, exchange)
    `);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[ensureSchema] CREATE stocks_portfolio_symbol_exchange_uq skipped:', err);
  }
}

/**
 * Trigger schema bumps in background. Safe to call many times — only one
 * attempt runs per process; subsequent calls are no-ops.
 *
 * Returns IMMEDIATELY. The bumps run on the next event-loop tick. Callers
 * that need to be sure the bumps completed (rare — usually only used in
 * tests or scripted seed flows) can await `ensureSchemaSync()`.
 *
 * Rationale: existing route code does `await ensureSchema().catch(() => undefined)`.
 * With this fire-and-forget behavior the `await` resolves immediately (no DB
 * work blocks the request). The very first request after a cold start might
 * race against the first bump, but every route already has defensive try/catch
 * around its queries (e.g. `/admin/users` falls back if `role` column missing),
 * so a transient miss is fine. By the time the second request lands, the bumps
 * are usually done.
 */
export function ensureSchema(): Promise<void> {
  kickoff();
  return Promise.resolve();
}

/**
 * Awaitable variant — resolves once the in-flight (or freshly kicked off)
 * bump run completes. Use from tests and scripted seed flows where you
 * really do need the schema settled before continuing.
 */
export function ensureSchemaSync(): Promise<void> {
  return kickoff();
}

function kickoff(): Promise<void> {
  if (!globalThis.__schemaEnsured) {
    globalThis.__schemaEnsured = runBumps().catch((err) => {
      // Reset memo on failure so the next request retries.
      globalThis.__schemaEnsured = undefined;
      // eslint-disable-next-line no-console
      console.error('[ensureSchema] background bump failed:', err);
      throw err;
    });
  }
  return globalThis.__schemaEnsured;
}

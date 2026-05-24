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
 * Uses the shared Drizzle/postgres-js pool from `lib/db/client.ts` rather
 * than opening a parallel connection — Vercel cold starts can hit Neon's
 * connection ceiling (~20 on free) when too many serverless instances spin
 * up at once, and a second pool was occasionally timing out on TLS while
 * the first request was still warming. Reusing the pool eliminates that.
 *
 * Module-scoped Promise dedupe so concurrent requests at cold start all
 * wait on a single attempt, not N parallel DDL runs.
 */

declare global {
  // eslint-disable-next-line no-var
  var __schemaEnsured: Promise<void> | undefined;
}

/**
 * Per-statement helper that scopes each DDL to a short transaction with
 * its own lock_timeout / statement_timeout. Without this, a DROP INDEX
 * waiting on a leaked SHARE lock would hang forever and block every
 * route that awaits ensureSchema(). The wider ensureSchema() routine
 * already wraps the whole thing in try/catch around per-statement
 * failures so one stuck DDL doesn't poison the rest.
 */
async function runDDL(stmt: ReturnType<typeof sql>): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL lock_timeout = '5s'`);
    await tx.execute(sql`SET LOCAL statement_timeout = '15s'`);
    await tx.execute(stmt);
  });
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
  // Both wrapped so a transient lock contention (e.g. a long-running query
  // holding stocks open) doesn't abort the whole bump. On lock_timeout we
  // log and keep going; next request will retry.
  // These two are the only DDL that might contend on a held lock (stocks
  // is the busy table). Run them via runDDL so a stuck lock fails fast
  // instead of hanging the whole route through ensureSchema(). Other DDL
  // above runs on tables that nothing else touches at boot, so the extra
  // transaction overhead isn't worth it for them.
  try {
    await runDDL(sql`DROP INDEX IF EXISTS stocks_symbol_exchange_uq`);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[ensureSchema] DROP stocks_symbol_exchange_uq skipped:', err);
  }
  try {
    await runDDL(sql`
      CREATE UNIQUE INDEX IF NOT EXISTS stocks_portfolio_symbol_exchange_uq
      ON stocks (portfolio_id, symbol, exchange)
    `);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[ensureSchema] CREATE stocks_portfolio_symbol_exchange_uq skipped:', err);
  }
}

/**
 * Idempotent and concurrency-safe. Call from instrumentation.ts on boot and
 * from any route that touches the new columns — the second call is free
 * because the Promise is cached. A failure clears the memo so the next
 * request retries (e.g. transient DB unavailability at cold start).
 */
export function ensureSchema(): Promise<void> {
  if (!globalThis.__schemaEnsured) {
    globalThis.__schemaEnsured = runBumps().catch((err) => {
      globalThis.__schemaEnsured = undefined;
      // eslint-disable-next-line no-console
      console.error('[ensureSchema] failed:', err);
      throw err;
    });
  }
  return globalThis.__schemaEnsured;
}

import 'dotenv/config';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';

const url = process.env.DATABASE_URL;
if (!url) {
  throw new Error(
    'DATABASE_URL is not set. The script loads `.env` from the current working ' +
    'directory — run from `apps/web/` (e.g. `npm run -w apps/web db:migrate`) ' +
    'and make sure apps/web/.env contains DATABASE_URL=postgres://user:pw@host:port/db',
  );
}

// Mask password so it's safe to print.
const masked = url.replace(/:\/\/([^:]+):([^@]+)@/, '://$1:***@');
console.log(`[migrate] connecting to ${masked}`);

async function main() {
  const sql = postgres(url!, {
    max: 1,
    connect_timeout: 30,
    idle_timeout: 5,
  });

  // Pre-migration: enable required Postgres extensions.
  // ParadeDB image already loads pg_search; CREATE EXTENSION is idempotent on Postgres images too.
  await sql`CREATE EXTENSION IF NOT EXISTS vector;`;
  

  await migrate(drizzle(sql), { migrationsFolder: './lib/db/migrations' });

  // Post-migration: HNSW indexes on vector columns (Drizzle doesn't emit these).
  // One partial index per (table x embedding column). Each row writes exactly
  // one of the three columns, so the WHERE clause keeps each index small and
  // avoids "vector must have N dimensions" errors on NULL rows.
  // news_chunks
  await sql`CREATE INDEX IF NOT EXISTS news_chunks_embedding_1536_hnsw
            ON news_chunks USING hnsw (embedding_1536 vector_cosine_ops)
            WHERE embedding_1536 IS NOT NULL`;
  await sql`CREATE INDEX IF NOT EXISTS news_chunks_embedding_768_hnsw
            ON news_chunks USING hnsw (embedding_768 vector_cosine_ops)
            WHERE embedding_768 IS NOT NULL`;
  await sql`CREATE INDEX IF NOT EXISTS news_chunks_embedding_1024_hnsw
            ON news_chunks USING hnsw (embedding_1024 vector_cosine_ops)
            WHERE embedding_1024 IS NOT NULL`;
  // research_notes
  await sql`CREATE INDEX IF NOT EXISTS research_notes_embedding_1536_hnsw
            ON research_notes USING hnsw (embedding_1536 vector_cosine_ops)
            WHERE embedding_1536 IS NOT NULL`;
  await sql`CREATE INDEX IF NOT EXISTS research_notes_embedding_768_hnsw
            ON research_notes USING hnsw (embedding_768 vector_cosine_ops)
            WHERE embedding_768 IS NOT NULL`;
  await sql`CREATE INDEX IF NOT EXISTS research_notes_embedding_1024_hnsw
            ON research_notes USING hnsw (embedding_1024 vector_cosine_ops)
            WHERE embedding_1024 IS NOT NULL`;
  // business_context_chunks
  await sql`CREATE INDEX IF NOT EXISTS business_context_chunks_embedding_1536_hnsw
            ON business_context_chunks USING hnsw (embedding_1536 vector_cosine_ops)
            WHERE embedding_1536 IS NOT NULL`;
  await sql`CREATE INDEX IF NOT EXISTS business_context_chunks_embedding_768_hnsw
            ON business_context_chunks USING hnsw (embedding_768 vector_cosine_ops)
            WHERE embedding_768 IS NOT NULL`;
  await sql`CREATE INDEX IF NOT EXISTS business_context_chunks_embedding_1024_hnsw
            ON business_context_chunks USING hnsw (embedding_1024 vector_cosine_ops)
            WHERE embedding_1024 IS NOT NULL`;

  // Add `parts jsonb` to chat_messages (post-init schema bump). Idempotent.
  await sql`ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS parts jsonb`;

  // ---- Auth schema bumps ----
  await sql`CREATE TABLE IF NOT EXISTS users (
    id serial PRIMARY KEY,
    username text NOT NULL,
    password_hash text NOT NULL,
    is_admin boolean NOT NULL DEFAULT false,
    created_at timestamptz NOT NULL DEFAULT now()
  )`;
  await sql`CREATE UNIQUE INDEX IF NOT EXISTS users_username_uq ON users (username)`;
  await sql`ALTER TABLE portfolios ADD COLUMN IF NOT EXISTS user_id integer REFERENCES users(id) ON DELETE CASCADE`;
  await sql`ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS user_id integer REFERENCES users(id) ON DELETE CASCADE`;
  // Drop the old single-key-per-provider unique and re-key on (user_id, provider).
  await sql`DROP INDEX IF EXISTS api_keys_provider_uq`;
  await sql`CREATE UNIQUE INDEX IF NOT EXISTS api_keys_user_provider_uq ON api_keys (user_id, provider)`;

  // ---- RBAC + per-user caps (additive; existing data untouched) ----
  // 1. Enum type. duplicate_object guard so re-runs are no-ops.
  await sql`DO $$ BEGIN
    CREATE TYPE user_role AS ENUM ('admin','user','guest');
  EXCEPTION WHEN duplicate_object THEN null; END $$;`;
  // 2. New columns on users. All NULL-safe / defaulted so existing rows survive.
  await sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS role user_role NOT NULL DEFAULT 'user'`;
  await sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS daily_token_cap integer`;
  await sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS daily_usd_cap numeric(8,4)`;
  await sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS expires_at timestamptz`;
  // 3. Backfill role from legacy is_admin flag. Only touches rows still at the
  //    default 'user' so re-running after manual edits stays safe.
  await sql`UPDATE users SET role = 'admin' WHERE is_admin = true AND role = 'user'`;

  // ---- Per-user daily token / cost usage roll-up ----
  await sql`CREATE TABLE IF NOT EXISTS user_token_usage (
    day date NOT NULL,
    user_id integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    provider text NOT NULL,
    tokens_in integer NOT NULL DEFAULT 0,
    tokens_out integer NOT NULL DEFAULT 0,
    cost_usd numeric(10,6) NOT NULL DEFAULT 0,
    PRIMARY KEY (day, user_id, provider)
  )`;

  // chat_summaries — ad-hoc create so users don't need to re-run db:generate
  // when this table was added after the initial schema snapshot.
  await sql`CREATE TABLE IF NOT EXISTS chat_summaries (
    id serial PRIMARY KEY,
    chat_id integer NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
    summary_md text NOT NULL,
    model text,
    tokens_in integer,
    tokens_out integer,
    cost_usd numeric(10,6),
    created_at timestamptz NOT NULL DEFAULT now()
  )`;
  await sql`CREATE INDEX IF NOT EXISTS chat_summaries_chat_idx
            ON chat_summaries (chat_id, created_at)`;

  // ---- Cap-increase requests (user→admin asks for more tokens) ----
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

  // ---- Per-portfolio stocks (multi-tenant isolation) ----
  await sql`DROP INDEX IF EXISTS stocks_symbol_exchange_uq`;
  await sql`CREATE UNIQUE INDEX IF NOT EXISTS stocks_portfolio_symbol_exchange_uq
            ON stocks (portfolio_id, symbol, exchange)`;

  // ---- Per-user ownership on routines (multi-tenant) ----
  // Nullable so pre-existing rows survive — the route layer treats NULL
  // user_id as "orphan, do not list to anyone". Every NEW insert MUST set
  // user_id (see app/api/routines/route.ts + lib/mcp/tools/createRoutine.ts).
  // The Vercel-Cron-driven runDueRoutines path is privileged and ignores
  // user_id by design (the cron is the system, not a user).
  await sql`ALTER TABLE routines ADD COLUMN IF NOT EXISTS user_id integer REFERENCES users(id) ON DELETE CASCADE`;
  await sql`CREATE INDEX IF NOT EXISTS routines_user_idx ON routines(user_id)`;

  await sql.end();
  // eslint-disable-next-line no-console
  console.log('migrated');
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});

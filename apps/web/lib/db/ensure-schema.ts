import 'server-only';
import { sql } from 'drizzle-orm';
import { db } from './client';

/**
 * Self-healing schema bumps. Runs the idempotent ALTER / CREATE statements
 * from `lib/db/migrate.ts` once per process at runtime so a fresh deploy
 * pointed at an un-migrated database doesn't 500 on the first request.
 *
 * The big win: ensureSchema now also covers the *initial* schema that
 * `migrate.ts` would otherwise create via Drizzle's migrator. That means a
 * fresh empty Neon database self-bootstraps on the first HTTP request — no
 * `npm run db:migrate` step required for cloud-only "turn off PC, cloud
 * keeps working" deploys.
 *
 * Every statement is guarded with `IF NOT EXISTS` / `DO $$ EXCEPTION ... $$`
 * blocks so re-running is a no-op. Statements that may fail on managed
 * Postgres (e.g. CREATE EXTENSION on a non-superuser DB, or a transient
 * lock contention dropping an old index) are wrapped in `tryStmt()` so one
 * missing capability doesn't poison the rest of the run.
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

/**
 * Run one DDL statement, swallow + warn on failure so the next statement
 * still gets a chance. Used for statements that may legitimately fail on
 * some database configs (CREATE EXTENSION without superuser, DROP INDEX
 * during contention, ADD CONSTRAINT when the FK target table is missing
 * because a prior CREATE TABLE statement crashed, etc.).
 */
async function tryStmt(label: string, statement: string): Promise<void> {
  try {
    await db.execute(sql.raw(statement));
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(`[ensureSchema] ${label} skipped:`, err);
  }
}

async function runBumps(): Promise<void> {
  // ---------------------------------------------------------------------
  // 0. Required Postgres extensions.
  //    `vector` powers pgvector columns on news_chunks / research_notes /
  //    business_context_chunks. CREATE EXTENSION may fail on managed DBs
  //    where the role isn't a superuser — Neon allows it by default, but
  //    we still guard with tryStmt() so a hostile provider can't kill
  //    the rest of the bump.
  // ---------------------------------------------------------------------
  await tryStmt('CREATE EXTENSION vector', 'CREATE EXTENSION IF NOT EXISTS vector');

  // ---------------------------------------------------------------------
  // 1. Drizzle-generated initial schema (lib/db/migrations/0000_*.sql).
  //    Each CREATE TYPE / CREATE TABLE / ALTER TABLE / CREATE INDEX from
  //    the initial migration, expressed as an idempotent statement.
  //    Enums use DO $$ ... EXCEPTION WHEN duplicate_object guards; tables
  //    use IF NOT EXISTS; FK ALTERs and the legacy api_keys_provider_uq
  //    use tryStmt because they don't support IF NOT EXISTS natively.
  // ---------------------------------------------------------------------

  // 1a. Enums.
  await db.execute(sql`DO $$ BEGIN
    CREATE TYPE "date_precision" AS ENUM ('day', 'week', 'month');
  EXCEPTION WHEN duplicate_object THEN null; END $$;`);
  await db.execute(sql`DO $$ BEGIN
    CREATE TYPE "message_role" AS ENUM ('user', 'assistant', 'system', 'tool');
  EXCEPTION WHEN duplicate_object THEN null; END $$;`);
  await db.execute(sql`DO $$ BEGIN
    CREATE TYPE "research_status" AS ENUM ('todo', 'researching', 'done', 'failed');
  EXCEPTION WHEN duplicate_object THEN null; END $$;`);
  await db.execute(sql`DO $$ BEGIN
    CREATE TYPE "routine_status" AS ENUM ('pending', 'running', 'completed', 'failed', 'skipped');
  EXCEPTION WHEN duplicate_object THEN null; END $$;`);
  await db.execute(sql`DO $$ BEGIN
    CREATE TYPE "sentiment_label" AS ENUM ('bull', 'bear', 'neutral');
  EXCEPTION WHEN duplicate_object THEN null; END $$;`);
  await db.execute(sql`DO $$ BEGIN
    CREATE TYPE "session_relative" AS ENUM ('pre', 'intraday', 'post', 'overnight');
  EXCEPTION WHEN duplicate_object THEN null; END $$;`);
  await db.execute(sql`DO $$ BEGIN
    CREATE TYPE "tab" AS ENUM ('research', 'analysis');
  EXCEPTION WHEN duplicate_object THEN null; END $$;`);

  // 1b. Tables. All IF NOT EXISTS so existing DBs are unaffected.
  await db.execute(sql`CREATE TABLE IF NOT EXISTS "api_keys" (
    "id" serial PRIMARY KEY NOT NULL,
    "provider" text NOT NULL,
    "kid" integer DEFAULT 1 NOT NULL,
    "ciphertext" bytea NOT NULL,
    "nonce" bytea NOT NULL,
    "tag" bytea NOT NULL,
    "wrapped_dek" bytea NOT NULL,
    "dek_nonce" bytea NOT NULL,
    "dek_tag" bytea NOT NULL,
    "created_at" timestamp with time zone DEFAULT now() NOT NULL,
    "last_used_at" timestamp with time zone
  )`);
  await db.execute(sql`CREATE TABLE IF NOT EXISTS "budget_ledger" (
    "day" date NOT NULL,
    "provider" text NOT NULL,
    "usd_spent" numeric(10, 4) DEFAULT '0' NOT NULL,
    CONSTRAINT "budget_ledger_day_provider_pk" PRIMARY KEY ("day","provider")
  )`);
  await db.execute(sql`CREATE TABLE IF NOT EXISTS "business_context" (
    "id" serial PRIMARY KEY NOT NULL,
    "stock_id" integer NOT NULL,
    "summary_md" text DEFAULT '' NOT NULL,
    "timeline_md" text DEFAULT '' NOT NULL,
    "future_outlook_md" text DEFAULT '' NOT NULL,
    "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT "business_context_stock_id_unique" UNIQUE ("stock_id")
  )`);
  await db.execute(sql`CREATE TABLE IF NOT EXISTS "business_context_chunks" (
    "id" serial PRIMARY KEY NOT NULL,
    "stock_id" integer NOT NULL,
    "section" text NOT NULL,
    "chunk_text" text NOT NULL,
    "embedding_1536" vector(1536),
    "embedding_768" vector(768),
    "embedding_1024" vector(1024),
    "embedding_model" text NOT NULL,
    "created_at" timestamp with time zone DEFAULT now() NOT NULL
  )`);
  await db.execute(sql`CREATE TABLE IF NOT EXISTS "chat_messages" (
    "id" serial PRIMARY KEY NOT NULL,
    "chat_id" integer NOT NULL,
    "role" "message_role" NOT NULL,
    "content_md" text NOT NULL,
    "tool_calls" jsonb,
    "tokens_in" integer,
    "tokens_out" integer,
    "cost_usd" numeric(10, 6),
    "created_at" timestamp with time zone DEFAULT now() NOT NULL
  )`);
  await db.execute(sql`CREATE TABLE IF NOT EXISTS "chats" (
    "id" serial PRIMARY KEY NOT NULL,
    "tab" "tab" NOT NULL,
    "stock_id" integer,
    "model" text NOT NULL,
    "session_id" text,
    "created_at" timestamp with time zone DEFAULT now() NOT NULL
  )`);
  await db.execute(sql`CREATE TABLE IF NOT EXISTS "events" (
    "id" serial PRIMARY KEY NOT NULL,
    "stock_id" integer NOT NULL,
    "event_date" date NOT NULL,
    "event_ts" timestamp with time zone,
    "event_tz" text,
    "date_precision" "date_precision" DEFAULT 'day' NOT NULL,
    "session_relative" "session_relative",
    "title" text NOT NULL,
    "summary_md" text NOT NULL,
    "source_url" text NOT NULL,
    "source_title" text,
    "sentiment_score" numeric(3, 2),
    "sentiment_label" "sentiment_label",
    "created_at" timestamp with time zone DEFAULT now() NOT NULL
  )`);
  await db.execute(sql`CREATE TABLE IF NOT EXISTS "fundamentals" (
    "id" serial PRIMARY KEY NOT NULL,
    "stock_id" integer NOT NULL,
    "period" text NOT NULL,
    "metric" text NOT NULL,
    "value" numeric(24, 6) NOT NULL,
    "source" text NOT NULL,
    "fetched_at" timestamp with time zone DEFAULT now() NOT NULL
  )`);
  await db.execute(sql`CREATE TABLE IF NOT EXISTS "future_events" (
    "id" serial PRIMARY KEY NOT NULL,
    "stock_id" integer NOT NULL,
    "expected_date" date NOT NULL,
    "date_precision" "date_precision" DEFAULT 'day' NOT NULL,
    "title" text NOT NULL,
    "description_md" text NOT NULL,
    "probability_positive" numeric(4, 3),
    "probability_negative" numeric(4, 3),
    "expected_impact_pct" numeric(6, 3),
    "source_urls" jsonb DEFAULT '[]'::jsonb NOT NULL,
    "created_at" timestamp with time zone DEFAULT now() NOT NULL
  )`);
  await db.execute(sql`CREATE TABLE IF NOT EXISTS "models_cache" (
    "provider" text NOT NULL,
    "model_id" text NOT NULL,
    "payload" jsonb NOT NULL,
    "fetched_at" timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT "models_cache_provider_model_id_pk" PRIMARY KEY ("provider","model_id")
  )`);
  await db.execute(sql`CREATE TABLE IF NOT EXISTS "news_chunks" (
    "id" serial PRIMARY KEY NOT NULL,
    "stock_id" integer NOT NULL,
    "event_id" integer,
    "source_url" text NOT NULL,
    "published_at" timestamp with time zone,
    "chunk_text" text NOT NULL,
    "embedding_1536" vector(1536),
    "embedding_768" vector(768),
    "embedding_1024" vector(1024),
    "embedding_model" text NOT NULL,
    "created_at" timestamp with time zone DEFAULT now() NOT NULL
  )`);
  await db.execute(sql`CREATE TABLE IF NOT EXISTS "outbound_audit" (
    "id" serial PRIMARY KEY NOT NULL,
    "ts" timestamp with time zone DEFAULT now() NOT NULL,
    "kind" text NOT NULL,
    "host" text NOT NULL,
    "status" integer,
    "latency_ms" integer,
    "tokens" integer,
    "usd" numeric(10, 6)
  )`);
  await db.execute(sql`CREATE TABLE IF NOT EXISTS "portfolios" (
    "id" serial PRIMARY KEY NOT NULL,
    "name" text NOT NULL,
    "created_at" timestamp with time zone DEFAULT now() NOT NULL
  )`);
  await db.execute(sql`CREATE TABLE IF NOT EXISTS "prices_daily" (
    "stock_id" integer NOT NULL,
    "date" date NOT NULL,
    "open" numeric(18, 6) NOT NULL,
    "high" numeric(18, 6) NOT NULL,
    "low" numeric(18, 6) NOT NULL,
    "close" numeric(18, 6) NOT NULL,
    "volume" bigint NOT NULL,
    "source" text NOT NULL,
    CONSTRAINT "prices_daily_stock_id_date_pk" PRIMARY KEY ("stock_id","date")
  )`);
  await db.execute(sql`CREATE TABLE IF NOT EXISTS "prices_intraday" (
    "stock_id" integer NOT NULL,
    "ts" timestamp with time zone NOT NULL,
    "interval" text NOT NULL,
    "ohlcv" jsonb NOT NULL,
    "source" text NOT NULL,
    CONSTRAINT "prices_intraday_stock_id_ts_interval_pk" PRIMARY KEY ("stock_id","ts","interval")
  )`);
  await db.execute(sql`CREATE TABLE IF NOT EXISTS "push_subscriptions" (
    "id" serial PRIMARY KEY NOT NULL,
    "endpoint" text NOT NULL,
    "p256dh" text NOT NULL,
    "auth" text NOT NULL,
    "user_agent" text,
    "created_at" timestamp with time zone DEFAULT now() NOT NULL,
    "last_sent_at" timestamp with time zone,
    "disabled_at" timestamp with time zone,
    CONSTRAINT "push_subscriptions_endpoint_unique" UNIQUE ("endpoint")
  )`);
  await db.execute(sql`CREATE TABLE IF NOT EXISTS "research_notes" (
    "id" serial PRIMARY KEY NOT NULL,
    "stock_id" integer NOT NULL,
    "kind" text NOT NULL,
    "chunk_text" text NOT NULL,
    "embedding_1536" vector(1536),
    "embedding_768" vector(768),
    "embedding_1024" vector(1024),
    "embedding_model" text NOT NULL,
    "created_at" timestamp with time zone DEFAULT now() NOT NULL
  )`);
  await db.execute(sql`CREATE TABLE IF NOT EXISTS "research_tasks" (
    "id" serial PRIMARY KEY NOT NULL,
    "stock_id" integer NOT NULL,
    "driver" text NOT NULL,
    "status" "research_status" DEFAULT 'todo' NOT NULL,
    "notes_md" text,
    "created_at" timestamp with time zone DEFAULT now() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT now() NOT NULL
  )`);
  await db.execute(sql`CREATE TABLE IF NOT EXISTS "routine_runs" (
    "id" serial PRIMARY KEY NOT NULL,
    "routine_id" integer NOT NULL,
    "started_at" timestamp with time zone DEFAULT now() NOT NULL,
    "finished_at" timestamp with time zone,
    "status" "routine_status" DEFAULT 'pending' NOT NULL,
    "output_md" text,
    "export_path" text,
    "usd_spent" numeric(8, 4)
  )`);
  await db.execute(sql`CREATE TABLE IF NOT EXISTS "routines" (
    "id" serial PRIMARY KEY NOT NULL,
    "name" text NOT NULL,
    "prompt" text NOT NULL,
    "tab" "tab" NOT NULL,
    "model" text NOT NULL,
    "fallback_models" jsonb DEFAULT '[]'::jsonb NOT NULL,
    "cron_expr" text NOT NULL,
    "tz" text DEFAULT 'Asia/Bangkok' NOT NULL,
    "last_run_at" timestamp with time zone,
    "last_run_status" "routine_status",
    "enabled" boolean DEFAULT true NOT NULL,
    "max_usd_per_run" numeric(8, 4) DEFAULT '1.00' NOT NULL,
    "created_at" timestamp with time zone DEFAULT now() NOT NULL
  )`);
  await db.execute(sql`CREATE TABLE IF NOT EXISTS "stocks" (
    "id" serial PRIMARY KEY NOT NULL,
    "portfolio_id" integer,
    "symbol" text NOT NULL,
    "exchange" text NOT NULL,
    "mic" text,
    "name" text NOT NULL,
    "currency" text,
    "added_at" timestamp with time zone DEFAULT now() NOT NULL
  )`);

  // 1c. Foreign-key constraints. Postgres has no IF NOT EXISTS on ADD
  //     CONSTRAINT, so each one is wrapped in tryStmt — re-runs throw
  //     "constraint already exists" which we just swallow.
  await tryStmt(
    'FK business_context_stock_id',
    `ALTER TABLE "business_context" ADD CONSTRAINT "business_context_stock_id_stocks_id_fk" FOREIGN KEY ("stock_id") REFERENCES "public"."stocks"("id") ON DELETE cascade ON UPDATE no action`,
  );
  await tryStmt(
    'FK business_context_chunks_stock_id',
    `ALTER TABLE "business_context_chunks" ADD CONSTRAINT "business_context_chunks_stock_id_stocks_id_fk" FOREIGN KEY ("stock_id") REFERENCES "public"."stocks"("id") ON DELETE cascade ON UPDATE no action`,
  );
  await tryStmt(
    'FK chat_messages_chat_id',
    `ALTER TABLE "chat_messages" ADD CONSTRAINT "chat_messages_chat_id_chats_id_fk" FOREIGN KEY ("chat_id") REFERENCES "public"."chats"("id") ON DELETE cascade ON UPDATE no action`,
  );
  await tryStmt(
    'FK chats_stock_id',
    `ALTER TABLE "chats" ADD CONSTRAINT "chats_stock_id_stocks_id_fk" FOREIGN KEY ("stock_id") REFERENCES "public"."stocks"("id") ON DELETE set null ON UPDATE no action`,
  );
  await tryStmt(
    'FK events_stock_id',
    `ALTER TABLE "events" ADD CONSTRAINT "events_stock_id_stocks_id_fk" FOREIGN KEY ("stock_id") REFERENCES "public"."stocks"("id") ON DELETE cascade ON UPDATE no action`,
  );
  await tryStmt(
    'FK fundamentals_stock_id',
    `ALTER TABLE "fundamentals" ADD CONSTRAINT "fundamentals_stock_id_stocks_id_fk" FOREIGN KEY ("stock_id") REFERENCES "public"."stocks"("id") ON DELETE cascade ON UPDATE no action`,
  );
  await tryStmt(
    'FK future_events_stock_id',
    `ALTER TABLE "future_events" ADD CONSTRAINT "future_events_stock_id_stocks_id_fk" FOREIGN KEY ("stock_id") REFERENCES "public"."stocks"("id") ON DELETE cascade ON UPDATE no action`,
  );
  await tryStmt(
    'FK news_chunks_stock_id',
    `ALTER TABLE "news_chunks" ADD CONSTRAINT "news_chunks_stock_id_stocks_id_fk" FOREIGN KEY ("stock_id") REFERENCES "public"."stocks"("id") ON DELETE cascade ON UPDATE no action`,
  );
  await tryStmt(
    'FK news_chunks_event_id',
    `ALTER TABLE "news_chunks" ADD CONSTRAINT "news_chunks_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE set null ON UPDATE no action`,
  );
  await tryStmt(
    'FK prices_daily_stock_id',
    `ALTER TABLE "prices_daily" ADD CONSTRAINT "prices_daily_stock_id_stocks_id_fk" FOREIGN KEY ("stock_id") REFERENCES "public"."stocks"("id") ON DELETE cascade ON UPDATE no action`,
  );
  await tryStmt(
    'FK prices_intraday_stock_id',
    `ALTER TABLE "prices_intraday" ADD CONSTRAINT "prices_intraday_stock_id_stocks_id_fk" FOREIGN KEY ("stock_id") REFERENCES "public"."stocks"("id") ON DELETE cascade ON UPDATE no action`,
  );
  await tryStmt(
    'FK research_notes_stock_id',
    `ALTER TABLE "research_notes" ADD CONSTRAINT "research_notes_stock_id_stocks_id_fk" FOREIGN KEY ("stock_id") REFERENCES "public"."stocks"("id") ON DELETE cascade ON UPDATE no action`,
  );
  await tryStmt(
    'FK research_tasks_stock_id',
    `ALTER TABLE "research_tasks" ADD CONSTRAINT "research_tasks_stock_id_stocks_id_fk" FOREIGN KEY ("stock_id") REFERENCES "public"."stocks"("id") ON DELETE cascade ON UPDATE no action`,
  );
  await tryStmt(
    'FK routine_runs_routine_id',
    `ALTER TABLE "routine_runs" ADD CONSTRAINT "routine_runs_routine_id_routines_id_fk" FOREIGN KEY ("routine_id") REFERENCES "public"."routines"("id") ON DELETE cascade ON UPDATE no action`,
  );
  await tryStmt(
    'FK stocks_portfolio_id',
    `ALTER TABLE "stocks" ADD CONSTRAINT "stocks_portfolio_id_portfolios_id_fk" FOREIGN KEY ("portfolio_id") REFERENCES "public"."portfolios"("id") ON DELETE cascade ON UPDATE no action`,
  );

  // 1d. Indexes from the initial Drizzle migration.
  //     api_keys_provider_uq is the *legacy* single-key-per-provider
  //     index; the per-user bump below drops it and replaces it with
  //     api_keys_user_provider_uq. We still create it here so fresh DBs
  //     have something to drop on the next pass — and so existing DBs
  //     that already moved past this stage don't get a different shape.
  await db.execute(sql`CREATE UNIQUE INDEX IF NOT EXISTS "api_keys_provider_uq" ON "api_keys" USING btree ("provider")`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS "business_context_chunks_stock_idx" ON "business_context_chunks" USING btree ("stock_id")`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS "chat_messages_chat_idx" ON "chat_messages" USING btree ("chat_id","created_at")`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS "events_stock_date_idx" ON "events" USING btree ("stock_id","event_date")`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS "fundamentals_stock_metric_idx" ON "fundamentals" USING btree ("stock_id","metric","period")`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS "future_events_stock_date_idx" ON "future_events" USING btree ("stock_id","expected_date")`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS "news_chunks_stock_pub_idx" ON "news_chunks" USING btree ("stock_id","published_at")`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS "outbound_audit_ts_idx" ON "outbound_audit" USING btree ("ts")`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS "research_notes_stock_idx" ON "research_notes" USING btree ("stock_id")`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS "research_tasks_stock_status_idx" ON "research_tasks" USING btree ("stock_id","status")`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS "routine_runs_routine_idx" ON "routine_runs" USING btree ("routine_id","started_at")`);
  await db.execute(sql`CREATE UNIQUE INDEX IF NOT EXISTS "stocks_symbol_exchange_uq" ON "stocks" USING btree ("symbol","exchange")`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS "stocks_portfolio_idx" ON "stocks" USING btree ("portfolio_id")`);

  // ---------------------------------------------------------------------
  // 2. HNSW indexes for pgvector. Drizzle doesn't emit these. One partial
  //    index per (table × embedding dim) so each row's NULL columns don't
  //    cost a "vector must have N dimensions" error. Wrapped in tryStmt
  //    because they require the `vector` extension to be present.
  // ---------------------------------------------------------------------
  await tryStmt(
    'HNSW news_chunks 1536',
    `CREATE INDEX IF NOT EXISTS news_chunks_embedding_1536_hnsw ON news_chunks USING hnsw (embedding_1536 vector_cosine_ops) WHERE embedding_1536 IS NOT NULL`,
  );
  await tryStmt(
    'HNSW news_chunks 768',
    `CREATE INDEX IF NOT EXISTS news_chunks_embedding_768_hnsw ON news_chunks USING hnsw (embedding_768 vector_cosine_ops) WHERE embedding_768 IS NOT NULL`,
  );
  await tryStmt(
    'HNSW news_chunks 1024',
    `CREATE INDEX IF NOT EXISTS news_chunks_embedding_1024_hnsw ON news_chunks USING hnsw (embedding_1024 vector_cosine_ops) WHERE embedding_1024 IS NOT NULL`,
  );
  await tryStmt(
    'HNSW research_notes 1536',
    `CREATE INDEX IF NOT EXISTS research_notes_embedding_1536_hnsw ON research_notes USING hnsw (embedding_1536 vector_cosine_ops) WHERE embedding_1536 IS NOT NULL`,
  );
  await tryStmt(
    'HNSW research_notes 768',
    `CREATE INDEX IF NOT EXISTS research_notes_embedding_768_hnsw ON research_notes USING hnsw (embedding_768 vector_cosine_ops) WHERE embedding_768 IS NOT NULL`,
  );
  await tryStmt(
    'HNSW research_notes 1024',
    `CREATE INDEX IF NOT EXISTS research_notes_embedding_1024_hnsw ON research_notes USING hnsw (embedding_1024 vector_cosine_ops) WHERE embedding_1024 IS NOT NULL`,
  );
  await tryStmt(
    'HNSW business_context_chunks 1536',
    `CREATE INDEX IF NOT EXISTS business_context_chunks_embedding_1536_hnsw ON business_context_chunks USING hnsw (embedding_1536 vector_cosine_ops) WHERE embedding_1536 IS NOT NULL`,
  );
  await tryStmt(
    'HNSW business_context_chunks 768',
    `CREATE INDEX IF NOT EXISTS business_context_chunks_embedding_768_hnsw ON business_context_chunks USING hnsw (embedding_768 vector_cosine_ops) WHERE embedding_768 IS NOT NULL`,
  );
  await tryStmt(
    'HNSW business_context_chunks 1024',
    `CREATE INDEX IF NOT EXISTS business_context_chunks_embedding_1024_hnsw ON business_context_chunks USING hnsw (embedding_1024 vector_cosine_ops) WHERE embedding_1024 IS NOT NULL`,
  );

  // ---------------------------------------------------------------------
  // 3. Post-init schema bumps. These started life in migrate.ts as
  //    ad-hoc adds after the Drizzle snapshot. Keeping them as separate
  //    statements here means a half-bumped DB (e.g. one that ran the
  //    initial migration but never the chat_messages.parts bump) heals
  //    on the next request.
  // ---------------------------------------------------------------------

  // Add `parts jsonb` to chat_messages (post-init schema bump).
  await db.execute(sql`ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS parts jsonb`);

  // Auth schema (users + per-user caps + token usage rollup).
  await db.execute(sql`CREATE TABLE IF NOT EXISTS users (
    id serial PRIMARY KEY,
    username text NOT NULL,
    password_hash text NOT NULL,
    is_admin boolean NOT NULL DEFAULT false,
    created_at timestamptz NOT NULL DEFAULT now()
  )`);
  await db.execute(sql`CREATE UNIQUE INDEX IF NOT EXISTS users_username_uq ON users (username)`);

  // Per-user ownership on portfolios + api_keys (multi-tenant).
  await db.execute(sql`ALTER TABLE portfolios ADD COLUMN IF NOT EXISTS user_id integer REFERENCES users(id) ON DELETE CASCADE`);
  await db.execute(sql`ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS user_id integer REFERENCES users(id) ON DELETE CASCADE`);
  // Drop the legacy single-key-per-provider unique and re-key on (user_id, provider).
  await db.execute(sql`DROP INDEX IF EXISTS api_keys_provider_uq`);
  await db.execute(sql`CREATE UNIQUE INDEX IF NOT EXISTS api_keys_user_provider_uq ON api_keys (user_id, provider)`);

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

  // chat_summaries — added after the initial schema snapshot.
  await db.execute(sql`CREATE TABLE IF NOT EXISTS chat_summaries (
    id serial PRIMARY KEY,
    chat_id integer NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
    summary_md text NOT NULL,
    model text,
    tokens_in integer,
    tokens_out integer,
    cost_usd numeric(10,6),
    created_at timestamptz NOT NULL DEFAULT now()
  )`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS chat_summaries_chat_idx
            ON chat_summaries (chat_id, created_at)`);

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
  // Both wrapped in tryStmt so a transient lock contention (e.g. a
  // long-running query holding stocks open) doesn't abort the whole bump
  // — we just log and move on, and the next ensureSchema() call retries.
  // Used to wrap each in a per-statement transaction with SET LOCAL
  // lock_timeout/statement_timeout, but neon-http doesn't support
  // transactions; the Neon pooler's server-side query timeout takes the
  // role of the previous lock_timeout safety net.
  await tryStmt(
    'DROP stocks_symbol_exchange_uq',
    'DROP INDEX IF EXISTS stocks_symbol_exchange_uq',
  );
  await tryStmt(
    'CREATE stocks_portfolio_symbol_exchange_uq',
    'CREATE UNIQUE INDEX IF NOT EXISTS stocks_portfolio_symbol_exchange_uq ON stocks (portfolio_id, symbol, exchange)',
  );

  // Per-user ownership on routines (multi-tenant). Nullable so existing rows
  // created before this fix survive — the route layer treats NULL user_id as
  // "orphan, do not list to anyone". Every NEW insert MUST set user_id; see
  // app/api/routines/route.ts and lib/mcp/tools/createRoutine.ts. The
  // Vercel-Cron-driven runDueRoutines path is privileged and ignores user_id
  // by design (the cron is the system, not a user).
  await tryStmt(
    'ADD routines.user_id',
    'ALTER TABLE routines ADD COLUMN IF NOT EXISTS user_id integer REFERENCES users(id) ON DELETE CASCADE',
  );
  await tryStmt(
    'CREATE routines_user_idx',
    'CREATE INDEX IF NOT EXISTS routines_user_idx ON routines(user_id)',
  );
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

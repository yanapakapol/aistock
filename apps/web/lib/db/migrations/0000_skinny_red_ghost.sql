CREATE TYPE "public"."date_precision" AS ENUM('day', 'week', 'month');--> statement-breakpoint
CREATE TYPE "public"."message_role" AS ENUM('user', 'assistant', 'system', 'tool');--> statement-breakpoint
CREATE TYPE "public"."research_status" AS ENUM('todo', 'researching', 'done', 'failed');--> statement-breakpoint
CREATE TYPE "public"."routine_status" AS ENUM('pending', 'running', 'completed', 'failed', 'skipped');--> statement-breakpoint
CREATE TYPE "public"."sentiment_label" AS ENUM('bull', 'bear', 'neutral');--> statement-breakpoint
CREATE TYPE "public"."session_relative" AS ENUM('pre', 'intraday', 'post', 'overnight');--> statement-breakpoint
CREATE TYPE "public"."tab" AS ENUM('research', 'analysis');--> statement-breakpoint
CREATE TABLE "api_keys" (
	"id" serial PRIMARY KEY NOT NULL,
	"provider" text NOT NULL,
	"kid" integer DEFAULT 1 NOT NULL,
	"ciphertext" "bytea" NOT NULL,
	"nonce" "bytea" NOT NULL,
	"tag" "bytea" NOT NULL,
	"wrapped_dek" "bytea" NOT NULL,
	"dek_nonce" "bytea" NOT NULL,
	"dek_tag" "bytea" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "budget_ledger" (
	"day" date NOT NULL,
	"provider" text NOT NULL,
	"usd_spent" numeric(10, 4) DEFAULT '0' NOT NULL,
	CONSTRAINT "budget_ledger_day_provider_pk" PRIMARY KEY("day","provider")
);
--> statement-breakpoint
CREATE TABLE "business_context" (
	"id" serial PRIMARY KEY NOT NULL,
	"stock_id" integer NOT NULL,
	"summary_md" text DEFAULT '' NOT NULL,
	"timeline_md" text DEFAULT '' NOT NULL,
	"future_outlook_md" text DEFAULT '' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "business_context_stock_id_unique" UNIQUE("stock_id")
);
--> statement-breakpoint
CREATE TABLE "business_context_chunks" (
	"id" serial PRIMARY KEY NOT NULL,
	"stock_id" integer NOT NULL,
	"section" text NOT NULL,
	"chunk_text" text NOT NULL,
	"embedding_1536" vector(1536),
	"embedding_768" vector(768),
	"embedding_1024" vector(1024),
	"embedding_model" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "chat_messages" (
	"id" serial PRIMARY KEY NOT NULL,
	"chat_id" integer NOT NULL,
	"role" "message_role" NOT NULL,
	"content_md" text NOT NULL,
	"tool_calls" jsonb,
	"tokens_in" integer,
	"tokens_out" integer,
	"cost_usd" numeric(10, 6),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "chats" (
	"id" serial PRIMARY KEY NOT NULL,
	"tab" "tab" NOT NULL,
	"stock_id" integer,
	"model" text NOT NULL,
	"session_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "events" (
	"id" serial PRIMARY KEY NOT NULL,
	"stock_id" integer NOT NULL,
	"event_date" date NOT NULL,
	"event_ts" timestamp with time zone,
	"event_tz" text,
	"date_precision" date_precision DEFAULT 'day' NOT NULL,
	"session_relative" "session_relative",
	"title" text NOT NULL,
	"summary_md" text NOT NULL,
	"source_url" text NOT NULL,
	"source_title" text,
	"sentiment_score" numeric(3, 2),
	"sentiment_label" "sentiment_label",
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "fundamentals" (
	"id" serial PRIMARY KEY NOT NULL,
	"stock_id" integer NOT NULL,
	"period" text NOT NULL,
	"metric" text NOT NULL,
	"value" numeric(24, 6) NOT NULL,
	"source" text NOT NULL,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "future_events" (
	"id" serial PRIMARY KEY NOT NULL,
	"stock_id" integer NOT NULL,
	"expected_date" date NOT NULL,
	"date_precision" date_precision DEFAULT 'day' NOT NULL,
	"title" text NOT NULL,
	"description_md" text NOT NULL,
	"probability_positive" numeric(4, 3),
	"probability_negative" numeric(4, 3),
	"expected_impact_pct" numeric(6, 3),
	"source_urls" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "models_cache" (
	"provider" text NOT NULL,
	"model_id" text NOT NULL,
	"payload" jsonb NOT NULL,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "models_cache_provider_model_id_pk" PRIMARY KEY("provider","model_id")
);
--> statement-breakpoint
CREATE TABLE "news_chunks" (
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
);
--> statement-breakpoint
CREATE TABLE "outbound_audit" (
	"id" serial PRIMARY KEY NOT NULL,
	"ts" timestamp with time zone DEFAULT now() NOT NULL,
	"kind" text NOT NULL,
	"host" text NOT NULL,
	"status" integer,
	"latency_ms" integer,
	"tokens" integer,
	"usd" numeric(10, 6)
);
--> statement-breakpoint
CREATE TABLE "portfolios" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "prices_daily" (
	"stock_id" integer NOT NULL,
	"date" date NOT NULL,
	"open" numeric(18, 6) NOT NULL,
	"high" numeric(18, 6) NOT NULL,
	"low" numeric(18, 6) NOT NULL,
	"close" numeric(18, 6) NOT NULL,
	"volume" bigint NOT NULL,
	"source" text NOT NULL,
	CONSTRAINT "prices_daily_stock_id_date_pk" PRIMARY KEY("stock_id","date")
);
--> statement-breakpoint
CREATE TABLE "prices_intraday" (
	"stock_id" integer NOT NULL,
	"ts" timestamp with time zone NOT NULL,
	"interval" text NOT NULL,
	"ohlcv" jsonb NOT NULL,
	"source" text NOT NULL,
	CONSTRAINT "prices_intraday_stock_id_ts_interval_pk" PRIMARY KEY("stock_id","ts","interval")
);
--> statement-breakpoint
CREATE TABLE "push_subscriptions" (
	"id" serial PRIMARY KEY NOT NULL,
	"endpoint" text NOT NULL,
	"p256dh" text NOT NULL,
	"auth" text NOT NULL,
	"user_agent" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_sent_at" timestamp with time zone,
	"disabled_at" timestamp with time zone,
	CONSTRAINT "push_subscriptions_endpoint_unique" UNIQUE("endpoint")
);
--> statement-breakpoint
CREATE TABLE "research_notes" (
	"id" serial PRIMARY KEY NOT NULL,
	"stock_id" integer NOT NULL,
	"kind" text NOT NULL,
	"chunk_text" text NOT NULL,
	"embedding_1536" vector(1536),
	"embedding_768" vector(768),
	"embedding_1024" vector(1024),
	"embedding_model" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "research_tasks" (
	"id" serial PRIMARY KEY NOT NULL,
	"stock_id" integer NOT NULL,
	"driver" text NOT NULL,
	"status" "research_status" DEFAULT 'todo' NOT NULL,
	"notes_md" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "routine_runs" (
	"id" serial PRIMARY KEY NOT NULL,
	"routine_id" integer NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"status" "routine_status" DEFAULT 'pending' NOT NULL,
	"output_md" text,
	"export_path" text,
	"usd_spent" numeric(8, 4)
);
--> statement-breakpoint
CREATE TABLE "routines" (
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
);
--> statement-breakpoint
CREATE TABLE "stocks" (
	"id" serial PRIMARY KEY NOT NULL,
	"portfolio_id" integer,
	"symbol" text NOT NULL,
	"exchange" text NOT NULL,
	"mic" text,
	"name" text NOT NULL,
	"currency" text,
	"added_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "business_context" ADD CONSTRAINT "business_context_stock_id_stocks_id_fk" FOREIGN KEY ("stock_id") REFERENCES "public"."stocks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "business_context_chunks" ADD CONSTRAINT "business_context_chunks_stock_id_stocks_id_fk" FOREIGN KEY ("stock_id") REFERENCES "public"."stocks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_messages" ADD CONSTRAINT "chat_messages_chat_id_chats_id_fk" FOREIGN KEY ("chat_id") REFERENCES "public"."chats"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chats" ADD CONSTRAINT "chats_stock_id_stocks_id_fk" FOREIGN KEY ("stock_id") REFERENCES "public"."stocks"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_stock_id_stocks_id_fk" FOREIGN KEY ("stock_id") REFERENCES "public"."stocks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fundamentals" ADD CONSTRAINT "fundamentals_stock_id_stocks_id_fk" FOREIGN KEY ("stock_id") REFERENCES "public"."stocks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "future_events" ADD CONSTRAINT "future_events_stock_id_stocks_id_fk" FOREIGN KEY ("stock_id") REFERENCES "public"."stocks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "news_chunks" ADD CONSTRAINT "news_chunks_stock_id_stocks_id_fk" FOREIGN KEY ("stock_id") REFERENCES "public"."stocks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "news_chunks" ADD CONSTRAINT "news_chunks_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prices_daily" ADD CONSTRAINT "prices_daily_stock_id_stocks_id_fk" FOREIGN KEY ("stock_id") REFERENCES "public"."stocks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prices_intraday" ADD CONSTRAINT "prices_intraday_stock_id_stocks_id_fk" FOREIGN KEY ("stock_id") REFERENCES "public"."stocks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "research_notes" ADD CONSTRAINT "research_notes_stock_id_stocks_id_fk" FOREIGN KEY ("stock_id") REFERENCES "public"."stocks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "research_tasks" ADD CONSTRAINT "research_tasks_stock_id_stocks_id_fk" FOREIGN KEY ("stock_id") REFERENCES "public"."stocks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "routine_runs" ADD CONSTRAINT "routine_runs_routine_id_routines_id_fk" FOREIGN KEY ("routine_id") REFERENCES "public"."routines"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stocks" ADD CONSTRAINT "stocks_portfolio_id_portfolios_id_fk" FOREIGN KEY ("portfolio_id") REFERENCES "public"."portfolios"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "api_keys_provider_uq" ON "api_keys" USING btree ("provider");--> statement-breakpoint
CREATE INDEX "business_context_chunks_stock_idx" ON "business_context_chunks" USING btree ("stock_id");--> statement-breakpoint
CREATE INDEX "chat_messages_chat_idx" ON "chat_messages" USING btree ("chat_id","created_at");--> statement-breakpoint
CREATE INDEX "events_stock_date_idx" ON "events" USING btree ("stock_id","event_date");--> statement-breakpoint
CREATE INDEX "fundamentals_stock_metric_idx" ON "fundamentals" USING btree ("stock_id","metric","period");--> statement-breakpoint
CREATE INDEX "future_events_stock_date_idx" ON "future_events" USING btree ("stock_id","expected_date");--> statement-breakpoint
CREATE INDEX "news_chunks_stock_pub_idx" ON "news_chunks" USING btree ("stock_id","published_at");--> statement-breakpoint
CREATE INDEX "outbound_audit_ts_idx" ON "outbound_audit" USING btree ("ts");--> statement-breakpoint
CREATE INDEX "research_notes_stock_idx" ON "research_notes" USING btree ("stock_id");--> statement-breakpoint
CREATE INDEX "research_tasks_stock_status_idx" ON "research_tasks" USING btree ("stock_id","status");--> statement-breakpoint
CREATE INDEX "routine_runs_routine_idx" ON "routine_runs" USING btree ("routine_id","started_at");--> statement-breakpoint
CREATE UNIQUE INDEX "stocks_symbol_exchange_uq" ON "stocks" USING btree ("symbol","exchange");--> statement-breakpoint
CREATE INDEX "stocks_portfolio_idx" ON "stocks" USING btree ("portfolio_id");
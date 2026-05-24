import {
  pgTable,
  pgEnum,
  serial,
  text,
  integer,
  bigint,
  boolean,
  timestamp,
  date,
  numeric,
  jsonb,
  customType,
  uniqueIndex,
  index,
  primaryKey,
} from 'drizzle-orm/pg-core';

// ---------- Custom types ----------

const bytea = customType<{ data: Buffer; notNull: false; default: false }>({
  dataType() {
    return 'bytea';
  },
});

// pgvector — dim chosen at first write per collection; stored as text per row's `embedding_model`.
// We model the column generically; HNSW indexes are created in the migration SQL.
const vector = (name: string, dimensions: number) =>
  customType<{ data: number[]; driverData: string }>({
    dataType() {
      return `vector(${dimensions})`;
    },
    toDriver(v) {
      return `[${v.join(',')}]`;
    },
    fromDriver(v) {
      // pgvector returns '[1,2,3]' as text
      return JSON.parse(v as string) as number[];
    },
  })(name);

// ---------- Enums ----------

export const tabEnum = pgEnum('tab', ['research', 'analysis']);
export const datePrecisionEnum = pgEnum('date_precision', ['day', 'week', 'month']);
export const sessionRelativeEnum = pgEnum('session_relative', [
  'pre',
  'intraday',
  'post',
  'overnight',
]);
export const sentimentLabelEnum = pgEnum('sentiment_label', ['bull', 'bear', 'neutral']);
export const researchStatusEnum = pgEnum('research_status', [
  'todo',
  'researching',
  'done',
  'failed',
]);
export const routineStatusEnum = pgEnum('routine_status', [
  'pending',
  'running',
  'completed',
  'failed',
  'skipped',
]);
export const messageRoleEnum = pgEnum('message_role', ['user', 'assistant', 'system', 'tool']);

// ---------- Auth / users ----------

export const users = pgTable(
  'users',
  {
    id: serial('id').primaryKey(),
    username: text('username').notNull(),
    passwordHash: text('password_hash').notNull(),
    isAdmin: boolean('is_admin').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    byUsername: uniqueIndex('users_username_uq').on(t.username),
  }),
);

// ---------- Portfolio ----------

export const portfolios = pgTable('portfolios', {
  id: serial('id').primaryKey(),
  // user_id is added via migrate.ts ALTER TABLE for backward-compat (existing
  // rows get owned by the first user). New deployments enforce NOT NULL via FK.
  userId: integer('user_id').references(() => users.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});

export const stocks = pgTable(
  'stocks',
  {
    id: serial('id').primaryKey(),
    portfolioId: integer('portfolio_id').references(() => portfolios.id, { onDelete: 'cascade' }),
    symbol: text('symbol').notNull(),
    exchange: text('exchange').notNull(),
    mic: text('mic'),
    name: text('name').notNull(),
    currency: text('currency'),
    addedAt: timestamp('added_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    bySymbolExchange: uniqueIndex('stocks_symbol_exchange_uq').on(t.symbol, t.exchange),
    byPortfolio: index('stocks_portfolio_idx').on(t.portfolioId),
  }),
);

// ---------- Business context (one row per stock, overwritten on research close) ----------

export const businessContext = pgTable('business_context', {
  id: serial('id').primaryKey(),
  stockId: integer('stock_id')
    .notNull()
    .unique()
    .references(() => stocks.id, { onDelete: 'cascade' }),
  summaryMd: text('summary_md').notNull().default(''),
  timelineMd: text('timeline_md').notNull().default(''),
  futureOutlookMd: text('future_outlook_md').notNull().default(''),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});

// ---------- Events (past) ----------

export const events = pgTable(
  'events',
  {
    id: serial('id').primaryKey(),
    stockId: integer('stock_id')
      .notNull()
      .references(() => stocks.id, { onDelete: 'cascade' }),
    eventDate: date('event_date').notNull(),
    eventTs: timestamp('event_ts', { withTimezone: true }),
    eventTz: text('event_tz'),
    datePrecision: datePrecisionEnum('date_precision').notNull().default('day'),
    sessionRelative: sessionRelativeEnum('session_relative'),
    title: text('title').notNull(),
    summaryMd: text('summary_md').notNull(),
    sourceUrl: text('source_url').notNull(),
    sourceTitle: text('source_title'),
    sentimentScore: numeric('sentiment_score', { precision: 3, scale: 2 }),
    sentimentLabel: sentimentLabelEnum('sentiment_label'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    byStockDate: index('events_stock_date_idx').on(t.stockId, t.eventDate),
  }),
);

// ---------- Future events ----------

export const futureEvents = pgTable(
  'future_events',
  {
    id: serial('id').primaryKey(),
    stockId: integer('stock_id')
      .notNull()
      .references(() => stocks.id, { onDelete: 'cascade' }),
    expectedDate: date('expected_date').notNull(),
    datePrecision: datePrecisionEnum('date_precision').notNull().default('day'),
    title: text('title').notNull(),
    descriptionMd: text('description_md').notNull(),
    probabilityPositive: numeric('probability_positive', { precision: 4, scale: 3 }),
    probabilityNegative: numeric('probability_negative', { precision: 4, scale: 3 }),
    expectedImpactPct: numeric('expected_impact_pct', { precision: 6, scale: 3 }),
    sourceUrls: jsonb('source_urls').$type<string[]>().default([]).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    byStockDate: index('future_events_stock_date_idx').on(t.stockId, t.expectedDate),
  }),
);

// ---------- Prices ----------

export const pricesDaily = pgTable(
  'prices_daily',
  {
    stockId: integer('stock_id')
      .notNull()
      .references(() => stocks.id, { onDelete: 'cascade' }),
    date: date('date').notNull(),
    open: numeric('open', { precision: 18, scale: 6 }).notNull(),
    high: numeric('high', { precision: 18, scale: 6 }).notNull(),
    low: numeric('low', { precision: 18, scale: 6 }).notNull(),
    close: numeric('close', { precision: 18, scale: 6 }).notNull(),
    volume: bigint('volume', { mode: 'bigint' }).notNull(),
    source: text('source').notNull(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.stockId, t.date] }),
  }),
);

export const pricesIntraday = pgTable(
  'prices_intraday',
  {
    stockId: integer('stock_id')
      .notNull()
      .references(() => stocks.id, { onDelete: 'cascade' }),
    ts: timestamp('ts', { withTimezone: true }).notNull(),
    interval: text('interval').notNull(),
    ohlcv: jsonb('ohlcv').notNull(),
    source: text('source').notNull(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.stockId, t.ts, t.interval] }),
  }),
);

// ---------- Fundamentals ----------

export const fundamentals = pgTable(
  'fundamentals',
  {
    id: serial('id').primaryKey(),
    stockId: integer('stock_id')
      .notNull()
      .references(() => stocks.id, { onDelete: 'cascade' }),
    period: text('period').notNull(),
    metric: text('metric').notNull(),
    value: numeric('value', { precision: 24, scale: 6 }).notNull(),
    source: text('source').notNull(),
    fetchedAt: timestamp('fetched_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    byStockMetric: index('fundamentals_stock_metric_idx').on(t.stockId, t.metric, t.period),
  }),
);

// ---------- Research tasks ----------

export const researchTasks = pgTable(
  'research_tasks',
  {
    id: serial('id').primaryKey(),
    stockId: integer('stock_id')
      .notNull()
      .references(() => stocks.id, { onDelete: 'cascade' }),
    driver: text('driver').notNull(),
    status: researchStatusEnum('status').notNull().default('todo'),
    notesMd: text('notes_md'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    byStockStatus: index('research_tasks_stock_status_idx').on(t.stockId, t.status),
  }),
);

// ---------- Chats ----------

export const chats = pgTable('chats', {
  id: serial('id').primaryKey(),
  tab: tabEnum('tab').notNull(),
  stockId: integer('stock_id').references(() => stocks.id, { onDelete: 'set null' }),
  model: text('model').notNull(),
  sessionId: text('session_id'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});

export const chatMessages = pgTable(
  'chat_messages',
  {
    id: serial('id').primaryKey(),
    chatId: integer('chat_id')
      .notNull()
      .references(() => chats.id, { onDelete: 'cascade' }),
    role: messageRoleEnum('role').notNull(),
    contentMd: text('content_md').notNull(),
    toolCalls: jsonb('tool_calls'),
    // Full UIMessage `parts` array (text + tool-call + tool-result + reasoning…).
    // Lets history reload reconstruct the message exactly as it streamed.
    parts: jsonb('parts'),
    tokensIn: integer('tokens_in'),
    tokensOut: integer('tokens_out'),
    costUsd: numeric('cost_usd', { precision: 10, scale: 6 }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    byChat: index('chat_messages_chat_idx').on(t.chatId, t.createdAt),
  }),
);

// ---------- Chat summaries (separate from raw history) ----------

export const chatSummaries = pgTable(
  'chat_summaries',
  {
    id: serial('id').primaryKey(),
    chatId: integer('chat_id')
      .notNull()
      .references(() => chats.id, { onDelete: 'cascade' }),
    summaryMd: text('summary_md').notNull(),
    model: text('model'),
    tokensIn: integer('tokens_in'),
    tokensOut: integer('tokens_out'),
    costUsd: numeric('cost_usd', { precision: 10, scale: 6 }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    byChat: index('chat_summaries_chat_idx').on(t.chatId, t.createdAt),
  }),
);

// ---------- Routines ----------

export const routines = pgTable('routines', {
  id: serial('id').primaryKey(),
  name: text('name').notNull(),
  prompt: text('prompt').notNull(),
  tab: tabEnum('tab').notNull(),
  model: text('model').notNull(),
  fallbackModels: jsonb('fallback_models').$type<string[]>().default([]).notNull(),
  cronExpr: text('cron_expr').notNull(),
  tz: text('tz').notNull().default('Asia/Bangkok'),
  lastRunAt: timestamp('last_run_at', { withTimezone: true }),
  lastRunStatus: routineStatusEnum('last_run_status'),
  enabled: boolean('enabled').notNull().default(true),
  maxUsdPerRun: numeric('max_usd_per_run', { precision: 8, scale: 4 }).notNull().default('1.00'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});

export const routineRuns = pgTable(
  'routine_runs',
  {
    id: serial('id').primaryKey(),
    routineId: integer('routine_id')
      .notNull()
      .references(() => routines.id, { onDelete: 'cascade' }),
    startedAt: timestamp('started_at', { withTimezone: true }).defaultNow().notNull(),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    status: routineStatusEnum('status').notNull().default('pending'),
    outputMd: text('output_md'),
    exportPath: text('export_path'),
    usdSpent: numeric('usd_spent', { precision: 8, scale: 4 }),
  },
  (t) => ({
    byRoutine: index('routine_runs_routine_idx').on(t.routineId, t.startedAt),
  }),
);

// ---------- API keys (envelope-encrypted) ----------

export const apiKeys = pgTable(
  'api_keys',
  {
    id: serial('id').primaryKey(),
    userId: integer('user_id').references(() => users.id, { onDelete: 'cascade' }),
    provider: text('provider').notNull(),
    kid: integer('kid').notNull().default(1),
    ciphertext: bytea('ciphertext').notNull(),
    nonce: bytea('nonce').notNull(),
    tag: bytea('tag').notNull(),
    wrappedDek: bytea('wrapped_dek').notNull(),
    dekNonce: bytea('dek_nonce').notNull(),
    dekTag: bytea('dek_tag').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
  },
  (t) => ({
    byUserProvider: uniqueIndex('api_keys_user_provider_uq').on(t.userId, t.provider),
  }),
);

// ---------- Audit & budget ----------

export const outboundAudit = pgTable(
  'outbound_audit',
  {
    id: serial('id').primaryKey(),
    ts: timestamp('ts', { withTimezone: true }).defaultNow().notNull(),
    kind: text('kind').notNull(),
    host: text('host').notNull(),
    status: integer('status'),
    latencyMs: integer('latency_ms'),
    tokens: integer('tokens'),
    usd: numeric('usd', { precision: 10, scale: 6 }),
  },
  (t) => ({
    byTs: index('outbound_audit_ts_idx').on(t.ts),
  }),
);

export const budgetLedger = pgTable(
  'budget_ledger',
  {
    day: date('day').notNull(),
    provider: text('provider').notNull(),
    usdSpent: numeric('usd_spent', { precision: 10, scale: 4 }).notNull().default('0'),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.day, t.provider] }),
  }),
);

// ---------- Models cache ----------

export const modelsCache = pgTable(
  'models_cache',
  {
    provider: text('provider').notNull(),
    modelId: text('model_id').notNull(),
    payload: jsonb('payload').notNull(),
    fetchedAt: timestamp('fetched_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.provider, t.modelId] }),
  }),
);

// ---------- Vector tables (pgvector) ----------
//
// Embedding dimension is pinned per-collection at first write via the `embedding_model`
// column. The DDL declares vector(1536) (OpenAI text-embedding-3-small default); if the
// user picks a different embedding model with a different dimension, we ALTER the column
// at first write or refuse insert with a clear error. See lib/rag/embeddings.ts.

// Multi-dimension embedding columns (Option A from M4-1 report).
// Each row uses exactly one of the three columns; the other two stay NULL.
// `embedding_model` records which producer wrote the vector so retrieval can
// route queries to the matching column.

export const newsChunks = pgTable(
  'news_chunks',
  {
    id: serial('id').primaryKey(),
    stockId: integer('stock_id')
      .notNull()
      .references(() => stocks.id, { onDelete: 'cascade' }),
    eventId: integer('event_id').references(() => events.id, { onDelete: 'set null' }),
    sourceUrl: text('source_url').notNull(),
    publishedAt: timestamp('published_at', { withTimezone: true }),
    chunkText: text('chunk_text').notNull(),
    embedding1536: vector('embedding_1536', 1536),
    embedding768: vector('embedding_768', 768),
    embedding1024: vector('embedding_1024', 1024),
    embeddingModel: text('embedding_model').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    byStockPub: index('news_chunks_stock_pub_idx').on(t.stockId, t.publishedAt),
  }),
);

export const researchNotes = pgTable(
  'research_notes',
  {
    id: serial('id').primaryKey(),
    stockId: integer('stock_id')
      .notNull()
      .references(() => stocks.id, { onDelete: 'cascade' }),
    kind: text('kind').notNull(),
    chunkText: text('chunk_text').notNull(),
    embedding1536: vector('embedding_1536', 1536),
    embedding768: vector('embedding_768', 768),
    embedding1024: vector('embedding_1024', 1024),
    embeddingModel: text('embedding_model').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    byStock: index('research_notes_stock_idx').on(t.stockId),
  }),
);

export const businessContextChunks = pgTable(
  'business_context_chunks',
  {
    id: serial('id').primaryKey(),
    stockId: integer('stock_id')
      .notNull()
      .references(() => stocks.id, { onDelete: 'cascade' }),
    section: text('section').notNull(),
    chunkText: text('chunk_text').notNull(),
    embedding1536: vector('embedding_1536', 1536),
    embedding768: vector('embedding_768', 768),
    embedding1024: vector('embedding_1024', 1024),
    embeddingModel: text('embedding_model').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    byStock: index('business_context_chunks_stock_idx').on(t.stockId),
  }),
);

// ---------- Web Push subscriptions ----------

export const pushSubscriptions = pgTable('push_subscriptions', {
  id: serial('id').primaryKey(),
  endpoint: text('endpoint').notNull().unique(),
  p256dh: text('p256dh').notNull(),
  auth: text('auth').notNull(),
  userAgent: text('user_agent'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  lastSentAt: timestamp('last_sent_at', { withTimezone: true }),
  // Set when web-push returns 410 Gone (subscription revoked); soft-disabled rows
  // are kept for audit but skipped by the sender.
  disabledAt: timestamp('disabled_at', { withTimezone: true }),
});

// ---------- Provider constants (shared by other modules) ----------
//
// `api_keys.provider` stays an unconstrained text column so LLM and news
// providers can coexist without DDL churn. These constants give TypeScript
// callers a typed surface for the news-side providers specifically.

export const NEWS_PROVIDERS = ['tavily', 'exa', 'finnhub', 'eodhd'] as const;
export type NewsProvider = (typeof NEWS_PROVIDERS)[number];

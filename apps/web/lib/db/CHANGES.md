# Schema changes — this revision

Owner: schema agent. Scope: `apps/web/lib/db/schema.ts` + `apps/web/lib/db/migrate.ts`.

## 1. New table: `push_subscriptions`

For the Web Push backend. Columns: `id serial PK`, `endpoint text UNIQUE NOT NULL`,
`p256dh text NOT NULL`, `auth text NOT NULL`, `user_agent text NULL`,
`created_at timestamptz NOT NULL DEFAULT now()`, `last_sent_at timestamptz NULL`,
`disabled_at timestamptz NULL`. `disabled_at` is set when `web-push.sendNotification`
returns 410 Gone — rows are kept (audit) but skipped by the sender.

Drizzle export: `pushSubscriptions`.

## 2. Multi-dim RAG embeddings (Option A — split columns)

Replaced the single `embedding vector(1536)` column on each of `news_chunks`,
`research_notes`, `business_context_chunks` with three nullable columns:

- `embedding_1536 vector(1536) NULL`
- `embedding_768  vector(768)  NULL`
- `embedding_1024 vector(1024) NULL`

`embedding_model text NOT NULL` stays. Exactly one of the three vector columns
should be populated per row; the writer picks the column by the model's native
dim. Retrieval routes queries to the matching column.

Drizzle field names on each table:
`embedding1536`, `embedding768`, `embedding1024`.

### Migration SQL changes (`migrate.ts`)

- **Dropped** the three old single-column HNSW index creates
  (`*_embedding_hnsw`). The old `embedding` column is gone so they'd error.
- **Added 9** partial HNSW indexes (3 tables x 3 dims), each
  `USING hnsw (<col> vector_cosine_ops) WHERE <col> IS NOT NULL`.
  Partial-WHERE is required so pgvector doesn't trip on NULL rows that
  belong to a different dim.

## 3. `chats.session_id` (new)

`session_id text NULL` added on `chats`, positioned after `model`. Lets the
client stamp a stable UUID independent of the DB autoincrement `id` for
chat-id round-trip work. Nullable so old rows don't need backfill.

## 4. News provider constants

Added at the bottom of `schema.ts`:

```ts
export const NEWS_PROVIDERS = ['tavily', 'exa', 'finnhub', 'eodhd'] as const;
export type NewsProvider = (typeof NEWS_PROVIDERS)[number];
```

`api_keys.provider` stays `text` (no DDL change) — LLM and news providers
share the column with no enum.

## Data survival

Greenfield project; no production data. A fresh `migrate` builds the new
shape cleanly. If anyone has already run the old schema locally, they must
drop + re-migrate (the old `embedding` column is removed).

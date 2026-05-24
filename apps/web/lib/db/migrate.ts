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

  await sql.end();
  // eslint-disable-next-line no-console
  console.log('migrated');
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});

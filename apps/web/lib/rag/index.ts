import 'server-only';
import { sql } from 'drizzle-orm';
import { db } from '@/lib/db/client';
import { chunk } from './chunker';
import { embedBatch, dimColumnFor, type EmbeddingColumn } from './embeddings';

export interface UpsertResult {
  inserted: number;
  model: string;
}

type RagTable = 'news_chunks' | 'research_notes' | 'business_context_chunks';

/**
 * Returns the `embedding_model` pinned to (`tableName`, `stockId`) — i.e. the
 * value on any pre-existing row for that stock — or `null` if the collection
 * is empty. Used by `assertCollectionModel` and by the retriever to pick the
 * right vector column at query time.
 */
async function pinnedModelFor(tableName: RagTable, stockId: number): Promise<string | null> {
  const rows = await db.execute(
    sql`select embedding_model from ${sql.raw(tableName)} where stock_id = ${stockId} limit 1`,
  );
  const first = (rows as unknown as Array<{ embedding_model: string }>)[0];
  return first ? first.embedding_model : null;
}

/**
 * Embeddings are pinned per collection per stock at first write — switching
 * embedding models silently would corrupt vector-space comparisons (and would
 * also land the new vector in a different `embedding_{dim}` column from the
 * existing rows, breaking retrieval). We probe for any pre-existing row's
 * `embedding_model` and bail with a loud error if the caller's chosen model
 * doesn't match.
 *
 * `tableName` is the literal SQL table name (not a Drizzle ref) so we can
 * keep this helper polymorphic across the three vector tables.
 */
async function assertCollectionModel(
  tableName: RagTable,
  stockId: number,
  newModel: string,
): Promise<void> {
  const existing = await pinnedModelFor(tableName, stockId);
  if (existing && existing !== newModel) {
    throw new Error(
      `collection ${tableName}(stock_id=${stockId}) pinned to model ${existing} — got ${newModel}`,
    );
  }
}

function vecLit(v: number[]): string {
  return `[${v.join(',')}]`;
}

export async function upsertNewsChunks(
  stockId: number,
  eventId: number | null,
  sourceUrl: string,
  publishedAt: Date | null,
  fullText: string,
): Promise<UpsertResult> {
  const pieces = chunk(fullText);
  if (pieces.length === 0) {
    return { inserted: 0, model: '' };
  }
  const { vectors, model, dim } = await embedBatch(pieces);
  await assertCollectionModel('news_chunks', stockId, model);
  const col: EmbeddingColumn = dimColumnFor(dim);

  for (let i = 0; i < pieces.length; i++) {
    const v = vecLit(vectors[i]!);
    await db.execute(sql`
      insert into news_chunks
        (stock_id, event_id, source_url, published_at, chunk_text, ${sql.raw(col)}, embedding_model)
      values
        (${stockId}, ${eventId}, ${sourceUrl}, ${publishedAt}, ${pieces[i]!}, ${v}::vector, ${model})
    `);
  }
  return { inserted: pieces.length, model };
}

export async function upsertResearchNotes(
  stockId: number,
  kind: string,
  fullText: string,
): Promise<UpsertResult> {
  const pieces = chunk(fullText);
  if (pieces.length === 0) {
    return { inserted: 0, model: '' };
  }
  const { vectors, model, dim } = await embedBatch(pieces);
  await assertCollectionModel('research_notes', stockId, model);
  const col: EmbeddingColumn = dimColumnFor(dim);

  for (let i = 0; i < pieces.length; i++) {
    const v = vecLit(vectors[i]!);
    await db.execute(sql`
      insert into research_notes
        (stock_id, kind, chunk_text, ${sql.raw(col)}, embedding_model)
      values
        (${stockId}, ${kind}, ${pieces[i]!}, ${v}::vector, ${model})
    `);
  }
  return { inserted: pieces.length, model };
}

export async function upsertBusinessContextChunks(
  stockId: number,
  section: string,
  fullText: string,
): Promise<UpsertResult> {
  const pieces = chunk(fullText);
  if (pieces.length === 0) {
    return { inserted: 0, model: '' };
  }
  const { vectors, model, dim } = await embedBatch(pieces);
  await assertCollectionModel('business_context_chunks', stockId, model);
  const col: EmbeddingColumn = dimColumnFor(dim);

  for (let i = 0; i < pieces.length; i++) {
    const v = vecLit(vectors[i]!);
    await db.execute(sql`
      insert into business_context_chunks
        (stock_id, section, chunk_text, ${sql.raw(col)}, embedding_model)
      values
        (${stockId}, ${section}, ${pieces[i]!}, ${v}::vector, ${model})
    `);
  }
  return { inserted: pieces.length, model };
}

// Re-export helpers for downstream agents.
export { chunk } from './chunker';
export { embedBatch, pickEmbeddingProvider, dimColumnFor } from './embeddings';
export { pinnedModelFor };
export { hybridSearch } from './retriever';
export type { HybridHit, HybridSearchOpts } from './retriever';

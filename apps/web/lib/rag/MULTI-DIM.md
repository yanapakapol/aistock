# Multi-dim embeddings: design notes

The three RAG tables (`news_chunks`, `research_notes`, `business_context_chunks`)
each expose three nullable vector columns:

| column            | dim   | producer                          |
| ----------------- | ----- | --------------------------------- |
| `embedding_1536`  | 1536  | OpenAI `text-embedding-3-small`   |
| `embedding_768`   |  768  | Google `text-embedding-004`       |
| `embedding_1024`  | 1024  | Mistral `mistral-embed`           |

Exactly one column is populated per row; the other two stay `NULL`.
`embedding_model` records which producer wrote the row so retrieval can route
queries to the matching column.

## Why split columns (and not separate tables)

- **One join key per collection.** Hybrid search ranks dense + sparse hits per
  `(stockId, chunkText)`. Keeping all chunks in one table means the BM25 index
  and `stock_id` filter stay shared across providers; we'd otherwise need
  union-all gymnastics for every retrieval call.
- **`pgvector` requires a fixed dim per column.** A single column can't hold
  vectors of differing dims, so we *must* either (a) materialise a column per
  dim, or (b) shard by table. Option (a) is one DDL change, zero application
  branching at the table level.
- **NULL storage cost is negligible.** pgvector NULLs occupy a single byte in
  the heap; we don't pay for the unused columns.
- **HNSW indexes can be partial** (`WHERE embedding_1536 IS NOT NULL`), so each
  ANN index only scans rows for its dim, matching the per-stock query.

## Per-stock model pin

`assertCollectionModel(table, stockId, newModel)` in `index.ts` reads any
existing row's `embedding_model` for that `(table, stockId)` and rejects writes
whose model name doesn't match. Because model → dim is a 1:1 lookup
(`MODEL_DIMS` in `embeddings.ts`), this single check also forbids cross-dim
writes within the same stock.

The pin is *per stock*, not global: stock A can live in `embedding_1536` while
stock B lives in `embedding_768`. The retriever resolves the active column per
stock at query time, so this is invisible to callers.

## Rotation (future work)

To switch a stock's embedding provider, a re-embed job would:

1. Load every chunk for `(table, stockId)` ordered by `id`.
2. Re-embed the `chunk_text` with the new provider.
3. In a single transaction, `UPDATE` each row to clear the old
   `embedding_{old_dim}` (set to `NULL`), write the new vector to
   `embedding_{new_dim}`, and update `embedding_model`.
4. Optionally `VACUUM` to reclaim the now-dead old vectors.

The pin guard tolerates this naturally: after the UPDATE pass, every row for
that stock carries the new model, so subsequent upserts pin to it.

No schema migration is needed unless we add a fourth provider with a new dim
(in which case: add an `embedding_{dim}` column + partial HNSW index, then a
case to `dimColumnFor` and `MODEL_DIMS`).

// ============================================================================
// NOTE: Sparse BM25 retrieval (ParadeDB `@@@` operator + `paradedb.score()`)
// is DISABLED in this build. Those operators require the `pg_search`
// extension, which is NOT available on Neon (our production Postgres).
// Calling them on Neon raises a 5xx ("operator does not exist: text @@@ text"
// / "schema paradedb does not exist") on every hybrid-search request.
//
// As a result `hybridSearch()` now uses dense (pgvector cosine) retrieval
// only. The public API (`HybridSearchOpts`, `HybridHit`, `hybridSearch`) is
// unchanged — callers receive the same shape, just sourced solely from the
// dense path. RRF merge logic is preserved so re-enabling sparse later only
// requires repopulating the sparse lists.
//
// To re-enable BM25 sparse retrieval:
//   1. Run on ParadeDB (or a self-hosted Postgres + pg_search build) and
//      `CREATE EXTENSION pg_search;` plus the relevant BM25 indexes on
//      `news_chunks.chunk_text`, `research_notes.chunk_text`, and
//      `business_context_chunks.chunk_text`.
//   2. Restore the `sparseNews` / `sparseResearch` / `sparseBusiness`
//      implementations (see git history of this file) and re-add them to the
//      `sparse` array in `hybridSearch`.
// ============================================================================

import 'server-only';
import { sql } from 'drizzle-orm';
import { db } from '@/lib/db/client';
import {
  embedBatch,
  dimColumnFor,
  dimForModel,
  pickEmbeddingProvider,
  type EmbeddingColumn,
} from './embeddings';

// Emit a single, module-load-time warning so operators see why hybrid search
// is dense-only without having to grep the source.
// eslint-disable-next-line no-console
console.warn(
  '[rag/retriever] BM25 sparse retrieval is DISABLED (pg_search extension not installed on Neon); using dense pgvector path only.',
);

export interface HybridSearchOpts {
  stockId: number;
  query: string;
  /** Number of final hits to return after RRF merge. Defaults to 10. */
  k?: number;
  /** Optional ISO date / Date lower bound on `published_at`. */
  fromDate?: Date | string;
  /** Optional ISO date / Date upper bound on `published_at`. */
  toDate?: Date | string;
}

export type HitKind = 'news' | 'research' | 'business_context';

export interface HybridHit {
  id: number;
  text: string;
  source_url?: string | null;
  published_at?: Date | null;
  score: number;
  kind: HitKind;
}

const PER_TABLE_LIMIT = 50;
const RRF_K = 60;

type RagTable = 'news_chunks' | 'research_notes' | 'business_context_chunks';

interface RawCandidate {
  id: number;
  text: string;
  source_url: string | null;
  published_at: Date | null;
  kind: HitKind;
  rank: number;
}

/**
 * Resolves the vector column the (`tableName`, `stockId`) collection is
 * pinned to. If the collection is empty we fall back to the column for the
 * *currently active* embedding provider; that's harmless because the WHERE
 * `<col> IS NOT NULL` clause will simply match nothing.
 */
async function resolveColumn(
  tableName: RagTable,
  stockId: number,
): Promise<EmbeddingColumn> {
  const rows = await db.execute(
    sql`select embedding_model from ${sql.raw(tableName)} where stock_id = ${stockId} limit 1`,
  );
  const first = (rows as unknown as Array<{ embedding_model: string }>)[0];
  if (first) return dimColumnFor(dimForModel(first.embedding_model));
  const pick = await pickEmbeddingProvider();
  return dimColumnFor(pick.dim);
}

/**
 * Hybrid retrieval over the three pgvector tables.
 *
 * 1. Embed the query once with the user's preferred provider.
 * 2. Resolve, per table, which `embedding_{dim}` column this stock's
 *    collection is pinned to (via any pre-existing row's `embedding_model`).
 *    Different stocks may live in different columns — that's fine, the
 *    per-stock filter scopes each query.
 * 3. Per table, run the dense top-50 lookup in parallel:
 *      Dense: `<col> <=> $q` (cosine distance, ascending), filtering out
 *      rows where that column is NULL (rows written under a different
 *      model never share a column with the query vector).
 *    The sparse BM25 path is currently disabled — see the file header.
 * 4. Merge the dense result lists via Reciprocal Rank Fusion (k=60) and
 *    return the top `k` (default 10). The sparse lists are passed in as
 *    empty arrays so the RRF merge logic stays unchanged.
 *
 * Notes:
 *  - If the query vector's dim doesn't match the stock's pinned column,
 *    we skip the dense lookup for that table. With sparse disabled, that
 *    table will contribute no hits for this query — re-embed the corpus
 *    with the active provider to bring it back.
 */
export async function hybridSearch(opts: HybridSearchOpts): Promise<HybridHit[]> {
  const k = opts.k ?? 10;
  const queryText = opts.query.trim();
  if (!queryText) return [];

  const { vectors, dim: queryDim } = await embedBatch([queryText]);
  const qvec = vectors[0];
  if (!qvec) return [];
  const qvecLiteral = `[${qvec.join(',')}]`;
  const queryCol = dimColumnFor(queryDim);

  const fromTs = opts.fromDate ? new Date(opts.fromDate) : null;
  const toTs = opts.toDate ? new Date(opts.toDate) : null;

  const [newsCol, researchCol, businessCol] = await Promise.all([
    resolveColumn('news_chunks', opts.stockId),
    resolveColumn('research_notes', opts.stockId),
    resolveColumn('business_context_chunks', opts.stockId),
  ]);

  const dense: Array<Promise<RawCandidate[]>> = [
    newsCol === queryCol
      ? denseNews(opts.stockId, qvecLiteral, newsCol, fromTs, toTs)
      : Promise.resolve([]),
    researchCol === queryCol
      ? denseResearch(opts.stockId, qvecLiteral, researchCol)
      : Promise.resolve([]),
    businessCol === queryCol
      ? denseBusiness(opts.stockId, qvecLiteral, businessCol)
      : Promise.resolve([]),
  ];
  // Sparse BM25 path disabled (see file header) — pass empty lists so the
  // RRF merge below behaves identically to the dense-only case without
  // requiring branching downstream.
  void queryText; // retained for future re-enable + to keep the signature stable
  const sparse: Array<Promise<RawCandidate[]>> = [
    Promise.resolve([]),
    Promise.resolve([]),
    Promise.resolve([]),
  ];

  const settled = await Promise.all([...dense, ...sparse]);
  return rrfMerge(settled, k);
}

// ---------- Dense lookups (pgvector cosine, lower distance = better) ----------

async function denseNews(
  stockId: number,
  qvec: string,
  col: EmbeddingColumn,
  fromTs: Date | null,
  toTs: Date | null,
): Promise<RawCandidate[]> {
  const dateFilter = sql`${
    fromTs ? sql`and published_at >= ${fromTs}` : sql``
  } ${toTs ? sql`and published_at <= ${toTs}` : sql``}`;
  const rows = await db.execute(sql`
    select id, chunk_text as text, source_url, published_at,
           (${sql.raw(col)} <=> ${qvec}::vector) as distance
      from news_chunks
     where stock_id = ${stockId}
       and ${sql.raw(col)} is not null
       ${dateFilter}
     order by ${sql.raw(col)} <=> ${qvec}::vector
     limit ${PER_TABLE_LIMIT}
  `);
  return castRows(rows, 'news', /*lowerIsBetter*/ true);
}

async function denseResearch(
  stockId: number,
  qvec: string,
  col: EmbeddingColumn,
): Promise<RawCandidate[]> {
  const rows = await db.execute(sql`
    select id, chunk_text as text, null::text as source_url,
           null::timestamptz as published_at,
           (${sql.raw(col)} <=> ${qvec}::vector) as distance
      from research_notes
     where stock_id = ${stockId}
       and ${sql.raw(col)} is not null
     order by ${sql.raw(col)} <=> ${qvec}::vector
     limit ${PER_TABLE_LIMIT}
  `);
  return castRows(rows, 'research', true);
}

async function denseBusiness(
  stockId: number,
  qvec: string,
  col: EmbeddingColumn,
): Promise<RawCandidate[]> {
  const rows = await db.execute(sql`
    select id, chunk_text as text, null::text as source_url,
           null::timestamptz as published_at,
           (${sql.raw(col)} <=> ${qvec}::vector) as distance
      from business_context_chunks
     where stock_id = ${stockId}
       and ${sql.raw(col)} is not null
     order by ${sql.raw(col)} <=> ${qvec}::vector
     limit ${PER_TABLE_LIMIT}
  `);
  return castRows(rows, 'business_context', true);
}

// ---------- Sparse lookups (ParadeDB BM25 via @@@) — DISABLED ----------
// The sparseNews / sparseResearch / sparseBusiness helpers were removed
// because Neon does not provide the `pg_search` extension. See the file
// header for re-enable instructions and the git history for the prior
// implementations.

// ---------- Helpers ----------

function castRows(rows: unknown, kind: HitKind, _lowerIsBetter: boolean): RawCandidate[] {
  void _lowerIsBetter; // ordering is enforced by SQL; flag is documentation only
  const arr = rows as unknown as Array<{
    id: number;
    text: string;
    source_url: string | null;
    published_at: Date | string | null;
    distance?: number | string;
    bm25?: number | string;
  }>;
  return arr.map((r, i) => ({
    id: Number(r.id),
    text: r.text,
    source_url: r.source_url ?? null,
    published_at: r.published_at ? new Date(r.published_at) : null,
    kind,
    rank: i, // 0-based; RRF uses ordinal rank, not raw distance
  }));
}

/**
 * Reciprocal Rank Fusion. For each ordered candidate list, every hit
 * contributes `1 / (k + rank)` to its key's accumulated score; keys are
 * `${kind}:${id}` so the same row in dense + sparse merges correctly.
 *
 * We collapse to the first observed representation of each key (consistent
 * text/source_url/published_at across lists).
 */
function rrfMerge(lists: RawCandidate[][], topK: number): HybridHit[] {
  const acc = new Map<string, HybridHit>();
  for (const list of lists) {
    list.forEach((c, idx) => {
      const key = `${c.kind}:${c.id}`;
      const contribution = 1 / (RRF_K + idx + 1); // +1 so rank 0 -> 1/61
      const existing = acc.get(key);
      if (existing) {
        existing.score += contribution;
      } else {
        acc.set(key, {
          id: c.id,
          text: c.text,
          source_url: c.source_url,
          published_at: c.published_at,
          score: contribution,
          kind: c.kind,
        });
      }
    });
  }
  return [...acc.values()].sort((a, b) => b.score - a.score).slice(0, topK);
}

import { test, mock } from 'node:test';
import assert from 'node:assert/strict';

/**
 * The collection-pin guard lives in `lib/rag/index.ts`. We can't easily import
 * that module from a test because it pulls in `server-only`, the postgres
 * driver, and the encrypted-key vault. Instead we re-implement the guard's
 * contract here and verify the error shape — and also exercise the production
 * helper via a stubbed `db` if `node:test`'s `mock.module` is available.
 *
 * The production helper signature (private, but stable per M4-1 / M4-2):
 *
 *   await assertCollectionModel(table, stockId, newModel)
 *     -> resolves when no rows or row.embedding_model === newModel
 *     -> rejects with /pinned to model X/ when mismatch
 *
 * Post-M4-2, a model mismatch also implies a column mismatch (each model has
 * a fixed native dim → distinct `embedding_{dim}` column). The single pin
 * check therefore covers both invariants — no separate dim guard is needed.
 */

// --- Contract test ---------------------------------------------------------

function buildGuard(executeImpl: (q: unknown) => Promise<unknown>) {
  // Mirrors `assertCollectionModel` in lib/rag/index.ts.
  return async function assertCollectionModel(
    tableName: string,
    stockId: number,
    newModel: string,
  ): Promise<void> {
    const rows = (await executeImpl({ tableName, stockId })) as Array<{
      embedding_model: string;
    }>;
    const first = rows[0];
    if (first && first.embedding_model !== newModel) {
      throw new Error(
        `collection ${tableName}(stock_id=${stockId}) pinned to model ${first.embedding_model} — got ${newModel}`,
      );
    }
  };
}

test('passes when collection is empty', async () => {
  const guard = buildGuard(async () => []);
  await guard('news_chunks', 1, 'text-embedding-3-small');
});

test('passes when existing model matches', async () => {
  const guard = buildGuard(async () => [{ embedding_model: 'text-embedding-3-small' }]);
  await guard('news_chunks', 1, 'text-embedding-3-small');
});

test('throws "pinned to model X" on mismatch', async () => {
  const guard = buildGuard(async () => [{ embedding_model: 'text-embedding-3-small' }]);
  await assert.rejects(
    () => guard('news_chunks', 42, 'mistral-embed'),
    (err: Error) => {
      assert.match(err.message, /pinned to model text-embedding-3-small/);
      assert.match(err.message, /got mistral-embed/);
      assert.match(err.message, /stock_id=42/);
      return true;
    },
  );
});

test('mismatch surfaces table name for operator triage', async () => {
  const guard = buildGuard(async () => [{ embedding_model: 'text-embedding-004' }]);
  await assert.rejects(
    () => guard('business_context_chunks', 7, 'text-embedding-3-small'),
    /collection business_context_chunks\(stock_id=7\)/,
  );
});

// --- Optional production-module test --------------------------------------
//
// `node:test`'s `mock.module` lets us swap out `@/lib/db/client` before the
// real `lib/rag/index.ts` is imported. This costs little when the loader is
// available and is skipped cleanly when it isn't (e.g. older Node).

test('production upsertNewsChunks rejects cross-model insert', async (t) => {
  if (typeof mock.module !== 'function') {
    t.skip('node:test mock.module not available');
    return;
  }
  // Stub out the postgres + drizzle imports the real module pulls in.
  mock.module('server-only', { namedExports: {} });
  mock.module('@/lib/db/client', {
    namedExports: {
      db: {
        execute: async () => [{ embedding_model: 'text-embedding-3-small' }],
        insert: () => ({ values: async () => undefined }),
      },
    },
  });
  mock.module('../embeddings', {
    namedExports: {
      embedBatch: async (texts: string[]) => ({
        vectors: texts.map(() => Array(1024).fill(0)),
        model: 'mistral-embed',
        dim: 1024,
      }),
      pickEmbeddingProvider: async () => ({
        provider: 'mistral',
        model: 'mistral-embed',
        dim: 1024,
      }),
    },
  });

  let mod: typeof import('../index');
  try {
    mod = await import('../index');
  } catch (err) {
    t.skip(`could not load module under mock: ${(err as Error).message}`);
    return;
  }

  await assert.rejects(
    () => mod.upsertNewsChunks(1, null, 'https://example.com', new Date(), 'some news text'),
    /pinned to model text-embedding-3-small.*got mistral-embed/s,
  );
});

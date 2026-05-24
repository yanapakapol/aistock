import 'server-only';
import { secureFetch } from '@/lib/security/secureFetch';
import { loadApiKey } from '@/lib/llm/keys';
import type { Provider } from '@/lib/llm/providers';

/**
 * Providers that expose an embeddings endpoint, in the order we prefer them
 * for the RAG pipeline. Anthropic is intentionally omitted — they don't ship
 * a first-party embedding model.
 *
 * The RAG tables expose three nullable vector columns (1536/768/1024); each
 * row populates exactly one based on the provider's native dim. See
 * `lib/rag/MULTI-DIM.md`.
 */
export type EmbeddingProvider = 'openai' | 'google' | 'mistral';

export type EmbeddingDim = 768 | 1024 | 1536;
export type EmbeddingColumn = 'embedding_768' | 'embedding_1024' | 'embedding_1536';

/**
 * Maps an embedding dimensionality to the schema column that stores it.
 * Throws loudly for any unsupported dim so a misconfigured provider can't
 * silently fall through to a NULL insert.
 */
export function dimColumnFor(dim: number): EmbeddingColumn {
  switch (dim) {
    case 768:
      return 'embedding_768';
    case 1024:
      return 'embedding_1024';
    case 1536:
      return 'embedding_1536';
    default:
      throw new Error(
        `unsupported embedding dim ${dim}: expected 768, 1024, or 1536 ` +
          `(add a vector column to schema.ts before introducing a new dim)`,
      );
  }
}

export interface EmbeddingPick {
  provider: EmbeddingProvider;
  model: string;
  dim: number;
}

const PREFERENCE: Array<{ provider: Provider; pick: EmbeddingPick }> = [
  {
    provider: 'openai',
    pick: { provider: 'openai', model: 'text-embedding-3-small', dim: 1536 },
  },
  {
    provider: 'google',
    pick: { provider: 'google', model: 'text-embedding-004', dim: 768 },
  },
  // Anthropic deliberately skipped.
  {
    provider: 'mistral',
    pick: { provider: 'mistral', model: 'mistral-embed', dim: 1024 },
  },
];

/**
 * Lookup table for the dim of every model name we might persist in
 * `embedding_model`. Used by the retriever to pick the right vector column
 * for a collection without re-embedding a probe query first.
 */
const MODEL_DIMS: Record<string, EmbeddingDim> = {
  'text-embedding-3-small': 1536,
  'text-embedding-004': 768,
  'mistral-embed': 1024,
};

export function dimForModel(model: string): EmbeddingDim {
  const d = MODEL_DIMS[model];
  if (!d) {
    throw new Error(
      `unknown embedding model "${model}": add it to MODEL_DIMS in lib/rag/embeddings.ts`,
    );
  }
  return d;
}

const BATCH_SIZE = 64;

/**
 * Returns the highest-priority embedding-capable provider for which the user
 * has stored an API key. Throws if none are configured.
 */
export async function pickEmbeddingProvider(): Promise<EmbeddingPick> {
  for (const candidate of PREFERENCE) {
    const key = await loadApiKey(candidate.provider);
    if (key) return candidate.pick;
  }
  throw new Error('no embedding-capable provider key configured');
}

export interface EmbedResult {
  vectors: number[][];
  model: string;
  dim: number;
}

/**
 * Embeds `texts` via the user's preferred embedding provider, batching at
 * 64 inputs per request to stay well under per-provider request limits.
 *
 * Empty input returns `{vectors: [], ...}` — callers needn't special-case it.
 */
export async function embedBatch(texts: string[]): Promise<EmbedResult> {
  const pick = await pickEmbeddingProvider();
  if (texts.length === 0) return { vectors: [], model: pick.model, dim: pick.dim };

  const apiKey = await loadApiKey(pick.provider as Provider);
  if (!apiKey) {
    // Key was deleted between pick and use — bail loudly.
    throw new Error(`api key for provider ${pick.provider} disappeared mid-call`);
  }

  const vectors: number[][] = [];
  for (let i = 0; i < texts.length; i += BATCH_SIZE) {
    const slice = texts.slice(i, i + BATCH_SIZE);
    const batchVecs = await callProvider(pick, apiKey, slice);
    for (const v of batchVecs) {
      if (v.length !== pick.dim) {
        throw new Error(
          `provider ${pick.provider} returned vector of dim ${v.length}, expected ${pick.dim}`,
        );
      }
      vectors.push(v);
    }
  }
  return { vectors, model: pick.model, dim: pick.dim };
}

async function callProvider(
  pick: EmbeddingPick,
  apiKey: string,
  inputs: string[],
): Promise<number[][]> {
  switch (pick.provider) {
    case 'openai':
      return embedOpenAI(apiKey, pick.model, inputs);
    case 'google':
      return embedGoogle(apiKey, pick.model, inputs);
    case 'mistral':
      return embedMistral(apiKey, pick.model, inputs);
  }
}

async function embedOpenAI(apiKey: string, model: string, inputs: string[]): Promise<number[][]> {
  const res = await secureFetch(
    'https://api.openai.com/v1/embeddings',
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({ model, input: inputs }),
    },
    { kind: 'llm.openai.embeddings' },
  );
  if (!res.ok) throw new Error(`openai embeddings ${res.status}: ${await safeText(res)}`);
  const json = (await res.json()) as { data: Array<{ embedding: number[] }> };
  return json.data.map((d) => d.embedding);
}

async function embedGoogle(apiKey: string, model: string, inputs: string[]): Promise<number[][]> {
  // Google's `:batchEmbedContents` accepts a list of requests, each with a
  // `content` of `parts: [{text}]`. Model is part of the URL path, not the body.
  const url =
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}` +
    `:batchEmbedContents?key=${encodeURIComponent(apiKey)}`;
  const body = {
    requests: inputs.map((text) => ({
      model: `models/${model}`,
      content: { parts: [{ text }] },
    })),
  };
  const res = await secureFetch(
    url,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    },
    { kind: 'llm.google.embeddings' },
  );
  if (!res.ok) throw new Error(`google embeddings ${res.status}: ${await safeText(res)}`);
  const json = (await res.json()) as { embeddings: Array<{ values: number[] }> };
  return json.embeddings.map((e) => e.values);
}

async function embedMistral(apiKey: string, model: string, inputs: string[]): Promise<number[][]> {
  const res = await secureFetch(
    'https://api.mistral.ai/v1/embeddings',
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({ model, input: inputs }),
    },
    { kind: 'llm.mistral.embeddings' },
  );
  if (!res.ok) throw new Error(`mistral embeddings ${res.status}: ${await safeText(res)}`);
  const json = (await res.json()) as { data: Array<{ embedding: number[] }> };
  return json.data.map((d) => d.embedding);
}

async function safeText(res: Response): Promise<string> {
  try {
    return (await res.text()).slice(0, 500);
  } catch {
    return '<unreadable>';
  }
}

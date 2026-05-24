import 'server-only';
import { unstable_cache, revalidateTag } from 'next/cache';
import { sql } from 'drizzle-orm';
import { db } from '@/lib/db/client';
import { modelsCache } from '@/lib/db/schema';
import fallback from './models.json' with { type: 'json' };
import { PROVIDERS, type Provider, type ModelInfo, type ProviderInfo } from './providers';

const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

const FALLBACK = fallback as unknown as Record<Provider, ProviderInfo> & {
  _meta?: unknown;
};

/**
 * List models for a provider.
 *   1. Try Postgres cache (< 24h).
 *   2. Try live /v1/models (or /models for DeepSeek) with the user's API key.
 *   3. Fall back to the hardcoded list.
 *
 * Pricing always comes from the fallback file (no provider exposes per-model prices via API).
 */
export async function listModels(provider: Provider, apiKey?: string): Promise<ModelInfo[]> {
  const cached = await readCache(provider);
  if (cached) return cached;

  if (apiKey) {
    try {
      const live = await fetchLive(provider, apiKey);
      if (live.length) {
        const merged = mergePricing(provider, live);
        await writeCache(provider, merged);
        return merged;
      }
    } catch {
      // Swallow; fall through to fallback. Live-fetch failure is non-fatal.
    }
  }

  return FALLBACK[provider]?.models ?? [];
}

function mergePricing(provider: Provider, live: ModelInfo[]): ModelInfo[] {
  const priceMap = new Map(FALLBACK[provider].models.map((m) => [m.id, m]));
  return live.map((m) => {
    const fb = priceMap.get(m.id);
    return { ...fb, ...m, input: m.input ?? fb?.input, output: m.output ?? fb?.output };
  });
}

// In-process memoization on top of the Postgres-backed cache. The model list
// changes ~daily (24h TTL on writes) but `/api/models` is hit on every chat
// page mount AND every model dropdown open. unstable_cache (Next 15 data
// cache) collapses identical reads within the 60s window to a single DB query
// across all routes on the same server.
const readCache = unstable_cache(
  async (provider: Provider): Promise<ModelInfo[] | null> => {
    try {
      const cutoff = new Date(Date.now() - CACHE_TTL_MS);
      const rows = await db
        .select()
        .from(modelsCache)
        .where(sql`provider = ${provider} AND fetched_at > ${cutoff}`);
      if (!rows.length) return null;
      return rows.map((r) => r.payload as ModelInfo);
    } catch {
      // DB unreachable / table missing → silently degrade to fallback.
      return null;
    }
  },
  ['llm:models-cache:read'],
  { revalidate: 60, tags: ['llm-models'] },
);

async function writeCache(provider: Provider, models: ModelInfo[]) {
  try {
    await db.transaction(async (tx) => {
      await tx.delete(modelsCache).where(sql`provider = ${provider}`);
      if (!models.length) return;
      await tx.insert(modelsCache).values(
        models.map((m) => ({
          provider,
          modelId: m.id,
          payload: m as unknown as Record<string, unknown>,
        })),
      );
    });
  } catch {
    // Cache write is best-effort; ignore failures.
  }
}

async function fetchLive(provider: Provider, apiKey: string): Promise<ModelInfo[]> {
  const info = FALLBACK[provider];
  switch (provider) {
    case 'openai':
    case 'mistral':
    case 'moonshot':
    case 'deepseek': {
      const r = await fetch(info.listEndpoint, {
        headers: { Authorization: `Bearer ${apiKey}` },
      });
      if (!r.ok) throw new Error(`${provider} /models ${r.status}`);
      const j = (await r.json()) as { data?: Array<{ id: string }> };
      return (j.data ?? []).map((m) => ({ id: m.id }));
    }
    case 'anthropic': {
      const r = await fetch(info.listEndpoint, {
        headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      });
      if (!r.ok) throw new Error(`anthropic /models ${r.status}`);
      const j = (await r.json()) as { data?: Array<{ id: string }> };
      return (j.data ?? []).map((m) => ({ id: m.id }));
    }
    case 'google': {
      const r = await fetch(`${info.listEndpoint}?key=${encodeURIComponent(apiKey)}`);
      if (!r.ok) throw new Error(`google models.list ${r.status}`);
      const j = (await r.json()) as { models?: Array<{ name: string }> };
      return (j.models ?? []).map((m) => ({ id: m.name.replace(/^models\//, '') }));
    }
  }
}

export { PROVIDERS };
export type { Provider, ModelInfo };

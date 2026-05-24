import models from '../llm/models.json';
import type { Provider } from '../llm/providers';

interface ModelEntry {
  id: string;
  input?: number; // USD per 1M input tokens
  output?: number; // USD per 1M output tokens
}

interface ProviderEntry {
  models: ModelEntry[];
}

const registry = models as unknown as Record<string, ProviderEntry>;

export interface MeterInput {
  provider: Provider | string;
  modelId: string;
  tokensIn: number;
  tokensOut: number;
}

/**
 * Returns the USD cost of a single completion based on the static pricing in
 * `lib/llm/models.json`. Unknown provider/model pairs return 0 — the caller
 * should treat that as a signal to refresh the model registry, not as a free
 * call. Live pricing endpoints are not exposed by any provider as of May 2026.
 */
export function meter({ provider, modelId, tokensIn, tokensOut }: MeterInput): number {
  const p = registry[provider];
  if (!p) return 0;
  const model = p.models.find((m) => m.id === modelId);
  if (!model) return 0;
  const inUsd = ((model.input ?? 0) * tokensIn) / 1_000_000;
  const outUsd = ((model.output ?? 0) * tokensOut) / 1_000_000;
  return inUsd + outUsd;
}

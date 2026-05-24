'use client';

import { useEffect, useState } from 'react';
import { Select } from '@/components/ui/select';
import { PROVIDERS, PROVIDER_LABELS, type Provider, type ModelInfo } from '@/lib/llm/providers';

const TABS = ['research', 'analysis', 'routines'] as const;
type Tab = (typeof TABS)[number];

const TAB_LABELS: Record<Tab, string> = {
  research: 'Research',
  analysis: 'Analysis',
  routines: 'Routines',
};

const LS_KEY = (tab: Tab) => `aistock:model:${tab}`;

interface Selection {
  provider: Provider;
  modelId: string;
}

export function ModelPicker() {
  // Defaults to real Mistral API model ids. Cheap + fast. The user can
  // override per-tab; the InlineModelPicker in chat headers also reads /
  // writes these LS keys (`aistock:model:<tab>`) so changes propagate.
  const [byTab, setByTab] = useState<Record<Tab, Selection>>(() => ({
    research: { provider: 'mistral', modelId: 'mistral-medium-latest' },
    analysis: { provider: 'mistral', modelId: 'mistral-medium-latest' },
    routines: { provider: 'mistral', modelId: 'mistral-small-latest' },
  }));
  const [modelsByProvider, setModelsByProvider] = useState<Partial<Record<Provider, ModelInfo[]>>>({});

  // Hydrate from localStorage
  useEffect(() => {
    setByTab((prev) => {
      const next = { ...prev };
      for (const tab of TABS) {
        const raw = localStorage.getItem(LS_KEY(tab));
        if (raw) {
          try {
            next[tab] = JSON.parse(raw) as Selection;
          } catch {
            /* ignore */
          }
        }
      }
      return next;
    });
  }, []);

  // Load models for any provider currently in use
  useEffect(() => {
    const needed = new Set<Provider>();
    for (const tab of TABS) needed.add(byTab[tab].provider);
    for (const p of needed) {
      if (modelsByProvider[p]) continue;
      void fetch(`/api/models?provider=${p}`)
        .then((r) => r.json())
        .then((j: { models: ModelInfo[] }) =>
          setModelsByProvider((prev) => ({ ...prev, [p]: j.models })),
        )
        .catch(() => undefined);
    }
  }, [byTab, modelsByProvider]);

  function update(tab: Tab, patch: Partial<Selection>) {
    setByTab((prev) => {
      const cur = prev[tab];
      const merged: Selection = { ...cur, ...patch };
      if (patch.provider && patch.provider !== cur.provider) {
        const first = modelsByProvider[patch.provider]?.[0]?.id;
        if (first) merged.modelId = first;
      }
      localStorage.setItem(LS_KEY(tab), JSON.stringify(merged));
      return { ...prev, [tab]: merged };
    });
  }

  return (
    <div className="space-y-4">
      {TABS.map((tab) => {
        const sel = byTab[tab];
        const models = modelsByProvider[sel.provider] ?? [];
        const current = models.find((m) => m.id === sel.modelId);
        return (
          <div key={tab} className="space-y-2">
            <div className="text-sm font-medium">{TAB_LABELS[tab]}</div>
            <div className="grid grid-cols-[160px_1fr_auto] gap-3">
              <Select value={sel.provider} onChange={(e) => update(tab, { provider: e.target.value as Provider })}>
                {PROVIDERS.map((p) => (
                  <option key={p} value={p}>
                    {PROVIDER_LABELS[p]}
                  </option>
                ))}
              </Select>
              <Select value={sel.modelId} onChange={(e) => update(tab, { modelId: e.target.value })}>
                {models.length === 0 ? <option value="">(loading)</option> : null}
                {Array.from(new Map(models.map((m) => [m.id, m])).values()).map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.id}
                    {m.input != null && m.output != null
                      ? `  •  $${m.input}/$${m.output} per 1M`
                      : ''}
                    {m.context ? `  •  ${(m.context / 1000).toFixed(0)}K` : ''}
                  </option>
                ))}
              </Select>
              <div className="text-xs text-muted-foreground self-center min-w-[120px] text-right">
                {current?.tools ? 'tools ✓' : 'no tools'}
                {current?.reasoning ? ' · reasoning' : ''}
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

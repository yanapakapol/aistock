'use client';

import { useEffect, useState } from 'react';
import { ChevronDown } from 'lucide-react';
import { cn } from '@/lib/utils';
import { PROVIDERS, PROVIDER_LABELS, type Provider, type ModelInfo } from '@/lib/llm/providers';

interface Selection {
  provider: Provider;
  modelId: string;
}

const LS_KEY = (tab: string) => `aistock:model:${tab}`;

/**
 * Small in-header model picker for Research / Analysis tabs.
 * Reads + writes the SAME localStorage key the Settings page uses
 * (`aistock:model:<tab>`), so changes propagate everywhere instantly.
 *
 * Click the badge → expands to two dropdowns (provider, model) inline.
 * Click outside → collapses.
 */
export function InlineModelPicker({
  tab,
  onChange,
}: {
  tab: 'research' | 'analysis' | 'routines';
  onChange?: (sel: Selection) => void;
}) {
  const [sel, setSel] = useState<Selection>({
    provider: 'anthropic',
    modelId: 'claude-sonnet-4-6',
  });
  const [models, setModels] = useState<Record<Provider, ModelInfo[]>>(
    () => ({}) as Record<Provider, ModelInfo[]>,
  );
  const [open, setOpen] = useState(false);

  // Hydrate from localStorage.
  useEffect(() => {
    try {
      const raw = localStorage.getItem(LS_KEY(tab));
      if (raw) setSel(JSON.parse(raw) as Selection);
    } catch {
      /* ignore */
    }
  }, [tab]);

  // Lazy-load model list when opened.
  useEffect(() => {
    if (!open) return;
    if (models[sel.provider]?.length) return;
    void fetch(`/api/models?provider=${sel.provider}`)
      .then((r) => r.json())
      .then((j: { models: ModelInfo[] }) =>
        setModels((prev) => ({ ...prev, [sel.provider]: j.models ?? [] })),
      )
      .catch(() => undefined);
  }, [open, sel.provider, models]);

  function update(patch: Partial<Selection>) {
    const next: Selection = { ...sel, ...patch };
    if (patch.provider && patch.provider !== sel.provider) {
      // Lazy-load the new provider's model list immediately.
      void fetch(`/api/models?provider=${patch.provider}`)
        .then((r) => r.json())
        .then((j: { models: ModelInfo[] }) => {
          setModels((prev) => ({ ...prev, [patch.provider!]: j.models ?? [] }));
          const first = (j.models ?? [])[0]?.id;
          if (first) {
            const final: Selection = { provider: patch.provider!, modelId: first };
            setSel(final);
            try {
              localStorage.setItem(LS_KEY(tab), JSON.stringify(final));
            } catch {
              /* quota */
            }
            onChange?.(final);
          }
        });
      // Provisionally update state with empty model.
      setSel({ provider: patch.provider, modelId: '' });
      return;
    }
    setSel(next);
    try {
      localStorage.setItem(LS_KEY(tab), JSON.stringify(next));
    } catch {
      /* quota */
    }
    onChange?.(next);
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        title="Change model"
        className="inline-flex items-center gap-1 rounded-md border border-border bg-muted/30 px-2 py-0.5 text-[10px] font-medium text-muted-foreground hover:text-foreground"
      >
        <span className="max-w-[140px] truncate">
          {sel.provider} · {sel.modelId || '(none)'}
        </span>
        <ChevronDown className="h-3 w-3" />
      </button>
    );
  }

  const providerModels = models[sel.provider] ?? [];

  return (
    <div className="inline-flex items-center gap-1 rounded-md border border-foreground/30 bg-accent px-2 py-0.5 text-[10px]">
      <select
        value={sel.provider}
        onChange={(e) => update({ provider: e.target.value as Provider })}
        className="bg-transparent text-foreground focus:outline-none"
      >
        {PROVIDERS.map((p) => (
          <option key={p} value={p}>
            {PROVIDER_LABELS[p]}
          </option>
        ))}
      </select>
      <span className="opacity-30">·</span>
      <select
        value={sel.modelId}
        onChange={(e) => update({ modelId: e.target.value })}
        className="max-w-[200px] bg-transparent text-foreground focus:outline-none"
      >
        {providerModels.length === 0 ? <option value="">(loading…)</option> : null}
        {Array.from(new Map(providerModels.map((m) => [m.id, m])).values()).map((m) => (
          <option key={m.id} value={m.id}>
            {m.id}
            {m.input != null && m.output != null ? `  •  $${m.input}/$${m.output}` : ''}
          </option>
        ))}
      </select>
      <button
        type="button"
        onClick={() => setOpen(false)}
        className={cn('rounded px-1 text-muted-foreground hover:text-foreground')}
      >
        ✓
      </button>
    </div>
  );
}

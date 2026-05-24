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
// Preferred default order: free tier / cheapest first. Mistral wins.
const DEFAULT_PRIORITY: Provider[] = [
  'mistral',
  'google',
  'deepseek',
  'moonshot',
  'openai',
  'anthropic',
];

const DEFAULT_MODEL_FOR: Record<Provider, string> = {
  mistral: 'mistral-large-2512',
  google: 'gemini-3.5-flash',
  deepseek: 'deepseek-v4-flash',
  moonshot: 'kimi-k2.6',
  openai: 'gpt-5.5',
  anthropic: 'claude-sonnet-4-6',
};

export function InlineModelPicker({
  tab,
  onChange,
}: {
  tab: 'research' | 'analysis' | 'routines';
  onChange?: (sel: Selection) => void;
}) {
  // Sentinel — null means "still picking a sensible default". We avoid
  // hard-coding claude-sonnet-4-6 because most users only have a Mistral key.
  const [sel, setSel] = useState<Selection | null>(null);
  const [models, setModels] = useState<Record<Provider, ModelInfo[]>>(
    () => ({}) as Record<Provider, ModelInfo[]>,
  );
  const [open, setOpen] = useState(false);

  // Hydrate: prefer saved selection; else first configured provider in priority
  // order; else fall back to Mistral default.
  useEffect(() => {
    let cancelled = false;
    async function pickDefault() {
      // 1. localStorage wins — but only if the modelId actually belongs to the
      //    provider. Stale combos like {provider:'mistral', modelId:'claude-…'}
      //    can leak in across default-provider changes; render the saved value
      //    immediately for snappy paint, then validate in the background and
      //    correct (and rewrite localStorage) if it's bogus.
      try {
        const raw = localStorage.getItem(LS_KEY(tab));
        if (raw) {
          const saved = JSON.parse(raw) as Selection;
          if (saved?.provider && saved.modelId && !cancelled) {
            setSel(saved);
            // Fire-and-forget validation. Don't block render.
            void fetch(`/api/models?provider=${saved.provider}`)
              .then((r) => r.json())
              .then((j: { models?: ModelInfo[] }) => {
                if (cancelled) return;
                const list = j.models ?? [];
                setModels((prev) => ({ ...prev, [saved.provider]: list }));
                const known = new Set(list.map((m) => m.id));
                if (list.length && !known.has(saved.modelId)) {
                  const replacement =
                    list[0]?.id ?? DEFAULT_MODEL_FOR[saved.provider];
                  const corrected: Selection = {
                    provider: saved.provider,
                    modelId: replacement,
                  };
                  setSel(corrected);
                  try {
                    localStorage.setItem(LS_KEY(tab), JSON.stringify(corrected));
                  } catch {
                    /* quota */
                  }
                  onChange?.(corrected);
                }
              })
              .catch(() => undefined);
            return;
          }
        }
      } catch {
        /* ignore */
      }
      // 2. Ask the server which providers have a key configured.
      try {
        const r = await fetch('/api/keys');
        const j = (await r.json()) as { llm?: Provider[] };
        const configured = new Set(j.llm ?? []);
        const picked = DEFAULT_PRIORITY.find((p) => configured.has(p)) ?? 'mistral';
        const next: Selection = {
          provider: picked,
          modelId: DEFAULT_MODEL_FOR[picked],
        };
        if (!cancelled) {
          setSel(next);
          try {
            localStorage.setItem(LS_KEY(tab), JSON.stringify(next));
          } catch {
            /* quota */
          }
          onChange?.(next);
        }
      } catch {
        if (!cancelled) {
          const fallback: Selection = { provider: 'mistral', modelId: 'mistral-large-2512' };
          setSel(fallback);
          onChange?.(fallback);
        }
      }
    }
    void pickDefault();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab]);

  // Lazy-load model list when opened.
  useEffect(() => {
    if (!open || !sel) return;
    if (models[sel.provider]?.length) return;
    void fetch(`/api/models?provider=${sel.provider}`)
      .then((r) => r.json())
      .then((j: { models: ModelInfo[] }) =>
        setModels((prev) => ({ ...prev, [sel.provider]: j.models ?? [] })),
      )
      .catch(() => undefined);
  }, [open, sel, models]);

  function update(patch: Partial<Selection>) {
    if (!sel) return;
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
    // Validate modelId-only changes against the provider's known model list
    // when it's already been lazy-loaded. Prevents the parent (or a stale
    // event) from saving a model that doesn't belong to the current provider.
    if (patch.modelId && !patch.provider) {
      const known = models[sel.provider];
      if (known && known.length && !known.some((m) => m.id === patch.modelId)) {
        // Refuse silently.
        return;
      }
    }
    setSel(next);
    try {
      localStorage.setItem(LS_KEY(tab), JSON.stringify(next));
    } catch {
      /* quota */
    }
    onChange?.(next);
  }

  if (!sel) {
    return (
      <span className="inline-flex items-center gap-1 rounded-md border border-border bg-muted/30 px-2 py-0.5 text-[10px] text-muted-foreground">
        loading model…
      </span>
    );
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

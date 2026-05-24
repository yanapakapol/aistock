'use client';

import { useCallback, useEffect, useState } from 'react';
import { KeyRow } from '@/components/settings/key-row';
import { ModelPicker } from '@/components/settings/model-picker';
import { PROVIDERS, PROVIDER_LABELS, type Provider } from '@/lib/llm/providers';
import { NEWS_PROVIDERS, NEWS_PROVIDER_LABELS, type NewsProvider } from '@/lib/news/providers';

interface Props {
  initialSaved: { llm: Provider[]; news: NewsProvider[] };
}

export function SettingsClient({ initialSaved }: Props) {
  const [savedLlm, setSavedLlm] = useState<Set<Provider>>(() => new Set(initialSaved.llm));
  const [savedNews, setSavedNews] = useState<Set<NewsProvider>>(
    () => new Set(initialSaved.news),
  );

  const refresh = useCallback(async () => {
    const r = await fetch('/api/keys');
    const j = (await r.json()) as { llm: Provider[]; news: NewsProvider[] };
    setSavedLlm(new Set(j.llm ?? []));
    setSavedNews(new Set(j.news ?? []));
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return (
    <div className="space-y-10">
      <section className="space-y-1">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
          LLM API keys
        </h2>
        <div>
          {PROVIDERS.map((p) => (
            <KeyRow
              key={p}
              kind="llm"
              provider={p}
              label={PROVIDER_LABELS[p]}
              saved={savedLlm.has(p)}
              onChanged={refresh}
            />
          ))}
        </div>
      </section>

      <section className="space-y-1">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
          News & data API keys
        </h2>
        <p className="text-xs text-muted-foreground">
          Tavily and Exa power news search (Exa is used as a fallback when Tavily is empty).
          Finnhub and EODHD are reserved for market/fundamentals fetches.
        </p>
        <div>
          {NEWS_PROVIDERS.map((p) => (
            <KeyRow
              key={p}
              kind="news"
              provider={p}
              label={NEWS_PROVIDER_LABELS[p]}
              saved={savedNews.has(p)}
              onChanged={refresh}
            />
          ))}
        </div>
      </section>

      <section className="space-y-3">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
          Default models per tab
        </h2>
        <p className="text-xs text-muted-foreground">
          Pricing is shown as $ per 1M input / output tokens. Live-fetched per provider where available; falls back to a bundled list.
        </p>
        <ModelPicker />
      </section>
    </div>
  );
}

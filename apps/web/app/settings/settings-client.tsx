'use client';

import { useCallback, useEffect, useState } from 'react';
import { KeyRow } from '@/components/settings/key-row';
import { ModelPicker } from '@/components/settings/model-picker';
import { PROVIDERS, PROVIDER_LABELS, type Provider } from '@/lib/llm/providers';
import { NEWS_PROVIDERS, NEWS_PROVIDER_LABELS, type NewsProvider } from '@/lib/news/providers';

type Role = 'admin' | 'user' | 'guest';

interface Props {
  initialSaved: { llm: Provider[]; news: NewsProvider[] };
  role: Role;
}

/** A provider may appear in /api/keys either as a bare slug (legacy shape) or
 *  as `{ provider, inherited? }` (current shape — other agent owns that route).
 *  Both are tolerated here so this file stays compatible during the rollout. */
type ApiKeyEntry<P extends string> = P | { provider: P; inherited?: boolean };

function entryProvider<P extends string>(e: ApiKeyEntry<P>): P {
  return typeof e === 'string' ? e : e.provider;
}

function entryInherited<P extends string>(e: ApiKeyEntry<P>): boolean {
  return typeof e === 'string' ? false : Boolean(e.inherited);
}

const GUEST_TOOLTIP = "Guests inherit the admin's keys and can't modify them.";

export function SettingsClient({ initialSaved, role }: Props) {
  const isGuest = role === 'guest';

  const [savedLlm, setSavedLlm] = useState<Map<Provider, boolean>>(
    () => new Map(initialSaved.llm.map((p) => [p, false])),
  );
  const [savedNews, setSavedNews] = useState<Map<NewsProvider, boolean>>(
    () => new Map(initialSaved.news.map((p) => [p, false])),
  );

  const refresh = useCallback(async () => {
    const r = await fetch('/api/keys');
    const j = (await r.json()) as {
      llm: ApiKeyEntry<Provider>[];
      news: ApiKeyEntry<NewsProvider>[];
    };
    setSavedLlm(
      new Map((j.llm ?? []).map((e) => [entryProvider(e), entryInherited(e)])),
    );
    setSavedNews(
      new Map((j.news ?? []).map((e) => [entryProvider(e), entryInherited(e)])),
    );
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return (
    <div className="space-y-10">
      {isGuest ? (
        <div
          role="status"
          className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm text-amber-900 dark:text-amber-200"
        >
          You are a guest. The keys below are inherited from the admin. Ask the
          admin to add or change keys.
        </div>
      ) : null}

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
              inherited={savedLlm.get(p) === true}
              readOnly={isGuest}
              readOnlyTooltip={GUEST_TOOLTIP}
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
              inherited={savedNews.get(p) === true}
              readOnly={isGuest}
              readOnlyTooltip={GUEST_TOOLTIP}
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
        {/* `fieldset[disabled]` propagates to every form control inside, which
            is exactly what we want for guests without touching ModelPicker. */}
        <fieldset
          disabled={isGuest}
          className={isGuest ? 'opacity-60' : undefined}
          title={isGuest ? GUEST_TOOLTIP : undefined}
        >
          <ModelPicker />
        </fieldset>
      </section>
    </div>
  );
}

import { SettingsClient } from './settings-client';
import { listSavedProviders } from '@/lib/llm/keys';
import { listSavedNewsProviders } from '@/lib/news/keys';
import { PROVIDERS, type Provider } from '@/lib/llm/providers';

export const dynamic = 'force-dynamic';

const LLM_SET = new Set<string>(PROVIDERS);

export default async function SettingsPage() {
  const [llmRows, newsRows] = await Promise.all([
    listSavedProviders().catch(() => []),
    listSavedNewsProviders().catch(() => []),
  ]);
  // `listSavedProviders` returns ALL rows from `api_keys` (the table is shared
  // with news providers since M3-3). Filter to LLM providers so the LLM list
  // doesn't include news rows.
  const llm = llmRows
    .map((r) => r.provider)
    .filter((p): p is Provider => LLM_SET.has(p));
  const news = newsRows.map((r) => r.provider);
  return (
    <div className="h-full overflow-auto">
      <div className="mx-auto max-w-3xl p-6 space-y-8">
        <header>
          <h1 className="text-lg font-semibold">Settings</h1>
          <p className="text-sm text-muted-foreground">
            API keys are encrypted at rest (AES-256-GCM, envelope-wrapped). Keys are never sent to the LLM and never written to logs.
          </p>
        </header>
        <SettingsClient initialSaved={{ llm, news }} />
      </div>
    </div>
  );
}

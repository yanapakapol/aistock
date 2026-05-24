import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { listModels } from '@/lib/llm/models';
import { loadApiKey } from '@/lib/llm/keys';
import { PROVIDERS } from '@/lib/llm/providers';

export const runtime = 'nodejs';

const ProviderEnum = z.enum(PROVIDERS);

export async function GET(req: NextRequest) {
  const provider = ProviderEnum.safeParse(req.nextUrl.searchParams.get('provider'));
  if (!provider.success) return NextResponse.json({ error: 'bad provider' }, { status: 400 });
  const key = await loadApiKey(provider.data);
  const models = await listModels(provider.data, key ?? undefined);
  // Cache hard on the browser: model list barely changes (24h TTL on server).
  // stale-while-revalidate keeps the dropdown instant even on slow Neon resume.
  return NextResponse.json(
    { provider: provider.data, models },
    {
      headers: {
        'Cache-Control': 'private, max-age=3600, stale-while-revalidate=86400',
      },
    },
  );
}

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
  // Model catalog is identical for every user (no key data, no per-user
  // filtering) — `public` lets shared caches/CDN coalesce. 15min fresh +
  // 24h SWR keeps the dropdown instant even on slow Neon resume.
  return NextResponse.json(
    { provider: provider.data, models },
    {
      headers: {
        'Cache-Control': 'public, max-age=900, stale-while-revalidate=86400',
      },
    },
  );
}

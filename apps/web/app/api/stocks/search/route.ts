import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { getAdapter } from '@/lib/market';

export const runtime = 'nodejs';

const QuerySchema = z.object({
  q: z.string().min(1).max(64),
  exchange: z.string().min(1).max(8).optional(),
});

export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const parsed = QuerySchema.safeParse({
    q: url.searchParams.get('q') ?? '',
    exchange: url.searchParams.get('exchange') ?? undefined,
  });
  if (!parsed.success) {
    return NextResponse.json({ error: 'bad request' }, { status: 400 });
  }
  try {
    const results = await getAdapter().searchSymbols(parsed.data.q, parsed.data.exchange as never);
    return NextResponse.json({ results });
  } catch (err) {
    const detail = (err as Error)?.message ?? String(err);
    console.error('[stocks/search] failed:', detail);
    return NextResponse.json({ error: 'search failed', detail }, { status: 502 });
  }
}

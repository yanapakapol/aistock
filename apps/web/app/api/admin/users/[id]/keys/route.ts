import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { and, eq, sql } from 'drizzle-orm';
import { db } from '@/lib/db/client';
import { apiKeys } from '@/lib/db/schema';
import { encryptSecret } from '@/lib/crypto/envelope';
import { getCurrentUser } from '@/lib/auth/session';
import { PROVIDERS } from '@/lib/llm/providers';
import { NEWS_PROVIDERS } from '@/lib/news/providers';

export const runtime = 'nodejs';

async function requireAdmin(): Promise<Response | null> {
  const u = await getCurrentUser().catch(() => null);
  if (!u) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  const [row] = (await db.execute(
    sql`select role from users where id = ${u.id} limit 1`,
  )) as unknown as Array<{ role: string }>;
  if (!row || row.role !== 'admin') {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }
  return null;
}

const AllProviders = [...PROVIDERS, ...NEWS_PROVIDERS] as const;
const Body = z.object({
  provider: z.enum(AllProviders as unknown as [string, ...string[]]),
  apiKey: z.string().min(8).max(512),
});

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const site = req.headers.get('sec-fetch-site');
  if (site && site !== 'same-origin' && site !== 'none') {
    return new NextResponse('cross-origin denied', { status: 403 });
  }

  const denied = await requireAdmin();
  if (denied) return denied;

  const { id: idStr } = await params;
  const targetId = Number.parseInt(idStr, 10);
  if (!Number.isInteger(targetId) || targetId <= 0) {
    return NextResponse.json({ error: 'bad id' }, { status: 400 });
  }

  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: 'bad request', issues: parsed.error.issues }, { status: 400 });
  }
  const { provider, apiKey } = parsed.data;

  // Verify the target user exists so we don't create orphan rows. The FK with
  // ON DELETE CASCADE would prevent a true orphan, but a missing user means
  // the admin probably stale-cached a deleted row.
  const [exists] = (await db.execute(
    sql`select 1 as ok from users where id = ${targetId} limit 1`,
  )) as unknown as Array<{ ok: number }>;
  if (!exists) return NextResponse.json({ error: 'user not found' }, { status: 404 });

  const rec = await encryptSecret({ plaintext: apiKey, provider });

  // Replace existing (user_id, provider) row. The unique index covers this
  // pair so a delete-then-insert is the simplest race-free path.
  await db
    .delete(apiKeys)
    .where(and(eq(apiKeys.userId, targetId), eq(apiKeys.provider, provider)));
  await db.insert(apiKeys).values({
    userId: targetId,
    provider,
    kid: rec.kid,
    ciphertext: rec.ciphertext,
    nonce: rec.nonce,
    tag: rec.tag,
    wrappedDek: rec.wrappedDek,
    dekNonce: rec.dekNonce,
    dekTag: rec.dekTag,
  });

  return NextResponse.json({ ok: true, provider });
}

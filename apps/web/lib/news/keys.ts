import 'server-only';
import { eq } from 'drizzle-orm';
import { db } from '@/lib/db/client';
import { apiKeys } from '@/lib/db/schema';
import { encryptSecret, decryptSecret, type EncryptedRecord } from '@/lib/crypto/envelope';
import type { NewsProvider } from './providers';

/**
 * News-provider key vault. Shares the same envelope-encrypted `api_keys`
 * table and crypto primitives as the LLM key vault — `api_keys.provider` is a
 * plain text column, so LLM and news provider rows coexist. The string slug
 * (e.g. "tavily") is the AAD-bound primary identifier.
 */

export async function saveNewsKey(provider: NewsProvider, plaintext: string): Promise<void> {
  const rec = await encryptSecret({ plaintext, provider });
  await db
    .insert(apiKeys)
    .values({
      provider,
      kid: rec.kid,
      ciphertext: rec.ciphertext,
      nonce: rec.nonce,
      tag: rec.tag,
      wrappedDek: rec.wrappedDek,
      dekNonce: rec.dekNonce,
      dekTag: rec.dekTag,
    })
    .onConflictDoUpdate({
      target: apiKeys.provider,
      set: {
        kid: rec.kid,
        ciphertext: rec.ciphertext,
        nonce: rec.nonce,
        tag: rec.tag,
        wrappedDek: rec.wrappedDek,
        dekNonce: rec.dekNonce,
        dekTag: rec.dekTag,
        createdAt: new Date(),
        lastUsedAt: null,
      },
    });
}

export async function loadNewsKey(provider: NewsProvider): Promise<string | null> {
  const row = (await db.select().from(apiKeys).where(eq(apiKeys.provider, provider)).limit(1))[0];
  if (!row) return null;
  const rec: EncryptedRecord = {
    ciphertext: row.ciphertext as Buffer,
    nonce: row.nonce as Buffer,
    tag: row.tag as Buffer,
    wrappedDek: row.wrappedDek as Buffer,
    dekNonce: row.dekNonce as Buffer,
    dekTag: row.dekTag as Buffer,
    kid: row.kid,
  };
  await db
    .update(apiKeys)
    .set({ lastUsedAt: new Date() })
    .where(eq(apiKeys.provider, provider));
  return decryptSecret({ record: rec, provider });
}

export async function deleteNewsKey(provider: NewsProvider): Promise<void> {
  await db.delete(apiKeys).where(eq(apiKeys.provider, provider));
}

export async function listSavedNewsProviders(): Promise<
  Array<{ provider: NewsProvider; createdAt: Date; lastUsedAt: Date | null }>
> {
  const rows = await db
    .select({
      provider: apiKeys.provider,
      createdAt: apiKeys.createdAt,
      lastUsedAt: apiKeys.lastUsedAt,
    })
    .from(apiKeys);
  // Filter to news providers only — the table is shared with the LLM vault.
  const { NEWS_PROVIDERS } = await import('./providers');
  const set = new Set<string>(NEWS_PROVIDERS);
  return rows
    .filter((r) => set.has(r.provider))
    .map((r) => ({
      provider: r.provider as NewsProvider,
      createdAt: r.createdAt,
      lastUsedAt: r.lastUsedAt,
    }));
}

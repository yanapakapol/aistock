import 'server-only';
import { eq } from 'drizzle-orm';
import { db } from '@/lib/db/client';
import { apiKeys } from '@/lib/db/schema';
import { encryptSecret, decryptSecret, type EncryptedRecord } from '@/lib/crypto/envelope';
import type { Provider } from './providers';

export async function saveApiKey(provider: Provider, plaintext: string): Promise<void> {
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

export async function loadApiKey(provider: Provider): Promise<string | null> {
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

export async function deleteApiKey(provider: Provider): Promise<void> {
  await db.delete(apiKeys).where(eq(apiKeys.provider, provider));
}

export async function listSavedProviders(): Promise<
  Array<{ provider: Provider; createdAt: Date; lastUsedAt: Date | null }>
> {
  const rows = await db
    .select({
      provider: apiKeys.provider,
      createdAt: apiKeys.createdAt,
      lastUsedAt: apiKeys.lastUsedAt,
    })
    .from(apiKeys);
  return rows as Array<{ provider: Provider; createdAt: Date; lastUsedAt: Date | null }>;
}

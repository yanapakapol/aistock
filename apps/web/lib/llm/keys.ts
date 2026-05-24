import 'server-only';
import { and, eq, isNull } from 'drizzle-orm';
import { db } from '@/lib/db/client';
import { apiKeys } from '@/lib/db/schema';
import { encryptSecret, decryptSecret, type EncryptedRecord } from '@/lib/crypto/envelope';
import { getCurrentUser } from '@/lib/auth/session';
import type { Provider } from './providers';

// Map provider → env-var name. Admin users fall back to these when no vault
// row exists, so the host's own keys can be used without exposing them to
// non-admin users (who see "no key" and must add their own).
const ADMIN_ENV: Record<Provider, string> = {
  openai: 'OPENAI_API_KEY',
  anthropic: 'ANTHROPIC_API_KEY',
  google: 'GOOGLE_GENERATIVE_AI_API_KEY',
  mistral: 'MISTRAL_API_KEY',
  moonshot: 'MOONSHOT_API_KEY',
  deepseek: 'DEEPSEEK_API_KEY',
};

async function uid(): Promise<number | null> {
  const u = await getCurrentUser().catch(() => null);
  return u?.id ?? null;
}

export async function saveApiKey(provider: Provider, plaintext: string): Promise<void> {
  const userId = await uid();
  const rec = await encryptSecret({ plaintext, provider });
  // Delete any existing row for this (userId, provider) — we can't rely on
  // onConflictDoUpdate because the unique index targets a NULLABLE userId
  // column (multi-column unique with NULLs doesn't dedupe predictably).
  const cond = userId == null
    ? and(isNull(apiKeys.userId), eq(apiKeys.provider, provider))
    : and(eq(apiKeys.userId, userId), eq(apiKeys.provider, provider));
  await db.delete(apiKeys).where(cond);
  await db.insert(apiKeys).values({
    userId: userId ?? null,
    provider,
    kid: rec.kid,
    ciphertext: rec.ciphertext,
    nonce: rec.nonce,
    tag: rec.tag,
    wrappedDek: rec.wrappedDek,
    dekNonce: rec.dekNonce,
    dekTag: rec.dekTag,
  });
}

export async function loadApiKey(provider: Provider): Promise<string | null> {
  const u = await getCurrentUser().catch(() => null);
  const userId = u?.id ?? null;
  const cond = userId == null
    ? and(isNull(apiKeys.userId), eq(apiKeys.provider, provider))
    : and(eq(apiKeys.userId, userId), eq(apiKeys.provider, provider));
  const row = (await db.select().from(apiKeys).where(cond).limit(1))[0];
  if (row) {
    const rec: EncryptedRecord = {
      ciphertext: row.ciphertext as Buffer,
      nonce: row.nonce as Buffer,
      tag: row.tag as Buffer,
      wrappedDek: row.wrappedDek as Buffer,
      dekNonce: row.dekNonce as Buffer,
      dekTag: row.dekTag as Buffer,
      kid: row.kid,
    };
    await db.update(apiKeys).set({ lastUsedAt: new Date() }).where(eq(apiKeys.id, row.id));
    return decryptSecret({ record: rec, provider });
  }
  // Admin fallback: use the host's own env-var keys so the admin can run
  // the platform without re-typing keys, while non-admins must bring their
  // own (they can't drain admin's quota).
  if (u?.isAdmin) {
    const env = process.env[ADMIN_ENV[provider]];
    if (env && env.length > 0) return env;
  }
  return null;
}

export async function deleteApiKey(provider: Provider): Promise<void> {
  const userId = await uid();
  const cond = userId == null
    ? and(isNull(apiKeys.userId), eq(apiKeys.provider, provider))
    : and(eq(apiKeys.userId, userId), eq(apiKeys.provider, provider));
  await db.delete(apiKeys).where(cond);
}

export async function listSavedProviders(): Promise<
  Array<{ provider: Provider; createdAt: Date; lastUsedAt: Date | null }>
> {
  const userId = await uid();
  const rows = await db
    .select({
      provider: apiKeys.provider,
      createdAt: apiKeys.createdAt,
      lastUsedAt: apiKeys.lastUsedAt,
    })
    .from(apiKeys)
    .where(userId == null ? isNull(apiKeys.userId) : eq(apiKeys.userId, userId));
  return rows as Array<{ provider: Provider; createdAt: Date; lastUsedAt: Date | null }>;
}

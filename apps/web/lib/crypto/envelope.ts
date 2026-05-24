import 'server-only';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { getKeyProvider } from './keyProvider';

/**
 * Envelope encryption for user secrets (API keys).
 *
 *   plaintext --AES-256-GCM(DEK)-->  ciphertext
 *   DEK       --AES-256-GCM(KEK)-->  wrappedDek
 *
 * KEK comes from KeyProvider (DPAPI / Docker secret / env).
 * DEK is random per record; nonce is random per encryption.
 * AAD binds ciphertext to (provider, kid) so a row-swap is detected at decrypt time.
 *
 * Storage layout (see `api_keys` table):
 *   ciphertext, nonce, tag             -- the key material
 *   wrappedDek, dekNonce, dekTag       -- the DEK wrapped under KEK
 *   kid                                -- KEK identifier (supports rotation)
 */

const ALG = 'aes-256-gcm' as const;
const NONCE_LEN = 12;
const DEK_LEN = 32;

export interface EncryptedRecord {
  ciphertext: Buffer;
  nonce: Buffer;
  tag: Buffer;
  wrappedDek: Buffer;
  dekNonce: Buffer;
  dekTag: Buffer;
  kid: number;
}

export interface EncryptInput {
  plaintext: string;
  provider: string;
  kid?: number;
}

export interface DecryptInput {
  record: EncryptedRecord;
  provider: string;
}

function aad(provider: string, kid: number): Buffer {
  return Buffer.from(`${provider}:${kid}`, 'utf8');
}

export async function encryptSecret({
  plaintext,
  provider,
  kid = 1,
}: EncryptInput): Promise<EncryptedRecord> {
  const kek = await getKeyProvider().getKek();
  const dek = randomBytes(DEK_LEN);

  // Encrypt plaintext with DEK
  const nonce = randomBytes(NONCE_LEN);
  const c = createCipheriv(ALG, dek, nonce);
  c.setAAD(aad(provider, kid));
  const ciphertext = Buffer.concat([c.update(plaintext, 'utf8'), c.final()]);
  const tag = c.getAuthTag();

  // Wrap DEK with KEK (AAD scopes the wrap to the same provider+kid)
  const dekNonce = randomBytes(NONCE_LEN);
  const wc = createCipheriv(ALG, kek, dekNonce);
  wc.setAAD(aad(provider, kid));
  const wrappedDek = Buffer.concat([wc.update(dek), wc.final()]);
  const dekTag = wc.getAuthTag();

  return { ciphertext, nonce, tag, wrappedDek, dekNonce, dekTag, kid };
}

export async function decryptSecret({ record, provider }: DecryptInput): Promise<string> {
  const kek = await getKeyProvider().getKek();

  const wd = createDecipheriv(ALG, kek, record.dekNonce);
  wd.setAAD(aad(provider, record.kid));
  wd.setAuthTag(record.dekTag);
  const dek = Buffer.concat([wd.update(record.wrappedDek), wd.final()]);

  const d = createDecipheriv(ALG, dek, record.nonce);
  d.setAAD(aad(provider, record.kid));
  d.setAuthTag(record.tag);
  const plaintext = Buffer.concat([d.update(record.ciphertext), d.final()]).toString('utf8');

  // Zero the DEK as soon as we're done — best-effort defense in depth.
  dek.fill(0);

  return plaintext;
}

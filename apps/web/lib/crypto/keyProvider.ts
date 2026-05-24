import 'server-only';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomBytes } from 'node:crypto';

/**
 * KeyProvider returns a 32-byte master key (KEK) used to wrap per-record DEKs.
 * Implementations decide *how* the KEK is stored at rest:
 *   - DpapiProvider:        Windows DPAPI (CurrentUser scope, app-constant entropy)
 *   - DockerSecretProvider: file mount at /run/secrets/master_key
 *   - EnvProvider:          MASTER_KEY env var (base64), dev/CI only
 *
 * The KEK never leaves process memory. It is fetched once at boot and cached.
 */
export interface KeyProvider {
  getKek(): Promise<Buffer>;
}

const KEK_LEN = 32;
const APP_ENTROPY = Buffer.from('aistock.v1.master', 'utf8');

class DpapiProvider implements KeyProvider {
  #cached?: Buffer;
  async getKek(): Promise<Buffer> {
    if (this.#cached) return this.#cached;
    // Lazy import — @primno/dpapi is an optionalDependency; only resolves on Windows.
    const { Dpapi } = await import('@primno/dpapi');
    const keyPath = path.join(
      process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming'),
      'aistock',
      'master.key.bin',
    );
    try {
      const blob = await readFile(keyPath);
      const kek = Dpapi.unprotectData(blob, APP_ENTROPY, 'CurrentUser') as Buffer;
      this.#cached = kek;
      return kek;
    } catch {
      const kek = randomBytes(KEK_LEN);
      const blob = Dpapi.protectData(kek, APP_ENTROPY, 'CurrentUser') as Buffer;
      await mkdir(path.dirname(keyPath), { recursive: true });
      await writeFile(keyPath, blob, { mode: 0o600 });
      this.#cached = kek;
      return kek;
    }
  }
}

class DockerSecretProvider implements KeyProvider {
  #cached?: Buffer;
  constructor(private readonly secretPath = '/run/secrets/master_key') {}
  async getKek(): Promise<Buffer> {
    if (this.#cached) return this.#cached;
    const raw = (await readFile(this.secretPath, 'utf8')).trim();
    const kek = Buffer.from(raw, 'base64');
    if (kek.length !== KEK_LEN) {
      throw new Error(`master_key must decode to ${KEK_LEN} bytes (got ${kek.length})`);
    }
    this.#cached = kek;
    return kek;
  }
}

class EnvProvider implements KeyProvider {
  #cached?: Buffer;
  async getKek(): Promise<Buffer> {
    if (this.#cached) return this.#cached;
    const raw = process.env.MASTER_KEY;
    if (!raw) throw new Error('MASTER_KEY is not set (KEY_PROVIDER=env)');
    const kek = Buffer.from(raw, 'base64');
    if (kek.length !== KEK_LEN) {
      throw new Error(`MASTER_KEY must decode to ${KEK_LEN} bytes (got ${kek.length})`);
    }
    this.#cached = kek;
    return kek;
  }
}

let provider: KeyProvider | undefined;

export function getKeyProvider(): KeyProvider {
  if (provider) return provider;
  const which = (process.env.KEY_PROVIDER ?? 'env').toLowerCase();
  switch (which) {
    case 'dpapi':
      if (process.platform !== 'win32') {
        throw new Error('KEY_PROVIDER=dpapi requires Windows');
      }
      provider = new DpapiProvider();
      break;
    case 'docker-secret':
      provider = new DockerSecretProvider();
      break;
    case 'env':
      provider = new EnvProvider();
      break;
    default:
      throw new Error(`Unknown KEY_PROVIDER: ${which}`);
  }
  return provider;
}

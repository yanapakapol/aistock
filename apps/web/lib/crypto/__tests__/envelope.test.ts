import { describe, it, before } from 'node:test';
import { strict as assert } from 'node:assert';
import { randomBytes } from 'node:crypto';
import { encryptSecret, decryptSecret } from '../envelope';

before(() => {
  process.env.KEY_PROVIDER = 'env';
  process.env.MASTER_KEY = randomBytes(32).toString('base64');
});

describe('envelope', () => {
  it('round-trips plaintext', async () => {
    const rec = await encryptSecret({ plaintext: 'sk-test-1234567890', provider: 'openai' });
    const out = await decryptSecret({ record: rec, provider: 'openai' });
    assert.equal(out, 'sk-test-1234567890');
  });

  it('rejects on AAD mismatch (row-swap detection)', async () => {
    const rec = await encryptSecret({ plaintext: 'sk-test', provider: 'openai' });
    await assert.rejects(() => decryptSecret({ record: rec, provider: 'anthropic' }));
  });

  it('produces distinct nonces per encryption', async () => {
    const a = await encryptSecret({ plaintext: 'x', provider: 'openai' });
    const b = await encryptSecret({ plaintext: 'x', provider: 'openai' });
    assert.notEqual(a.nonce.toString('hex'), b.nonce.toString('hex'));
    assert.notEqual(a.dekNonce.toString('hex'), b.dekNonce.toString('hex'));
    assert.notEqual(a.wrappedDek.toString('hex'), b.wrappedDek.toString('hex'));
  });
});

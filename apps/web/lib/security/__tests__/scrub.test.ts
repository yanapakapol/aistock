import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scrubSecrets, sanitizeError } from '../scrub';

test('redacts OpenAI-style sk- keys', () => {
  const input = 'Authorization: Bearer sk-abcdef0123456789ABCDEF';
  const out = scrubSecrets(input) as string;
  assert.ok(!out.includes('sk-abcdef0123456789ABCDEF'), 'raw key still present');
  assert.ok(out.includes('[REDACTED]'));
});

test('redacts Anthropic sk-ant- keys', () => {
  const input = 'key=sk-ant-api03-AAAA1111BBBB2222CCCC3333';
  const out = scrubSecrets(input) as string;
  assert.ok(!out.includes('sk-ant-api03-AAAA1111BBBB2222CCCC3333'));
  assert.ok(out.includes('[REDACTED]'));
});

test('redacts Google AIza keys', () => {
  const input = 'apiKey: AIzaSyD-EXAMPLE_KEY_1234567890abcd';
  const out = scrubSecrets(input) as string;
  assert.ok(!out.includes('AIzaSyD-EXAMPLE_KEY_1234567890abcd'));
});

test('redacts generic high-entropy token near "token"', () => {
  const tok = 'A1B2C3D4E5F6G7H8I9J0K1L2M3N4O5P6';
  const input = `Authorization token=${tok}`;
  const out = scrubSecrets(input) as string;
  assert.ok(!out.includes(tok));
  assert.ok(out.includes('[REDACTED]'));
});

test('leaves high-entropy token alone when no trigger word nearby', () => {
  const tok = 'A1B2C3D4E5F6G7H8I9J0K1L2M3N4O5P6';
  const input = `commit hash ${tok} landed today`;
  const out = scrubSecrets(input) as string;
  assert.equal(out, input);
});

test('drops authorization / x-api-key / cookie headers from objects', () => {
  const input = {
    url: 'https://api.openai.com/v1/models',
    headers: {
      Authorization: 'Bearer sk-xxxx',
      'X-Api-Key': 'whatever-32-chars-of-content-here',
      Cookie: 'session=abc',
      'Set-Cookie': 'session=xyz',
      'User-Agent': 'aistock/1.0',
    },
  };
  const out = scrubSecrets(input) as { headers: Record<string, string> };
  assert.equal(out.headers.Authorization, undefined);
  assert.equal(out.headers['X-Api-Key'], undefined);
  assert.equal(out.headers.Cookie, undefined);
  assert.equal(out.headers['Set-Cookie'], undefined);
  assert.equal(out.headers['User-Agent'], 'aistock/1.0');
});

test('recurses into nested arrays/objects', () => {
  const input = {
    results: [{ note: 'token: A1B2C3D4E5F6G7H8I9J0K1L2M3N4O5P6' }, { ok: true }],
  };
  const out = scrubSecrets(input) as { results: Array<{ note?: string; ok?: boolean }> };
  assert.ok(out.results[0].note!.includes('[REDACTED]'));
  assert.equal(out.results[1].ok, true);
});

test('handles cycles without crashing', () => {
  const a: Record<string, unknown> = { name: 'a' };
  a.self = a;
  const out = scrubSecrets(a) as { name: string; self: unknown };
  assert.equal(out.name, 'a');
  assert.equal(out.self, '[Circular]');
});

test('sanitizeError keeps only status/code/message and scrubs message', () => {
  const err = Object.assign(new Error('failed: sk-abcdef0123456789ABCDEF'), {
    status: 401,
    code: 'unauthorized',
    response: { headers: { authorization: 'Bearer secret' } },
    stack: 'should not appear',
  });
  const out = sanitizeError(err);
  assert.equal(out.status, 401);
  assert.equal(out.code, 'unauthorized');
  assert.ok(out.message.includes('[REDACTED]'));
  assert.ok(!out.message.includes('sk-abcdef0123456789ABCDEF'));
  assert.equal(Object.keys(out).sort().join(','), 'code,message,status');
});

test('sanitizeError on a plain string', () => {
  const out = sanitizeError('boom: AIzaSyD-EXAMPLE_KEY_1234567890abcd');
  assert.ok(out.message.includes('[REDACTED]'));
});

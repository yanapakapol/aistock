import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chunk } from '../chunker';

test('returns empty array on empty input', () => {
  assert.deepEqual(chunk(''), []);
  assert.deepEqual(chunk('   \n\n  '), []);
});

test('keeps short text as a single chunk', () => {
  const out = chunk('Hello world.');
  assert.equal(out.length, 1);
  assert.equal(out[0], 'Hello world.');
});

test('splits by paragraph and respects target size', () => {
  // 5 paragraphs of ~200 chars each → with target=700 we expect 2-3 chunks.
  const para = 'x'.repeat(200);
  const text = Array(5).fill(para).join('\n\n');
  const out = chunk(text, { target: 700, overlap: 80 });
  assert.ok(out.length >= 2, 'expected at least 2 chunks');
  // Allow target + overlap + small slack for the "\n\n" join used between pieces.
  for (const c of out) {
    assert.ok(c.length <= 700 + 80 + 4, `chunk too long: ${c.length}`);
  }
});

test('hard-splits a single paragraph longer than target', () => {
  const big = 'a'.repeat(2000);
  const out = chunk(big, { target: 500, overlap: 50 });
  assert.ok(out.length >= 4, `expected >=4 chunks, got ${out.length}`);
  for (const c of out) {
    assert.ok(c.length <= 500 + 50 + 4, `chunk too long: ${c.length}`);
  }
});

test('consecutive chunks share overlap characters', () => {
  // Use a paragraph just over `target` so we get a clean A then overlap+B split.
  const a = 'A'.repeat(400);
  const b = 'B'.repeat(400);
  const out = chunk(`${a}\n\n${b}`, { target: 450, overlap: 60 });
  assert.ok(out.length >= 2, `expected >=2 chunks, got ${out.length}`);
  const tail = out[0]!.slice(-30);
  // Second chunk should start with characters from the tail of the first.
  // We don't pin to an exact overlap length (paragraph joins can shift it),
  // but at least *some* overlap must be present.
  assert.ok(
    out[1]!.includes(tail.slice(-10)),
    'expected second chunk to share a tail snippet with the first',
  );
});

test('honors custom small target', () => {
  const text = 'one two three four five six seven eight nine ten eleven twelve';
  const out = chunk(text, { target: 20, overlap: 5 });
  assert.ok(out.length > 1);
  // Carry-forward overlap + a "\n\n" join can push a chunk slightly above target.
  for (const c of out) {
    assert.ok(c.length <= 20 + 5 + 4, `chunk too long: ${c.length}`);
  }
});

test('normalizes Windows line endings', () => {
  const text = 'para one.\r\n\r\npara two.';
  const out = chunk(text);
  assert.equal(out.length, 1);
  assert.ok(out[0]!.includes('para one.'));
  assert.ok(out[0]!.includes('para two.'));
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeMarkdown } from '../sanitize';

test('strips a sole `---` separator line', () => {
  const input = 'first paragraph\n---\nsecond paragraph\n';
  const out = sanitizeMarkdown(input);
  assert.ok(!out.includes('---'), `unexpected --- in: ${out}`);
  assert.ok(out.includes('first paragraph'));
  assert.ok(out.includes('second paragraph'));
});

test('strips a sole `***` separator line', () => {
  const input = 'alpha\n***\nbeta\n';
  const out = sanitizeMarkdown(input);
  assert.ok(!out.includes('***'));
  assert.ok(out.includes('alpha'));
  assert.ok(out.includes('beta'));
});

test('strips `___` and `===` ornamental rules', () => {
  const a = sanitizeMarkdown('one\n___\ntwo\n');
  const b = sanitizeMarkdown('one\n====\ntwo\n');
  assert.ok(!a.includes('___'));
  assert.ok(!b.includes('==='));
});

test('strips `// commentary` line comments', () => {
  const input = 'real content\n// some LLM aside\nmore content\n';
  const out = sanitizeMarkdown(input);
  assert.ok(!out.includes('// some LLM aside'));
  assert.ok(out.includes('real content'));
  assert.ok(out.includes('more content'));
});

test('collapses 3+ consecutive blank lines to 2', () => {
  const input = 'a\n\n\n\n\nb\n';
  const out = sanitizeMarkdown(input);
  // Between a and b we should see exactly two blank lines = three newlines
  // (one ending `a`, two blanks, then `b`).
  assert.match(out, /a\n\n\nb/);
  assert.ok(!/\n{4}/.test(out), `still has 4+ consecutive newlines: ${JSON.stringify(out)}`);
});

test('normalizes smart quotes to ASCII', () => {
  const input = '“hello” and ‘world’\n';
  const out = sanitizeMarkdown(input);
  assert.ok(out.includes('"hello"'));
  assert.ok(out.includes("'world'"));
  assert.ok(!/[“”‘’]/.test(out));
});

test('preserves fenced code block content verbatim', () => {
  const code = [
    '```ts',
    '// this comment is INSIDE a fence and must survive',
    'const x = "smart “quote” stays";',
    '---',
    '***',
    '```',
  ].join('\n');
  const input = `before\n${code}\nafter\n`;
  const out = sanitizeMarkdown(input);
  assert.ok(out.includes('// this comment is INSIDE a fence and must survive'));
  assert.ok(out.includes('“quote”'));
  // The ornamental `---`/`***` lines INSIDE the fence must remain.
  const fenceStart = out.indexOf('```ts');
  const fenceEnd = out.indexOf('```', fenceStart + 5);
  const inner = out.slice(fenceStart, fenceEnd);
  assert.ok(inner.includes('---'));
  assert.ok(inner.includes('***'));
});

test('drops empty headings but keeps real ones', () => {
  const input = '# real heading\n##\n###    \nbody\n';
  const out = sanitizeMarkdown(input);
  assert.ok(out.includes('# real heading'));
  assert.ok(!/^##\s*$/m.test(out));
  assert.ok(!/^###\s*$/m.test(out));
});

test('strips trailing whitespace per line', () => {
  const input = 'line one   \nline two\t\t\n';
  const out = sanitizeMarkdown(input);
  assert.ok(!/[ \t]+\n/.test(out));
});

test('stripEmojis removes surrogate-pair codepoints when opted in', () => {
  const input = 'hello 🚀 rocket world\n';
  const withEmoji = sanitizeMarkdown(input);
  const withoutEmoji = sanitizeMarkdown(input, { stripEmojis: true });
  assert.ok(withEmoji.includes('🚀'));
  assert.ok(!withoutEmoji.includes('🚀'));
  assert.ok(withoutEmoji.includes('hello'));
  assert.ok(withoutEmoji.includes('rocket world'));
});

test('handles CRLF line endings', () => {
  const input = 'a\r\n---\r\nb\r\n';
  const out = sanitizeMarkdown(input);
  assert.ok(!out.includes('---'));
  assert.ok(out.includes('a'));
  assert.ok(out.includes('b'));
});

test('empty input yields empty output', () => {
  assert.equal(sanitizeMarkdown(''), '');
});

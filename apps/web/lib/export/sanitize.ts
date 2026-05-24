/**
 * Markdown sanitizer for export pipeline.
 *
 * Cleans common LLM-output cruft (ornamental separators, smart quotes,
 * `//` line comments, empty headings, runaway blank lines, optional emojis)
 * while leaving fenced code blocks untouched.
 *
 * Pure function, no I/O — safe to call from any runtime.
 */

export interface SanitizeOptions {
  /** When true, strip surrogate-pair codepoints (covers most emoji ranges). */
  stripEmojis?: boolean;
}

// Lines that, when they are the entire trimmed content of a line, are pure
// ornamental separators emitted by chat LLMs between sections. Real markdown
// horizontal rules use `---` but the export pipeline relies on explicit
// `\n` between sections, so we drop these unconditionally.
const ORNAMENTAL_LINE = /^(?:-{3,}|\*{3,}|_{3,}|={3,}|\/\/)$/;

// Empty heading: `#`, `##`, ... with nothing (or only whitespace) after.
const EMPTY_HEADING = /^#{1,6}\s*$/;

// Single-line `// ...` comment at the very start of a line.
const SLASH_SLASH_COMMENT = /^\/\/.*$/;

// Surrogate pair range covers most emoji (U+1F000+ encoded as UTF-16 pair).
const SURROGATE_PAIR = /[\uD800-\uDBFF][\uDC00-\uDFFF]/g;

// Smart punctuation -> ASCII.
const SMART_QUOTES: Array<[RegExp, string]> = [
  [/[“”„‟]/g, '"'], // " " „ ‟
  [/[‘’‚‛]/g, "'"], // ' ' ‚ ‛
  [/[′]/g, "'"], // prime
  [/[″]/g, '"'], // double prime
];

function isFenceLine(line: string): boolean {
  // Markdown code fence: three or more backticks or tildes, optionally with info string.
  return /^\s{0,3}(?:`{3,}|~{3,})/.test(line);
}

function normalizeSmartQuotes(s: string): string {
  let out = s;
  for (const [re, repl] of SMART_QUOTES) out = out.replace(re, repl);
  return out;
}

export function sanitizeMarkdown(input: string, opts: SanitizeOptions = {}): string {
  if (!input) return '';

  // Normalize line endings.
  const src = input.replace(/\r\n?/g, '\n');
  const lines = src.split('\n');

  const out: string[] = [];
  let inFence = false;
  let fenceMarker = '';

  for (const raw of lines) {
    // Track fenced code blocks — passthrough verbatim.
    if (isFenceLine(raw)) {
      if (!inFence) {
        inFence = true;
        fenceMarker = raw.trim().startsWith('~') ? '~' : '`';
      } else {
        // Closing fence must match the opener's character.
        if (raw.trim().startsWith(fenceMarker)) {
          inFence = false;
          fenceMarker = '';
        }
      }
      out.push(raw);
      continue;
    }

    if (inFence) {
      out.push(raw);
      continue;
    }

    // Strip trailing whitespace per line.
    let line = raw.replace(/[ \t]+$/g, '');

    // Smart quotes -> ASCII.
    line = normalizeSmartQuotes(line);

    // Optional emoji strip.
    if (opts.stripEmojis) {
      line = line.replace(SURROGATE_PAIR, '');
    }

    const trimmed = line.trim();

    // Drop ornamental separator lines entirely.
    if (ORNAMENTAL_LINE.test(trimmed)) continue;

    // Drop `// commentary` style line comments at start of line.
    if (SLASH_SLASH_COMMENT.test(line)) continue;

    // Drop empty headings.
    if (EMPTY_HEADING.test(trimmed)) continue;

    out.push(line);
  }

  // Collapse 3+ consecutive blank lines to exactly 2 (one blank line between blocks).
  const collapsed: string[] = [];
  let blankRun = 0;
  for (const line of out) {
    if (line.trim() === '') {
      blankRun++;
      if (blankRun <= 2) collapsed.push(line);
    } else {
      blankRun = 0;
      collapsed.push(line);
    }
  }

  // Trim leading/trailing blank lines, but leave a trailing newline.
  while (collapsed.length && collapsed[0].trim() === '') collapsed.shift();
  while (collapsed.length && collapsed[collapsed.length - 1].trim() === '') collapsed.pop();

  return collapsed.join('\n') + (collapsed.length ? '\n' : '');
}

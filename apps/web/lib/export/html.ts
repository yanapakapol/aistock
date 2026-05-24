/**
 * Pure-JS markdown -> self-contained HTML renderer.
 *
 * Replaces the old pandoc + typst PDF path. Vercel's serverless runtime has
 * no shell binaries, and bundling a true PDF engine (e.g. @react-pdf/renderer,
 * ~600 KB) bloats every cold start. Trade-off chosen here:
 *
 *   - We render markdown to a self-contained HTML document with one inline
 *     `<style>` block (no external resources, no scripts) and a print
 *     stylesheet tuned for letter-size pages.
 *   - For `format=pdf` requests the route serves this HTML inline with a
 *     `Content-Type: text/html` response and a hint filename. The user
 *     prints to PDF via the browser (Ctrl/Cmd+P -> Save as PDF), which
 *     produces a clean result by virtue of the `@media print` block below.
 *
 * If true server-side PDF becomes a requirement, swap this implementation
 * for `@react-pdf/renderer` or a headless-chromium worker; the route's
 * public contract stays identical.
 */

import type { Token, Tokens } from 'marked';

export interface HtmlOptions {
  title?: string;
}

/** Build a complete HTML document (with <!DOCTYPE>) from sanitized markdown. */
export async function mdToHtml(md: string, opts: HtmlOptions = {}): Promise<string> {
  const { lexer } = await import('marked');
  const tokens = lexer(md);
  const body = renderBlocks(tokens);
  const title = escapeHtml(opts.title ?? 'Document');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${title}</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  :root {
    --fg: #1f2328;
    --muted: #57606a;
    --accent: #0969da;
    --border: #d0d7de;
    --code-bg: #f6f8fa;
  }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif;
    color: var(--fg);
    line-height: 1.55;
    background: #ffffff;
  }
  main {
    max-width: 780px;
    margin: 0 auto;
    padding: 48px 56px 96px;
  }
  h1, h2, h3, h4, h5, h6 {
    margin: 1.6em 0 0.5em;
    line-height: 1.25;
    font-weight: 600;
  }
  h1 { font-size: 2em; border-bottom: 1px solid var(--border); padding-bottom: 0.3em; }
  h2 { font-size: 1.5em; border-bottom: 1px solid var(--border); padding-bottom: 0.3em; }
  h3 { font-size: 1.25em; }
  h4 { font-size: 1em; }
  h5 { font-size: 0.875em; }
  h6 { font-size: 0.85em; color: var(--muted); }
  p { margin: 0 0 1em; }
  a { color: var(--accent); text-decoration: underline; }
  ul, ol { margin: 0 0 1em; padding-left: 2em; }
  li { margin: 0.2em 0; }
  blockquote {
    margin: 0 0 1em;
    padding: 0.4em 1em;
    border-left: 4px solid var(--border);
    color: var(--muted);
  }
  hr {
    border: 0;
    border-top: 1px solid var(--border);
    margin: 2em 0;
  }
  code {
    font-family: "SFMono-Regular", Consolas, "Liberation Mono", Menlo, monospace;
    font-size: 0.9em;
    background: var(--code-bg);
    padding: 0.15em 0.35em;
    border-radius: 4px;
  }
  pre {
    background: var(--code-bg);
    padding: 14px 16px;
    border-radius: 6px;
    overflow: auto;
    line-height: 1.45;
    margin: 0 0 1em;
  }
  pre code {
    background: transparent;
    padding: 0;
    font-size: 0.85em;
  }
  table {
    border-collapse: collapse;
    margin: 0 0 1em;
    width: 100%;
    font-size: 0.95em;
  }
  th, td {
    border: 1px solid var(--border);
    padding: 6px 12px;
    text-align: left;
    vertical-align: top;
  }
  th { background: var(--code-bg); font-weight: 600; }
  td.align-center, th.align-center { text-align: center; }
  td.align-right, th.align-right { text-align: right; }
  img { max-width: 100%; height: auto; }
  del { text-decoration: line-through; color: var(--muted); }

  @media print {
    @page { size: letter; margin: 0.75in; }
    body { font-size: 11pt; }
    main { max-width: none; margin: 0; padding: 0; }
    a { color: var(--fg); text-decoration: none; }
    a[href]::after { content: " (" attr(href) ")"; color: var(--muted); font-size: 0.85em; }
    pre, blockquote, table, img { break-inside: avoid; }
    h1, h2, h3, h4, h5, h6 { break-after: avoid; }
  }
</style>
</head>
<body>
<main>
${body}
</main>
</body>
</html>
`;
}

// --- token -> HTML translation ---------------------------------------------

function renderBlocks(tokens: Token[]): string {
  return tokens.map(renderBlock).join('');
}

function renderBlock(token: Token): string {
  switch (token.type) {
    case 'heading': {
      const t = token as Tokens.Heading;
      const level = Math.min(Math.max(t.depth, 1), 6);
      return `<h${level}>${renderInline(t.tokens)}</h${level}>\n`;
    }
    case 'paragraph': {
      const t = token as Tokens.Paragraph;
      return `<p>${renderInline(t.tokens)}</p>\n`;
    }
    case 'blockquote': {
      const t = token as Tokens.Blockquote;
      return `<blockquote>\n${renderBlocks(t.tokens)}</blockquote>\n`;
    }
    case 'list': {
      const t = token as Tokens.List;
      const tag = t.ordered ? 'ol' : 'ul';
      const startAttr =
        t.ordered && t.start !== '' && t.start !== 1 ? ` start="${t.start}"` : '';
      const items = t.items.map((item) => renderListItem(item, t.loose)).join('');
      return `<${tag}${startAttr}>\n${items}</${tag}>\n`;
    }
    case 'code': {
      const t = token as Tokens.Code;
      const langClass = t.lang ? ` class="language-${escapeHtml(t.lang)}"` : '';
      return `<pre><code${langClass}>${escapeHtml(t.text)}</code></pre>\n`;
    }
    case 'hr':
      return `<hr>\n`;
    case 'table': {
      const t = token as Tokens.Table;
      const head = t.header
        .map((cell, i) => {
          const align = t.align[i];
          const cls = align ? ` class="align-${align}"` : '';
          return `<th${cls}>${renderInline(cell.tokens)}</th>`;
        })
        .join('');
      const body = t.rows
        .map((row) => {
          const cells = row
            .map((cell, i) => {
              const align = t.align[i];
              const cls = align ? ` class="align-${align}"` : '';
              return `<td${cls}>${renderInline(cell.tokens)}</td>`;
            })
            .join('');
          return `<tr>${cells}</tr>`;
        })
        .join('\n');
      return `<table>\n<thead><tr>${head}</tr></thead>\n<tbody>\n${body}\n</tbody>\n</table>\n`;
    }
    case 'html': {
      // Pass through cautiously: we already ran sanitize on the markdown.
      // For safety we still escape — exporting AI output as live HTML
      // would be a needless XSS vector when the user prints to PDF in a
      // separate context.
      const t = token as Tokens.HTML;
      return `<pre>${escapeHtml(t.text)}</pre>\n`;
    }
    case 'space':
      return '';
    default: {
      const anyTok = token as { text?: string; raw?: string };
      const text = anyTok.text ?? anyTok.raw ?? '';
      return text.trim() ? `<p>${escapeHtml(text)}</p>\n` : '';
    }
  }
}

function renderListItem(item: Tokens.ListItem, loose: boolean): string {
  // For "tight" lists (loose=false) we strip the wrapping <p> that marked
  // would otherwise emit for the item's body so list items render compactly.
  let inner: string;
  if (loose) {
    inner = renderBlocks(item.tokens);
  } else {
    inner = item.tokens
      .map((sub) => {
        if (sub.type === 'paragraph') {
          return renderInline((sub as Tokens.Paragraph).tokens);
        }
        if (sub.type === 'text') {
          const t = sub as Tokens.Text;
          return t.tokens ? renderInline(t.tokens) : escapeHtml(t.text);
        }
        return renderBlock(sub);
      })
      .join('');
  }
  const checkbox =
    item.task && typeof item.checked === 'boolean'
      ? `<input type="checkbox" disabled${item.checked ? ' checked' : ''}> `
      : '';
  return `<li>${checkbox}${inner}</li>\n`;
}

function renderInline(tokens: Token[] | undefined): string {
  if (!tokens) return '';
  return tokens.map(renderInlineToken).join('');
}

function renderInlineToken(token: Token): string {
  switch (token.type) {
    case 'text': {
      const t = token as Tokens.Text;
      if (t.tokens && t.tokens.length) return renderInline(t.tokens);
      return escapeHtml(t.text);
    }
    case 'strong': {
      const t = token as Tokens.Strong;
      return `<strong>${renderInline(t.tokens)}</strong>`;
    }
    case 'em': {
      const t = token as Tokens.Em;
      return `<em>${renderInline(t.tokens)}</em>`;
    }
    case 'del': {
      const t = token as Tokens.Del;
      return `<del>${renderInline(t.tokens)}</del>`;
    }
    case 'codespan': {
      const t = token as Tokens.Codespan;
      return `<code>${escapeHtml(t.text)}</code>`;
    }
    case 'link': {
      const t = token as Tokens.Link;
      const href = escapeAttr(t.href);
      const title = t.title ? ` title="${escapeAttr(t.title)}"` : '';
      const body = t.tokens && t.tokens.length ? renderInline(t.tokens) : escapeHtml(t.text);
      return `<a href="${href}"${title}>${body}</a>`;
    }
    case 'image': {
      const t = token as Tokens.Image;
      const src = escapeAttr(t.href);
      const alt = escapeAttr(t.text ?? '');
      const title = t.title ? ` title="${escapeAttr(t.title)}"` : '';
      return `<img src="${src}" alt="${alt}"${title}>`;
    }
    case 'br':
      return '<br>';
    case 'escape': {
      const t = token as Tokens.Escape;
      return escapeHtml(t.text);
    }
    case 'html': {
      // Escape — see note in renderBlock.
      const t = token as Tokens.Tag;
      return escapeHtml(t.text ?? '');
    }
    default: {
      const anyTok = token as { text?: string; raw?: string; tokens?: Token[] };
      if (anyTok.tokens && anyTok.tokens.length) return renderInline(anyTok.tokens);
      return escapeHtml(anyTok.text ?? anyTok.raw ?? '');
    }
  }
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function escapeAttr(s: string): string {
  return escapeHtml(s);
}

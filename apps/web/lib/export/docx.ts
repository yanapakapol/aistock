/**
 * Pure-JS markdown -> DOCX renderer.
 *
 * Replaces the old pandoc subprocess wrapper. Designed for Vercel's Linux
 * serverless runtime where shell binaries (pandoc / typst) aren't available.
 *
 * The `docx` and `marked` deps are heavy (~250 KB + ~50 KB combined). To keep
 * them out of every other route's bundle, we lazy-import them inside the
 * single exported builder function — only the export route pulls them in.
 *
 * Feature coverage is intentionally pragmatic: headings (h1-h6), paragraphs
 * with inline formatting (bold/italic/code/strikethrough/links), bullet and
 * ordered lists (one level), block quotes, code blocks, horizontal rules,
 * and tables. Images and HTML passthrough are rendered as their alt/raw text.
 */

import type {
  Paragraph as ParagraphT,
  Table as TableT,
  TableRow as TableRowT,
  TextRun as TextRunT,
  IRunOptions,
} from 'docx';
import type { Token, Tokens } from 'marked';

export interface DocxOptions {
  /** Document title metadata (sets `<w:title>`). */
  title?: string;
}

/** Build a DOCX file from sanitized markdown. Returns the raw bytes. */
export async function mdToDocx(md: string, opts: DocxOptions = {}): Promise<Buffer> {
  // Lazy-load — keeps the dep out of unrelated route bundles.
  const docx = await import('docx');
  const { lexer } = await import('marked');

  const tokens = lexer(md);
  const children = tokensToBlocks(tokens, docx);

  const doc = new docx.Document({
    title: opts.title,
    creator: 'aistock export',
    numbering: {
      config: [
        {
          reference: 'aistock-ordered',
          levels: [
            {
              level: 0,
              format: docx.LevelFormat.DECIMAL,
              text: '%1.',
              alignment: docx.AlignmentType.LEFT,
              style: {
                paragraph: { indent: { left: 720, hanging: 360 } },
              },
            },
          ],
        },
      ],
    },
    sections: [
      {
        properties: {},
        children: children.length
          ? children
          : [new docx.Paragraph({ children: [new docx.TextRun('')] })],
      },
    ],
  });

  return docx.Packer.toBuffer(doc);
}

// --- token -> docx translation ---------------------------------------------

type DocxNs = typeof import('docx');
type Block = ParagraphT | TableT;

function tokensToBlocks(tokens: Token[], d: DocxNs): Block[] {
  const out: Block[] = [];
  for (const tok of tokens) {
    const blocks = tokenToBlocks(tok, d);
    for (const b of blocks) out.push(b);
  }
  return out;
}

function tokenToBlocks(token: Token, d: DocxNs): Block[] {
  switch (token.type) {
    case 'heading': {
      const t = token as Tokens.Heading;
      const level = Math.min(Math.max(t.depth, 1), 6);
      const headingLevel = (
        [
          d.HeadingLevel.HEADING_1,
          d.HeadingLevel.HEADING_2,
          d.HeadingLevel.HEADING_3,
          d.HeadingLevel.HEADING_4,
          d.HeadingLevel.HEADING_5,
          d.HeadingLevel.HEADING_6,
        ] as const
      )[level - 1];
      return [
        new d.Paragraph({
          heading: headingLevel,
          children: inlineRuns(t.tokens ?? [{ type: 'text', raw: t.text, text: t.text }], d),
        }),
      ];
    }

    case 'paragraph': {
      const t = token as Tokens.Paragraph;
      return [
        new d.Paragraph({
          children: inlineRuns(t.tokens, d),
        }),
      ];
    }

    case 'blockquote': {
      const t = token as Tokens.Blockquote;
      // Re-render inner tokens, styling paragraphs as IntenseQuote.
      const styled: Block[] = [];
      for (const sub of t.tokens) {
        if (sub.type === 'paragraph') {
          const p = sub as Tokens.Paragraph;
          styled.push(
            new d.Paragraph({
              style: 'IntenseQuote',
              children: inlineRuns(p.tokens, d),
            }),
          );
        } else {
          for (const b of tokenToBlocks(sub, d)) styled.push(b);
        }
      }
      return styled.length ? styled : tokensToBlocks(t.tokens, d);
    }

    case 'list': {
      const t = token as Tokens.List;
      const blocks: Block[] = [];
      for (const item of t.items) {
        blocks.push(
          new d.Paragraph({
            children: listItemRuns(item, d),
            bullet: t.ordered ? undefined : { level: 0 },
            numbering: t.ordered
              ? { reference: 'aistock-ordered', level: 0 }
              : undefined,
          }),
        );
      }
      return blocks;
    }

    case 'code': {
      const t = token as Tokens.Code;
      // Each line becomes its own paragraph so DOCX doesn't reflow it.
      return t.text.split('\n').map(
        (line) =>
          new d.Paragraph({
            children: [
              new d.TextRun({
                text: line || ' ',
                font: 'Consolas',
                size: 20, // 10pt (half-points)
              }),
            ],
          }),
      );
    }

    case 'hr':
      return [
        new d.Paragraph({
          border: {
            bottom: {
              color: '999999',
              style: d.BorderStyle.SINGLE,
              size: 6,
              space: 1,
            },
          },
          children: [],
        }),
      ];

    case 'table': {
      const t = token as Tokens.Table;
      const rows: TableRowT[] = [];
      // Header row
      rows.push(
        new d.TableRow({
          tableHeader: true,
          children: t.header.map(
            (cell) =>
              new d.TableCell({
                children: [
                  new d.Paragraph({
                    children: inlineRuns(cell.tokens, d, { bold: true }),
                  }),
                ],
              }),
          ),
        }),
      );
      // Body rows
      for (const row of t.rows) {
        rows.push(
          new d.TableRow({
            children: row.map(
              (cell) =>
                new d.TableCell({
                  children: [
                    new d.Paragraph({ children: inlineRuns(cell.tokens, d) }),
                  ],
                }),
            ),
          }),
        );
      }
      return [
        new d.Table({
          rows,
          width: { size: 100, type: d.WidthType.PERCENTAGE },
        }),
      ];
    }

    case 'space':
      return [];

    case 'html': {
      // Render raw HTML as a plain paragraph of its text — markdown sanitize
      // already drops most LLM-injected HTML so this rarely fires.
      const t = token as Tokens.HTML;
      const text = t.text.trim();
      if (!text) return [];
      return [new d.Paragraph({ children: [new d.TextRun(text)] })];
    }

    default: {
      // Fallback: render token's raw text if available.
      const anyTok = token as { raw?: string; text?: string };
      const text = anyTok.text ?? anyTok.raw ?? '';
      if (!text.trim()) return [];
      return [new d.Paragraph({ children: [new d.TextRun(text)] })];
    }
  }
}

function listItemRuns(item: Tokens.ListItem, d: DocxNs): TextRunT[] {
  // A list item's `tokens` typically contains a single `text` token whose own
  // `tokens` field holds the inline runs. Flatten one level if needed.
  const inner: Token[] = [];
  for (const sub of item.tokens) {
    if (sub.type === 'text' && (sub as Tokens.Text).tokens) {
      inner.push(...((sub as Tokens.Text).tokens as Token[]));
    } else if (sub.type === 'paragraph') {
      inner.push(...(sub as Tokens.Paragraph).tokens);
    } else {
      inner.push(sub);
    }
  }
  return inlineRuns(inner, d);
}

function inlineRuns(
  tokens: Token[] | undefined,
  d: DocxNs,
  base: Partial<IRunOptions> = {},
): TextRunT[] {
  if (!tokens || tokens.length === 0) return [new d.TextRun({ text: '', ...base })];
  const runs: TextRunT[] = [];
  walkInline(tokens, d, base, runs);
  return runs.length ? runs : [new d.TextRun({ text: '', ...base })];
}

function walkInline(
  tokens: Token[],
  d: DocxNs,
  style: Partial<IRunOptions>,
  out: TextRunT[],
): void {
  for (const tok of tokens) {
    switch (tok.type) {
      case 'text': {
        const t = tok as Tokens.Text;
        if (t.tokens && t.tokens.length) {
          walkInline(t.tokens, d, style, out);
        } else {
          out.push(new d.TextRun({ text: t.text, ...style }));
        }
        break;
      }
      case 'strong': {
        const t = tok as Tokens.Strong;
        walkInline(t.tokens, d, { ...style, bold: true }, out);
        break;
      }
      case 'em': {
        const t = tok as Tokens.Em;
        walkInline(t.tokens, d, { ...style, italics: true }, out);
        break;
      }
      case 'del': {
        const t = tok as Tokens.Del;
        walkInline(t.tokens, d, { ...style, strike: true }, out);
        break;
      }
      case 'codespan': {
        const t = tok as Tokens.Codespan;
        out.push(
          new d.TextRun({
            text: t.text,
            font: 'Consolas',
            size: 20,
            ...style,
          }),
        );
        break;
      }
      case 'link': {
        const t = tok as Tokens.Link;
        // Render link as styled text (blue + underline). Embedding a real
        // hyperlink relationship is possible but adds bulk; this reads fine.
        const linkStyle: Partial<IRunOptions> = {
          ...style,
          color: '0563C1',
          underline: {},
        };
        if (t.tokens && t.tokens.length) {
          walkInline(t.tokens, d, linkStyle, out);
        } else {
          out.push(new d.TextRun({ text: t.text || t.href, ...linkStyle }));
        }
        break;
      }
      case 'image': {
        const t = tok as Tokens.Image;
        out.push(new d.TextRun({ text: t.text || t.href, ...style }));
        break;
      }
      case 'br':
        out.push(new d.TextRun({ text: '', break: 1, ...style }));
        break;
      case 'escape': {
        const t = tok as Tokens.Escape;
        out.push(new d.TextRun({ text: t.text, ...style }));
        break;
      }
      case 'html': {
        const t = tok as Tokens.Tag;
        const text = (t.text ?? '').trim();
        if (text) out.push(new d.TextRun({ text, ...style }));
        break;
      }
      default: {
        const anyTok = tok as { raw?: string; text?: string; tokens?: Token[] };
        if (anyTok.tokens && anyTok.tokens.length) {
          walkInline(anyTok.tokens, d, style, out);
        } else if (anyTok.text) {
          out.push(new d.TextRun({ text: anyTok.text, ...style }));
        } else if (anyTok.raw) {
          out.push(new d.TextRun({ text: anyTok.raw, ...style }));
        }
      }
    }
  }
}

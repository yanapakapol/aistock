import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';

import { sanitizeMarkdown } from '@/lib/export/sanitize';
import { sanitizeError } from '@/lib/security/scrub';

export const runtime = 'nodejs';
export const maxDuration = 60;

/**
 * Export contract
 * ---------------
 * POST { format, filename, content, stripEmojis?, title? }
 *
 *   format: 'md'   -> text/markdown; charset=utf-8                (attachment)
 *           'docx' -> application/vnd.openxmlformats-...document  (attachment)
 *           'html' -> text/html; charset=utf-8                    (attachment)
 *           'pdf'  -> text/html; charset=utf-8                    (inline)
 *                     This is intentional: we ship a self-contained styled
 *                     HTML document with an `@media print` stylesheet. The
 *                     client opens it inline and the user prints to PDF via
 *                     the browser (Ctrl/Cmd+P -> Save as PDF). This avoids
 *                     bundling a ~600 KB PDF engine (@react-pdf/renderer) or
 *                     relying on shell binaries (pandoc/typst) that don't
 *                     exist on Vercel's serverless runtime.
 *
 * Heavy renderers (`docx`, `marked`) are lazy-imported inside this handler
 * so they only weigh on this single route.
 */
const BodySchema = z.object({
  format: z.enum(['md', 'docx', 'pdf', 'html']),
  filename: z.string().min(1).max(200),
  content: z.string().min(1),
  stripEmojis: z.boolean().optional(),
  title: z.string().max(300).optional(),
});

// RFC 5987 / 6266 — fall back to ASCII for the filename= param, send the
// real UTF-8 name in filename*.
function contentDisposition(
  rawName: string,
  disposition: 'attachment' | 'inline',
): string {
  const asciiSafe = rawName.replace(/[^\x20-\x7E]/g, '_').replace(/["\\]/g, '_');
  const encoded = encodeURIComponent(rawName);
  return `${disposition}; filename="${asciiSafe}"; filename*=UTF-8''${encoded}`;
}

function mimeFor(format: 'md' | 'docx' | 'pdf' | 'html'): string {
  switch (format) {
    case 'md':
      return 'text/markdown; charset=utf-8';
    case 'docx':
      return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
    case 'pdf':
    case 'html':
      // PDF is delivered as printable HTML — see contract note above.
      return 'text/html; charset=utf-8';
  }
}

export async function POST(req: NextRequest) {
  // CSRF: same-origin only.
  const sfs = req.headers.get('sec-fetch-site');
  if (sfs && sfs !== 'same-origin' && sfs !== 'none') {
    return NextResponse.json({ error: 'cross-site blocked' }, { status: 403 });
  }

  let body: z.infer<typeof BodySchema>;
  try {
    const json = await req.json();
    body = BodySchema.parse(json);
  } catch (e) {
    return NextResponse.json(
      { error: 'invalid request', detail: sanitizeError(e) },
      { status: 400 },
    );
  }

  const { format, filename, content, stripEmojis, title } = body;

  const cleanMd = sanitizeMarkdown(content, { stripEmojis });

  try {
    let bytes: Buffer;
    if (format === 'md') {
      bytes = Buffer.from(cleanMd, 'utf8');
    } else if (format === 'docx') {
      const { mdToDocx } = await import('@/lib/export/docx');
      bytes = await mdToDocx(cleanMd, { title });
    } else {
      // 'pdf' and 'html' both render to a styled, self-contained HTML doc.
      const { mdToHtml } = await import('@/lib/export/html');
      const html = await mdToHtml(cleanMd, { title });
      bytes = Buffer.from(html, 'utf8');
    }

    // Convert Node Buffer into a fresh ArrayBuffer slice so the Response body
    // is a proper standalone ArrayBuffer (avoids SharedArrayBuffer typing
    // friction with the Fetch API).
    const ab = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);

    // PDF is served inline so the browser opens it directly and the user can
    // Print -> Save as PDF. Other formats download as attachments.
    const disposition: 'attachment' | 'inline' = format === 'pdf' ? 'inline' : 'attachment';

    return new NextResponse(ab as ArrayBuffer, {
      status: 200,
      headers: {
        'Content-Type': mimeFor(format),
        'Content-Disposition': contentDisposition(filename, disposition),
        'Content-Length': String(bytes.byteLength),
        'Cache-Control': 'no-store',
      },
    });
  } catch (err) {
    return NextResponse.json(
      { error: 'export failed', detail: sanitizeError(err) },
      { status: 500 },
    );
  }
}

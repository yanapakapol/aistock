import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';

import { sanitizeMarkdown } from '@/lib/export/sanitize';
import {
  mdToDocx,
  mdToPdf,
  PandocMissingError,
  PandocRunError,
} from '@/lib/export/pandoc';
import { sanitizeError } from '@/lib/security/scrub';

export const runtime = 'nodejs';
export const maxDuration = 120;

const BodySchema = z.object({
  format: z.enum(['md', 'docx', 'pdf']),
  filename: z.string().min(1).max(200),
  content: z.string().min(1),
  stripEmojis: z.boolean().optional(),
  title: z.string().max(300).optional(),
});

// RFC 5987 / 6266 — fall back to ASCII for the filename= param, send the
// real UTF-8 name in filename*.
function contentDisposition(rawName: string): string {
  const asciiSafe = rawName.replace(/[^\x20-\x7E]/g, '_').replace(/["\\]/g, '_');
  const encoded = encodeURIComponent(rawName);
  return `attachment; filename="${asciiSafe}"; filename*=UTF-8''${encoded}`;
}

function mimeFor(format: 'md' | 'docx' | 'pdf'): string {
  switch (format) {
    case 'md':
      return 'text/markdown; charset=utf-8';
    case 'docx':
      return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
    case 'pdf':
      return 'application/pdf';
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
      bytes = await mdToDocx(cleanMd, { title });
    } else {
      bytes = await mdToPdf(cleanMd, { title });
    }

    // Convert Node Buffer into a fresh ArrayBuffer slice so the Response body
    // is a proper standalone ArrayBuffer (avoids SharedArrayBuffer typing
    // friction with the Fetch API).
    const ab = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);

    return new NextResponse(ab as ArrayBuffer, {
      status: 200,
      headers: {
        'Content-Type': mimeFor(format),
        'Content-Disposition': contentDisposition(filename),
        'Content-Length': String(bytes.byteLength),
        'Cache-Control': 'no-store',
      },
    });
  } catch (err) {
    if (err instanceof PandocMissingError) {
      return NextResponse.json(
        { error: err.message, missing: err.tool },
        { status: 503 },
      );
    }
    if (err instanceof PandocRunError) {
      return NextResponse.json(
        {
          error: 'export conversion failed',
          detail: sanitizeError(err),
          stderr: err.stderr.slice(0, 2000),
        },
        { status: 500 },
      );
    }
    return NextResponse.json(
      { error: 'export failed', detail: sanitizeError(err) },
      { status: 500 },
    );
  }
}

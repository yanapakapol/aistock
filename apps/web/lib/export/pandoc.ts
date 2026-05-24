/**
 * Pandoc / typst export wrapper.
 *
 * Runs pandoc as a subprocess, feeding markdown on stdin and reading the
 * resulting docx/pdf bytes from stdout. The Docker image bundles pandoc +
 * typst + Noto fonts; in local dev pandoc may be absent — in that case the
 * functions throw a descriptive error which the route turns into a 503.
 */

import { spawn } from 'node:child_process';

export interface ExportOptions {
  /** Document title metadata (becomes `<w:title>` in DOCX, `\title` in typst). */
  title?: string;
}

export class PandocMissingError extends Error {
  constructor(public readonly tool: 'pandoc' | 'typst') {
    super(
      tool === 'pandoc'
        ? 'pandoc is not installed on this host. DOCX/PDF export requires pandoc — install it (https://pandoc.org/installing.html) or run the bundled Docker image.'
        : 'typst is not installed on this host. PDF export requires the typst engine — install it (https://typst.app/docs/) or run the bundled Docker image.',
    );
    this.name = 'PandocMissingError';
  }
}

export class PandocRunError extends Error {
  constructor(message: string, public readonly exitCode: number | null, public readonly stderr: string) {
    super(message);
    this.name = 'PandocRunError';
  }
}

/**
 * Best-effort detection of pandoc on PATH. We invoke `pandoc --version`
 * rather than `which`/`where` so it works cross-platform without a shell.
 */
export async function hasPandoc(): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    try {
      const child = spawn('pandoc', ['--version'], { stdio: 'ignore' });
      child.once('error', () => resolve(false));
      child.once('exit', (code) => resolve(code === 0));
    } catch {
      resolve(false);
    }
  });
}

/** Same probe for the typst engine (used by pandoc for PDF). */
export async function hasTypst(): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    try {
      const child = spawn('typst', ['--version'], { stdio: 'ignore' });
      child.once('error', () => resolve(false));
      child.once('exit', (code) => resolve(code === 0));
    } catch {
      resolve(false);
    }
  });
}

interface RunPandocArgs {
  args: string[];
  stdin: string;
}

function runPandoc({ args, stdin }: RunPandocArgs): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn('pandoc', args, { stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (err) {
      reject(new PandocMissingError('pandoc'));
      return;
    }

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];

    child.stdout.on('data', (c: Buffer) => stdoutChunks.push(c));
    child.stderr.on('data', (c: Buffer) => stderrChunks.push(c));

    child.once('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'ENOENT') reject(new PandocMissingError('pandoc'));
      else reject(err);
    });

    child.once('close', (code) => {
      const stderr = Buffer.concat(stderrChunks).toString('utf8');
      if (code === 0) {
        resolve(Buffer.concat(stdoutChunks));
        return;
      }
      // Heuristic: typst missing surfaces as a pandoc error mentioning typst.
      if (/typst/i.test(stderr) && /not found|no such file|cannot find/i.test(stderr)) {
        reject(new PandocMissingError('typst'));
        return;
      }
      reject(new PandocRunError(`pandoc exited with code ${code}`, code, stderr.trim()));
    });

    child.stdin.end(stdin, 'utf8');
  });
}

function metadataArgs(opts: ExportOptions | undefined): string[] {
  if (!opts?.title) return [];
  // Pandoc accepts repeated --metadata key=value. Wrapping the value in
  // quotes is shell-only; we pass argv directly so no quoting is needed.
  return ['--metadata', `title=${opts.title}`];
}

export async function mdToDocx(md: string, opts?: ExportOptions): Promise<Buffer> {
  const args = [
    '-f',
    'markdown',
    '-t',
    'docx',
    '-o',
    '-',
    ...metadataArgs(opts),
  ];
  return runPandoc({ args, stdin: md });
}

export async function mdToPdf(md: string, opts?: ExportOptions): Promise<Buffer> {
  const args = [
    '--pdf-engine=typst',
    '-f',
    'markdown',
    '-t',
    'pdf',
    '-o',
    '-',
    ...metadataArgs(opts),
  ];
  return runPandoc({ args, stdin: md });
}

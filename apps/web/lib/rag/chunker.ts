/**
 * Naive paragraph-based chunker.
 *
 * Splits the input on blank lines, then greedily packs paragraphs into
 * ~`target` character chunks. When a chunk would exceed `target`, we close
 * it out, then start the next chunk by carrying forward the trailing
 * ~`overlap` characters of the previous chunk to preserve cross-chunk context.
 *
 * A paragraph longer than `target` on its own is hard-split on character
 * boundaries (still with overlap) — token-aware splitting would be nicer but
 * this is sufficient for the v1 RAG path.
 */
export interface ChunkOpts {
  /** Target chunk size in characters. Defaults to 700. */
  target?: number;
  /** Overlap between consecutive chunks in characters. Defaults to 80. */
  overlap?: number;
}

const DEFAULT_TARGET = 700;
const DEFAULT_OVERLAP = 80;

export function chunk(text: string, opts: ChunkOpts = {}): string[] {
  const target = Math.max(1, opts.target ?? DEFAULT_TARGET);
  const overlap = Math.max(0, Math.min(opts.overlap ?? DEFAULT_OVERLAP, target - 1));

  const normalized = (text ?? '').replace(/\r\n/g, '\n').trim();
  if (!normalized) return [];

  // First pass: split into paragraph candidates (blank-line separated).
  const paragraphs = normalized
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);

  // Second pass: explode any oversized paragraph into character-sized pieces.
  const pieces: string[] = [];
  for (const p of paragraphs) {
    if (p.length <= target) {
      pieces.push(p);
      continue;
    }
    // Hard-split with overlap between sub-pieces.
    let i = 0;
    while (i < p.length) {
      const end = Math.min(p.length, i + target);
      pieces.push(p.slice(i, end));
      if (end >= p.length) break;
      i = end - overlap;
    }
  }

  // Third pass: greedily merge pieces into chunks of <= target chars,
  // carrying overlap forward from the previous emitted chunk.
  const chunks: string[] = [];
  let current = '';

  const flush = () => {
    const trimmed = current.trim();
    if (trimmed) chunks.push(trimmed);
    // Carry overlap forward from the chunk we just emitted.
    if (trimmed && overlap > 0 && trimmed.length > overlap) {
      current = trimmed.slice(-overlap);
    } else {
      current = '';
    }
  };

  for (const piece of pieces) {
    const sep = current ? '\n\n' : '';
    if (current.length + sep.length + piece.length <= target) {
      current = current + sep + piece;
      continue;
    }
    // Current chunk is full — emit and restart with overlap + this piece.
    flush();
    const sep2 = current ? '\n\n' : '';
    if (current.length + sep2.length + piece.length <= target) {
      current = current + sep2 + piece;
    } else {
      // piece itself is exactly target-sized after hard-split; emit overlap as prefix
      current = (current ? current + '\n\n' : '') + piece;
    }
  }
  // Final emit (without carrying overlap; nothing follows).
  const tail = current.trim();
  if (tail) chunks.push(tail);

  return chunks;
}

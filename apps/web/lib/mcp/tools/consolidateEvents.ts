import { z } from 'zod';
import { and, eq, sql } from 'drizzle-orm';
import { db } from '@/lib/db/client';
import { events } from '@/lib/db/schema';
import type { ToolHandler } from '../types';
import { assertOwnsStock } from '../ownership';

const input = z.object({
  stock_id: z.number().int().positive(),
  /** Drop the noisier duplicate (default) or just report what would be merged. */
  dry_run: z.boolean().default(false),
  /** Min Jaro-similarity-ish overlap (0..1) for two titles to be considered the same event. */
  similarity: z.number().min(0.5).max(1).default(0.82),
});
type Input = z.infer<typeof input>;

const output = z.object({
  scanned: z.number(),
  groups: z.number(),
  duplicates_found: z.number(),
  deleted: z.number(),
  kept_ids: z.array(z.number()),
  notes: z.array(z.string()),
});
type Output = z.infer<typeof output>;

/** Lower-cased, punctuation-stripped, single-spaced. */
function normalizeTitle(t: string): string {
  return t
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Cheap token-overlap similarity in [0,1] — Jaccard over word sets. */
function similarity(a: string, b: string): number {
  if (a === b) return 1;
  const A = new Set(a.split(' ').filter((w) => w.length > 2));
  const B = new Set(b.split(' ').filter((w) => w.length > 2));
  if (A.size === 0 || B.size === 0) return 0;
  let inter = 0;
  for (const w of A) if (B.has(w)) inter++;
  const union = A.size + B.size - inter;
  return inter / union;
}

interface Row {
  id: number;
  event_date: string;
  title: string;
  summary_md: string;
  source_url: string;
  created_at: Date;
}

function pickKeeper(group: Row[]): Row {
  // Prefer: newest event_date → longest summary → has source_url → newest created_at.
  return group.slice().sort((a, b) => {
    if (a.event_date !== b.event_date) return a.event_date > b.event_date ? -1 : 1;
    const la = (a.summary_md ?? '').length;
    const lb = (b.summary_md ?? '').length;
    if (la !== lb) return lb - la;
    const ua = (a.source_url ?? '').length > 0 ? 1 : 0;
    const ub = (b.source_url ?? '').length > 0 ? 1 : 0;
    if (ua !== ub) return ub - ua;
    return b.created_at.getTime() - a.created_at.getTime();
  })[0]!;
}

export const consolidateEvents: ToolHandler<Input, Output> = {
  name: 'consolidate_events',
  description:
    'Post-research cleanup: scans all events for the active stock, groups near-duplicate titles, ' +
    'keeps the most insightful row (newest event_date → longest summary → has source_url) and ' +
    "deletes the rest. Resolves date mismatches by always preferring the newest concrete date. " +
    'Call this at the END of every research session to keep the DB clean.',
  input,
  output,
  async execute({ stock_id, dry_run, similarity: simThreshold }, ctx) {
    await assertOwnsStock(stock_id, ctx);
    const rows = (await db
      .select({
        id: events.id,
        event_date: events.eventDate,
        title: events.title,
        summary_md: events.summaryMd,
        source_url: events.sourceUrl,
        created_at: events.createdAt,
      })
      .from(events)
      .where(eq(events.stockId, stock_id))) as Row[];

    if (rows.length === 0) {
      return {
        scanned: 0,
        groups: 0,
        duplicates_found: 0,
        deleted: 0,
        kept_ids: [],
        notes: ['no events for this stock'],
      };
    }

    // Greedy clustering by normalized-title similarity.
    const normed = rows.map((r) => ({ row: r, norm: normalizeTitle(r.title) }));
    const groups: Row[][] = [];
    const seen = new Set<number>();
    for (let i = 0; i < normed.length; i++) {
      if (seen.has(normed[i]!.row.id)) continue;
      const group: Row[] = [normed[i]!.row];
      seen.add(normed[i]!.row.id);
      for (let j = i + 1; j < normed.length; j++) {
        if (seen.has(normed[j]!.row.id)) continue;
        if (similarity(normed[i]!.norm, normed[j]!.norm) >= simThreshold) {
          group.push(normed[j]!.row);
          seen.add(normed[j]!.row.id);
        }
      }
      groups.push(group);
    }

    const dupeGroups = groups.filter((g) => g.length > 1);
    const keptIds: number[] = [];
    const toDelete: number[] = [];
    const notes: string[] = [];

    for (const g of groups) {
      if (g.length === 1) {
        keptIds.push(g[0]!.id);
        continue;
      }
      const keeper = pickKeeper(g);
      keptIds.push(keeper.id);
      for (const r of g) {
        if (r.id !== keeper.id) toDelete.push(r.id);
      }
      notes.push(
        `merged ${g.length} events on "${keeper.title.slice(0, 60)}" → kept #${keeper.id} (${keeper.event_date}), dropped ${g
          .filter((r) => r.id !== keeper.id)
          .map((r) => `#${r.id}`)
          .join(', ')}`,
      );
    }

    if (!dry_run && toDelete.length > 0) {
      await db.delete(events).where(and(eq(events.stockId, stock_id), sql`id = ANY(${toDelete})`));
    }

    return {
      scanned: rows.length,
      groups: groups.length,
      duplicates_found: dupeGroups.reduce((s, g) => s + (g.length - 1), 0),
      deleted: dry_run ? 0 : toDelete.length,
      kept_ids: keptIds,
      notes,
    };
  },
};

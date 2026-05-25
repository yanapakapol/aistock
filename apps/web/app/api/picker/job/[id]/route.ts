import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { and, eq } from 'drizzle-orm';

import { db } from '@/lib/db/client';
import { pickerJobs } from '@/lib/db/schema';
import { getCurrentUser } from '@/lib/auth/session';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const revalidate = 0;

const IdSchema = z.coerce.number().int().positive();

/**
 * GET /api/picker/job/:id
 *
 * Cheap status probe for the two-step picker flow. Returns just the metadata
 * the client needs to decide what to do next (poll again, surface an error,
 * offer "Retry analysis"). The big jsonb columns (articles / cards) are NOT
 * returned in the summary shape — only their lengths — so this is safe to
 * poll without thrashing the row over the wire.
 *
 * Ownership-gated: rows from other users return 404 (not 403) so the API
 * never confirms the existence of a foreign job id.
 *
 * Future hook: "Resume previous scan" listing the user's recent jobs would
 * ride on top of this same row shape via a separate index handler.
 */
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const me = await getCurrentUser().catch(() => null);
  if (!me) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  const { id: idRaw } = await params;
  const parsed = IdSchema.safeParse(idRaw);
  if (!parsed.success) {
    return NextResponse.json({ error: 'bad id' }, { status: 400 });
  }
  const id = parsed.data;

  const rows = await db
    .select()
    .from(pickerJobs)
    .where(and(eq(pickerJobs.id, id), eq(pickerJobs.userId, me.id)))
    .limit(1);
  const job = rows[0];
  if (!job) {
    // 404 not 403 — never confirm a foreign id exists.
    return NextResponse.json({ error: 'not found' }, { status: 404 });
  }

  // Defensive: jsonb columns come back as the parsed value already, but if
  // a malformed row slipped through, treat it as zero-length rather than
  // throwing on .length.
  const articles = Array.isArray(job.articles) ? job.articles : [];
  const cards = Array.isArray(job.cards) ? job.cards : [];

  return NextResponse.json({
    id: job.id,
    status: job.status,
    articleCount: articles.length,
    cardsCount: cards.length,
    error: job.error ?? null,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
  });
}

import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { desc, eq } from 'drizzle-orm';
import { db } from '@/lib/db/client';
import { routineRuns } from '@/lib/db/schema';

export const runtime = 'nodejs';

const IdSchema = z.coerce.number().int().positive();

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: idRaw } = await params;
  const idParsed = IdSchema.safeParse(idRaw);
  if (!idParsed.success) return NextResponse.json({ error: 'bad id' }, { status: 400 });
  const routineId = idParsed.data;

  const rows = await db
    .select()
    .from(routineRuns)
    .where(eq(routineRuns.routineId, routineId))
    .orderBy(desc(routineRuns.startedAt))
    .limit(20);

  // neon-http roundtrips Postgres numeric as a string. The client expects a
  // number (calls .toFixed() etc.), so coerce each row.
  const coerced = rows.map((r) => ({
    ...r,
    usdSpent: r.usdSpent == null ? null : Number(r.usdSpent),
  }));

  return NextResponse.json({ runs: coerced });
}

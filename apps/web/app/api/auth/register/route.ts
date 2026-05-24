import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { sql } from 'drizzle-orm';
import { db } from '@/lib/db/client';
import { users } from '@/lib/db/schema';
import { hashPassword } from '@/lib/auth/password';
import { createSession } from '@/lib/auth/session';

export const runtime = 'nodejs';

const Body = z.object({
  username: z.string().min(3).max(64).regex(/^[A-Za-z0-9_.-]+$/),
  password: z.string().min(8).max(128),
});

export async function POST(req: NextRequest) {
  if (req.headers.get('sec-fetch-site') && req.headers.get('sec-fetch-site') !== 'same-origin') {
    return NextResponse.json({ error: 'cross-origin denied' }, { status: 403 });
  }
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: 'invalid input', issues: parsed.error.issues }, { status: 400 });
  }
  const { username, password } = parsed.data;

  // Atomic check: first user becomes admin, no one else can ever be admin.
  const passwordHash = await hashPassword(password);
  try {
    // Use a transaction to guarantee only ONE admin row can ever exist.
    const created = await db.transaction(async (tx) => {
      const [{ count }] = (await tx.execute(
        sql`select count(*)::int as count from users`,
      )) as unknown as Array<{ count: number }>;
      const isAdmin = Number(count) === 0;
      const [row] = await tx
        .insert(users)
        .values({ username, passwordHash, isAdmin })
        .returning({ id: users.id, isAdmin: users.isAdmin });
      return row;
    });
    await createSession({ uid: created!.id, isAdmin: created!.isAdmin });
    return NextResponse.json({ ok: true, user: { id: created!.id, username, isAdmin: created!.isAdmin } });
  } catch (err) {
    const msg = (err as { message?: string })?.message ?? '';
    if (/unique|duplicate/i.test(msg)) {
      return NextResponse.json({ error: 'username already taken' }, { status: 409 });
    }
    return NextResponse.json({ error: 'register failed', detail: msg }, { status: 500 });
  }
}

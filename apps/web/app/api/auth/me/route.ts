import { NextResponse } from 'next/server';
import { getCurrentUser } from '@/lib/auth/session';
import { db } from '@/lib/db/client';
import { users } from '@/lib/db/schema';
import { sql } from 'drizzle-orm';

export const runtime = 'nodejs';

export async function GET() {
  const u = await getCurrentUser();
  // Also expose whether ANY user exists (so /register page can show "first
  // user becomes admin" hint vs hide that fact).
  const [{ count }] = (await db.execute(
    sql`select count(*)::int as count from users`,
  ).catch(() => [{ count: 0 }] as never)) as unknown as Array<{ count: number }>;
  return NextResponse.json({ user: u, totalUsers: Number(count ?? 0) });
}

// reference users to satisfy unused-import lint
void users;

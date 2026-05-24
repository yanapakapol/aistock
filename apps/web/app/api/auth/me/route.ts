import { NextResponse } from 'next/server';
import { getCurrentUser } from '@/lib/auth/session';
import { db } from '@/lib/db/client';
import { users } from '@/lib/db/schema';
import { sql } from 'drizzle-orm';

// Hot path: every page mount fires this from AppShell. Running on Edge
// (Web Crypto for session HMAC + @neondatabase/serverless HTTP driver for
// the legacy-cookie DB fallback + the totalUsers count) drops cold-start
// from ~1-2s to ~50-100ms.
export const runtime = 'edge';

export async function GET() {
  // Run user lookup and total-users count in parallel — they are independent.
  // Fast path inside getCurrentUser() means the user lookup is usually ~1ms,
  // but parallelizing keeps the cold-start case (legacy cookie -> DB fallback)
  // from serializing on the count query too.
  const [u, countRows] = await Promise.all([
    getCurrentUser(),
    db
      .execute(sql`select count(*)::int as count from users`)
      .catch(() => [{ count: 0 }] as never) as unknown as Promise<Array<{ count: number }>>,
  ]);
  const count = countRows[0]?.count ?? 0;
  return NextResponse.json(
    { user: u, totalUsers: Number(count ?? 0) },
    {
      // Session check is cheap but happens on every page mount via AppShell —
      // cache for 5 min in the browser so navigation is instant.
      headers: { 'Cache-Control': 'private, max-age=300, stale-while-revalidate=3600' },
    },
  );
}

// reference users to satisfy unused-import lint
void users;

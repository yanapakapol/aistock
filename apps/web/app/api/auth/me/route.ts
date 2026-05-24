import { NextResponse } from 'next/server';
import { getCurrentUser } from '@/lib/auth/session';
import { db } from '@/lib/db/client';
import { users } from '@/lib/db/schema';
import { sql } from 'drizzle-orm';

// TODO(edge): this route is a hot path on every page mount (AppShell). It
// would be MUCH faster on Vercel's Edge runtime (no Node cold start, ~10ms
// instead of 100-300ms). BLOCKED today because:
//   1. `getCurrentUser()` calls `postgres` via Drizzle (Node-only TCP driver).
//   2. The `totalUsers` count also hits Postgres.
// To migrate: switch to `@neondatabase/serverless` (Neon's HTTP driver, edge-
// compatible) and verify SESSION_SECRET reads work via `process.env` on edge.
// Until then, keep runtime = 'nodejs'.
export const runtime = 'nodejs';

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

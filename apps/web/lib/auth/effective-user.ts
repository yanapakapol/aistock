import 'server-only';
import { db } from '@/lib/db/client';
import { sql } from 'drizzle-orm';

/**
 * "Effective user" resolution for the API-key vault.
 *
 * Product rule: guest accounts share the admin's quota and capabilities, so
 * when a guest's own `api_keys` row is missing for a provider we transparently
 * fall back to the admin's row. Admin/user accounts get no fallback — they
 * see only their own keys.
 *
 * The admin lookup is the lowest-id user with `role='admin'` OR
 * `is_admin=true` (the legacy boolean is kept around per schema comment, so we
 * tolerate both). Result is cached at module scope to avoid hitting the DB on
 * every chat turn — the admin row in a single-tenant deploy never changes at
 * runtime.
 */

let cachedAdminId: number | null | undefined;

/** Test/dev hook — clears the cache so a freshly-seeded admin row is picked up. */
export function _resetAdminIdCache(): void {
  cachedAdminId = undefined;
}

/**
 * Look up the admin user's id (lowest-id user with role='admin' or
 * legacy is_admin=true). Returns null if there is no admin row at all.
 * Memoised at module scope.
 */
export async function getAdminUserId(): Promise<number | null> {
  if (cachedAdminId !== undefined) return cachedAdminId;
  try {
    const rows = (await db.execute(sql`
      select id from users
      where role = 'admin' or is_admin = true
      order by id asc
      limit 1
    `)) as unknown as Array<{ id: number }>;
    cachedAdminId = rows[0]?.id ?? null;
  } catch {
    // Un-migrated DB without the role column — fall back to is_admin only.
    try {
      const rows = (await db.execute(sql`
        select id from users where is_admin = true order by id asc limit 1
      `)) as unknown as Array<{ id: number }>;
      cachedAdminId = rows[0]?.id ?? null;
    } catch {
      cachedAdminId = null;
    }
  }
  return cachedAdminId;
}

/**
 * Resolve the "effective" user id for a key-vault lookup.
 *
 *   - role='guest'  → admin's id (or the guest's own id if there is no admin)
 *   - role='user'   → the user's own id
 *   - role='admin'  → the user's own id
 *
 * Use this ONLY for read paths. Writes must always target the caller's own
 * id so a guest can never overwrite the admin's keys.
 */
export async function getEffectiveKeyOwnerId(user: {
  id: number;
  role?: 'admin' | 'user' | 'guest';
  isAdmin?: boolean;
}): Promise<number> {
  if (user.role === 'guest') {
    const adminId = await getAdminUserId();
    return adminId ?? user.id;
  }
  return user.id;
}

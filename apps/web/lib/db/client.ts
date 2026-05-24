import 'server-only';
import { neon, neonConfig } from '@neondatabase/serverless';
import { drizzle } from 'drizzle-orm/neon-http';
import * as schema from './schema';

// HTTP driver via Neon's edge pooler: each query is a stateless HTTPS
// request through Neon's connection-pool proxy, so a Vercel cold start
// does NOT open (or hold) a TCP+TLS connection per serverless instance.
// This is the cure for hitting Neon free-tier's ~20-connection ceiling
// when too many cold instances spin up simultaneously.
//
// Trade-off: drizzle-orm/neon-http does NOT support .transaction(cb).
// Any code that needs multi-statement atomicity has to switch to the
// WebSocket driver (Pool from @neondatabase/serverless + drizzle-orm/neon-serverless)
// or run the statements individually. See ensure-schema.ts /
// portfolio/queries.ts / register/route.ts / llm/models.ts for the
// refactor pattern.

// Reuse the underlying fetch across invocations on the same Vercel
// container — saves the cost of resolving Neon's proxy DNS on each query.
neonConfig.fetchConnectionCache = true;

declare global {
  // eslint-disable-next-line no-var
  var __drizzle: ReturnType<typeof drizzle<typeof schema>> | undefined;
}

// Lazy-init so missing DATABASE_URL at BUILD time doesn't crash
// `next build` (Netlify / Vercel both evaluate API routes during
// "collecting page data"). The error only fires when a request actually
// tries to talk to the DB.
function makeClient() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error(
      'DATABASE_URL is not set. Add it to your hosting provider env vars (Netlify: Site settings → Environment; Vercel: Project Settings → Environment Variables).',
    );
  }
  const sql = neon(url);
  return drizzle(sql, { schema });
}

// Proxy that defers client construction to first access. `db.<anything>`
// triggers the real Drizzle method only when called at request time.
//
// `execute` is intercepted to unwrap `.rows` so callers can keep doing
// `const [row] = await db.execute(sql\`...\`)` exactly like they did with
// postgres-js. Without this shim, neon-http's `FullQueryResults`
// (`{ rows, rowCount, ... }`) wouldn't be array-destructurable and every
// `db.execute` callsite in the codebase would silently break.
export const db: ReturnType<typeof drizzle<typeof schema>> = new Proxy(
  {} as ReturnType<typeof drizzle<typeof schema>>,
  {
    get(_target, prop) {
      const real = (globalThis.__drizzle ??= makeClient()) as unknown as Record<
        string | symbol,
        unknown
      >;
      const v = real[prop];
      if (typeof v !== 'function') return v;
      const bound = (v as (...a: unknown[]) => unknown).bind(real);
      if (prop === 'execute') {
        return (...args: unknown[]) => {
          const out = bound(...args) as Promise<unknown> | unknown;
          if (out && typeof (out as Promise<unknown>).then === 'function') {
            return (out as Promise<{ rows?: unknown[] } | unknown[]>).then((r) =>
              r && typeof r === 'object' && !Array.isArray(r) && 'rows' in (r as object)
                ? (r as { rows: unknown[] }).rows
                : r,
            );
          }
          return out;
        };
      }
      return bound;
    },
  },
);

export type DB = typeof db;

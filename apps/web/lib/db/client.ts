import 'server-only';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import * as schema from './schema';

// Lazy-init the Postgres client + Drizzle wrapper so missing DATABASE_URL at
// BUILD time doesn't crash `next build` (Netlify / Vercel both evaluate API
// routes during "collecting page data"). The error only fires when a request
// actually tries to talk to the DB.

declare global {
  // eslint-disable-next-line no-var
  var __pg: ReturnType<typeof postgres> | undefined;
  // eslint-disable-next-line no-var
  var __drizzle: ReturnType<typeof drizzle<typeof schema>> | undefined;
}

function makeClient() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error(
      'DATABASE_URL is not set. Add it to your hosting provider env vars (Netlify: Site settings → Environment; Vercel: Project Settings → Environment Variables).',
    );
  }
  const sql =
    globalThis.__pg ??
    postgres(url, { max: 10, idle_timeout: 30, connect_timeout: 30 });
  if (process.env.NODE_ENV !== 'production') globalThis.__pg = sql;
  const inst = drizzle(sql, { schema });
  if (process.env.NODE_ENV !== 'production') globalThis.__drizzle = inst;
  return inst;
}

// Proxy that defers client construction to first access. `db.<anything>`
// triggers the real Drizzle method only when called at request time.
export const db: ReturnType<typeof drizzle<typeof schema>> = new Proxy(
  {} as ReturnType<typeof drizzle<typeof schema>>,
  {
    get(_target, prop) {
      const real = (globalThis.__drizzle ?? makeClient()) as unknown as Record<
        string | symbol,
        unknown
      >;
      const v = real[prop];
      return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(real) : v;
    },
  },
);

export type DB = typeof db;

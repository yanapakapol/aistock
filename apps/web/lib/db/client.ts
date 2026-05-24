import 'server-only';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import * as schema from './schema';

const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL is not set');

declare global {
  // eslint-disable-next-line no-var
  var __pg: ReturnType<typeof postgres> | undefined;
}

const sql = globalThis.__pg ?? postgres(url, { max: 10, idle_timeout: 30 });
if (process.env.NODE_ENV !== 'production') globalThis.__pg = sql;

export const db = drizzle(sql, { schema });
export type DB = typeof db;

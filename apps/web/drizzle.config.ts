import type { Config } from 'drizzle-kit';

export default {
  schema: './lib/db/schema.ts',
  out: './lib/db/migrations',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env.DATABASE_URL ?? 'postgres://aistock:aistock@127.0.0.1:5432/aistock',
  },
  strict: true,
  verbose: true,
} satisfies Config;

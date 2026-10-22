// Applies the database schema before `next build`. Without a database URL (a local build without Neon) it does
// nothing; on Vercel the Neon integration provides DATABASE_URL at build time.
//
// A preview deployment shares the production database unless Neon gives each preview its own branch, and a pull
// request's migration must never reach production before it merges. Previews therefore migrate only when
// PREVIEW_DATABASE=branch is set for the Preview environment (after enabling Neon's preview branching).
import pg from 'pg';
import { applyMigrations } from '../db/apply.mjs';

const url = process.env.DATABASE_URL || process.env.POSTGRES_URL;
if (!url) {
  console.log('migrate: no DATABASE_URL, skipped');
  process.exit(0);
}
if (process.env.VERCEL_ENV === 'preview' && process.env.PREVIEW_DATABASE !== 'branch') {
  console.log('migrate: preview without its own database branch (PREVIEW_DATABASE=branch), skipped');
  process.exit(0);
}
const pool = new pg.Pool({ connectionString: url });
const client = await pool.connect();
try {
  await applyMigrations(client, (message) => console.log('migrate:', message));
} finally {
  client.release();
  await pool.end();
}

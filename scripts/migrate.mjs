// Applies db/migrations/*.sql in order, once each, before `next build`. Without a database URL (a local build without
// Neon) it does nothing; on Vercel the Neon integration provides DATABASE_URL at build time.
import { readdir, readFile } from 'node:fs/promises';
import { Pool } from '@neondatabase/serverless';

const url = process.env.DATABASE_URL || process.env.POSTGRES_URL;
if (!url) {
  console.log('migrate: no DATABASE_URL, skipped');
  process.exit(0);
}
const dir = new URL('../db/migrations/', import.meta.url);
const files = (await readdir(dir)).filter((name) => name.endsWith('.sql')).sort();
const pool = new Pool({ connectionString: url });
const client = await pool.connect();
try {
  // One migrator at a time, even if two deployments build together.
  await client.query('SELECT pg_advisory_lock(7351)');
  await client.query('CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
  const done = new Set((await client.query('SELECT name FROM schema_migrations')).rows.map((row) => row.name));
  for (const name of files) {
    if (done.has(name)) continue;
    await client.query('BEGIN');
    try {
      await client.query(await readFile(new URL(name, dir), 'utf8'));
      await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [name]);
      await client.query('COMMIT');
      console.log('migrate: applied', name);
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
  }
} finally {
  await client.query('SELECT pg_advisory_unlock(7351)').catch(() => {});
  client.release();
  await pool.end();
}

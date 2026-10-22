import { randomBytes } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';

const dir = new URL('./migrations/', import.meta.url);

// Applies db/migrations/*.sql in order, once each, then creates the settings the app generates for itself.
// `client` is one node-postgres-compatible connection.
export async function applyMigrations(client, log = () => {}) {
  const files = (await readdir(dir)).filter((name) => name.endsWith('.sql')).sort();
  // One migrator at a time, even if two deployments build together.
  await client.query('SELECT pg_advisory_lock(7351)');
  try {
    await client.query('CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
    const done = new Set((await client.query('SELECT name FROM schema_migrations')).rows.map((row) => row.name));
    for (const name of files) {
      if (done.has(name)) continue;
      await client.query('BEGIN');
      try {
        await client.query(await readFile(new URL(name, dir), 'utf8'));
        await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [name]);
        await client.query('COMMIT');
        log(`applied ${name}`);
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      }
    }
    // Better Auth signs cookies and OAuth requests with this; generated once per database, never shown.
    await client.query("INSERT INTO app_settings (key, value) VALUES ('auth_secret', $1) ON CONFLICT (key) DO NOTHING",
      [randomBytes(32).toString('base64url')]);
  } finally {
    await client.query('SELECT pg_advisory_unlock(7351)').catch(() => {});
  }
}

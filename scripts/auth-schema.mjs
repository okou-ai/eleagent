// Prints the SQL that creates Better Auth's tables for this app's configuration, for a new db/migrations file after a
// Better Auth upgrade or configuration change: node scripts/auth-schema.mjs > db/migrations/NNN_auth.sql
// (tests/auth-schema.test.ts fails while the committed migrations and Better Auth disagree).
import { getMigrations } from 'better-auth/db/migration';
import { createAuth } from '../lib/auth.ts';
import { startPostgres } from '../tests/postgres.ts';

const postgres = await startPostgres();
try {
  const auth = createAuth({ origin: 'http://localhost:3000', secret: 'schema'.repeat(8), database: postgres.pool });
  const { compileMigrations } = await getMigrations(auth.options);
  process.stdout.write(await compileMigrations());
} finally {
  await postgres.stop();
}

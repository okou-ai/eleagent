import { createAuth, ownerSession, type Auth } from './auth';
import { pool, sql } from './db';

// This deployment's canonical origin: the OAuth issuer and MCP resource live here. Production uses the project's
// production domain; previews their branch URL. BETTER_AUTH_URL overrides it (for example a custom domain).
export function appOrigin(): string {
  if (process.env.BETTER_AUTH_URL) return new URL(process.env.BETTER_AUTH_URL).origin;
  const host = process.env.VERCEL_ENV === 'production'
    ? process.env.VERCEL_PROJECT_PRODUCTION_URL
    : process.env.VERCEL_BRANCH_URL || process.env.VERCEL_URL;
  return host ? `https://${host}` : 'http://localhost:3000';
}

let pending: Promise<Auth> | null = null;

export function getAuth(): Promise<Auth> {
  pending ??= (async () => {
    const [row] = await sql()`SELECT value FROM app_settings WHERE key = 'auth_secret'`;
    const secret = process.env.BETTER_AUTH_SECRET || row?.value;
    if (!secret) throw new Error('No auth secret yet: the build applies the database migrations that create it');
    return createAuth({ origin: appOrigin(), secret, database: pool() });
  })().catch((error) => {
    pending = null;
    throw error;
  });
  return pending;
}

export async function getOwnerSession(headers: Headers) {
  return ownerSession(await getAuth(), headers);
}

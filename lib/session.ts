import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { sql } from './db';

// One owner per deployment. The password is the OWNER_PASSWORD environment variable; a session is a random token in an
// httpOnly cookie, and the database keeps only its hash.
export const SESSION_COOKIE = 'eleagent_session';
export const SESSION_DAYS = 30;
const MAX_FAILURES = 10, FAILURE_WINDOW_MINUTES = 15;

const digest = (value: string) => createHash('sha256').update(value).digest();

export function passwordMatches(given: string, expected = process.env.OWNER_PASSWORD): boolean {
  if (!expected || !given) return false;
  return timingSafeEqual(digest(given), digest(expected));
}

export async function createSession(userAgent: string | null): Promise<{ token: string; expires: Date }> {
  const token = randomBytes(32).toString('base64url');
  const expires = new Date(Date.now() + SESSION_DAYS * 86_400_000);
  await sql()`INSERT INTO sessions (token_hash, expires_at, user_agent)
    VALUES (${digest(token).toString('hex')}, ${expires.toISOString()}, ${userAgent?.slice(0, 200) ?? null})`;
  return { token, expires };
}

export async function sessionValid(token: string | undefined): Promise<boolean> {
  if (!token || token.length > 100) return false;
  const rows = await sql()`SELECT 1 FROM sessions WHERE token_hash = ${digest(token).toString('hex')} AND expires_at > now()`;
  return rows.length > 0;
}

export async function endSession(token: string | undefined): Promise<void> {
  if (!token || token.length > 100) return;
  await sql()`DELETE FROM sessions WHERE token_hash = ${digest(token).toString('hex')} OR expires_at < now()`;
}

// Too many recent failures from one address lock it out for the rest of the window.
export async function signInBlocked(address: string): Promise<boolean> {
  const [row] = await sql()`SELECT count(*)::int AS n FROM sign_in_failures
    WHERE address = ${address} AND at > now() - make_interval(mins => ${FAILURE_WINDOW_MINUTES})`;
  return (row?.n ?? 0) >= MAX_FAILURES;
}

export async function recordSignInFailure(address: string): Promise<void> {
  await sql()`INSERT INTO sign_in_failures (address) VALUES (${address})`;
  await sql()`DELETE FROM sign_in_failures WHERE at < now() - interval '1 day'`;
}

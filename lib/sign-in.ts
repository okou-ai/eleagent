import { sql } from './db';

// Too many recent failures from one address lock it out for the rest of the window.
const MAX_FAILURES = 10, FAILURE_WINDOW_MINUTES = 15;

export async function signInBlocked(address: string): Promise<boolean> {
  const [row] = await sql()`SELECT count(*)::int AS n FROM sign_in_failures
    WHERE address = ${address} AND at > now() - make_interval(mins => ${FAILURE_WINDOW_MINUTES})`;
  return (row?.n ?? 0) >= MAX_FAILURES;
}

export async function recordSignInFailure(address: string): Promise<void> {
  await sql()`INSERT INTO sign_in_failures (address) VALUES (${address})`;
  await sql()`DELETE FROM sign_in_failures WHERE at < now() - interval '1 day'`;
}

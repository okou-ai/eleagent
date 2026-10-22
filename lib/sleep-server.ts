import { sql } from './db';
import { completeJson } from './openrouter';
import { SLEEP_MODEL, validTimeZone, type SleepDeps } from './sleep';

export function sleepDeps(): SleepDeps {
  return { query: sql().query, complete: (system, user, maxTokens) => completeJson(SLEEP_MODEL, system, user, maxTokens),
    language: process.env.MEMORY_LANGUAGE || 'English' };
}

// The owner's time zone, as their phone last reported it (TIMEZONE overrides; UTC if neither is known).
export async function ownerTimeZone(): Promise<string> {
  if (validTimeZone(process.env.TIMEZONE)) return process.env.TIMEZONE;
  const [row] = await sql()`SELECT value FROM app_settings WHERE key = 'timezone'`;
  return validTimeZone(row?.value) ? row.value : 'UTC';
}

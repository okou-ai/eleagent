import { sql } from './db';
import { validTimeZone } from './sleep';

// The owner's time zone, as their phone last reported it (TIMEZONE overrides; UTC if neither is known).
export async function ownerTimeZone(): Promise<string> {
  if (validTimeZone(process.env.TIMEZONE)) return process.env.TIMEZONE;
  const [row] = await sql()`SELECT value FROM app_settings WHERE key = 'timezone'`;
  return validTimeZone(row?.value) ? row.value : 'UTC';
}

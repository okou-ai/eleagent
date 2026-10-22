import { createHash, timingSafeEqual } from 'node:crypto';

// One owner per deployment. The password is the OWNER_PASSWORD environment variable; Better Auth keeps the owner's
// user row (under this fixed address) only so sessions and OAuth grants have someone to belong to. Nobody can sign up.
export const OWNER_EMAIL = 'owner@eleagent.local';

const digest = (value: string) => createHash('sha256').update(value).digest();

export function passwordMatches(given: unknown, expected = process.env.OWNER_PASSWORD): boolean {
  if (!expected || typeof given !== 'string' || !given) return false;
  return timingSafeEqual(digest(given), digest(expected));
}

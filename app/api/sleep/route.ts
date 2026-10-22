import { after, NextResponse, type NextRequest } from 'next/server';
import { appOrigin, getOwnerSession } from '@/lib/auth-server';
import { sameOrigin } from '@/lib/request';
import { localDay, sleepDay, sleepDueDays } from '@/lib/sleep';
import { ownerTimeZone, sleepDeps } from '@/lib/sleep-server';

// Nightly memory consolidation (lib/sleep.ts). Work happens after the response, within this function's time limit;
// a run that could not finish calls this route again to continue.
export const maxDuration = 300;
const BUDGET_MS = 230_000;

// Vercel Cron (vercel.json), and continuations. With CRON_SECRET set, only requests that carry it are accepted;
// without it anyone may ask, which only ever sleeps days that are due.
export async function GET(request: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (secret && request.headers.get('authorization') !== `Bearer ${secret}`) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  after(async () => {
    const remaining = await sleepDueDays(sleepDeps(), await ownerTimeZone(), { deadline: Date.now() + BUDGET_MS });
    if (remaining) await fetch(`${appOrigin()}/api/sleep`, { headers: secret ? { Authorization: `Bearer ${secret}` } : {} }).catch(() => {});
  });
  return NextResponse.json({ accepted: true }, { status: 202 });
}

// The owner writes a day's memories and diary now (today so far, by default), from /account.
export async function POST(request: NextRequest) {
  if (!sameOrigin(request) || !(await getOwnerSession(request.headers))) {
    return NextResponse.redirect(new URL('/login?return_to=/account', request.url), 303);
  }
  const form = await request.formData().catch(() => null);
  const timeZone = await ownerTimeZone();
  const asked = form?.get('day');
  const day = typeof asked === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(asked) ? asked : localDay(new Date(), timeZone);
  after(async () => {
    const deps = sleepDeps();
    // A long day may need several passes; each continues where the last stopped.
    for (let pass = 0; pass < 3; pass++) {
      if (await sleepDay(deps, day, timeZone, { deadline: Date.now() + BUDGET_MS / 3 }).catch(() => true)) break;
    }
  });
  return NextResponse.redirect(new URL(`/account?sleeping=${day}`, request.url), 303);
}

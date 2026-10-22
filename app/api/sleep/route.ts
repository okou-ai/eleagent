import { after, NextResponse, type NextRequest } from 'next/server';
import { getOwnerSession } from '@/lib/auth-server';
import { sql } from '@/lib/db';
import { sameOrigin } from '@/lib/request';
import { dueDays, localDay } from '@/lib/sleep';
import { startSleep } from '@/lib/sleep-run';
import { ownerTimeZone } from '@/lib/sleep-server';

// Starting sleep (lib/sleep-run.ts). Setting a run up (a sandbox, Pi, its files) happens after the response.
export const maxDuration = 300;

// Vercel Cron (vercel.json), and the next day after a run ends. With CRON_SECRET set, only requests that carry it are
// accepted; without it anyone may ask, which only ever starts a day that is due and not already running.
export async function GET(request: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (secret && request.headers.get('authorization') !== `Bearer ${secret}`) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  after(async () => {
    const [day] = await dueDays(sql().query, await ownerTimeZone(), new Date());
    if (day) await startSleep(day).catch(() => {});
  });
  return NextResponse.json({ accepted: true }, { status: 202 });
}

// The owner sleeps a day now (today so far, by default), from /account.
export async function POST(request: NextRequest) {
  if (!sameOrigin(request) || !(await getOwnerSession(request.headers))) {
    return NextResponse.redirect(new URL('/login?return_to=/account', request.url), 303);
  }
  const form = await request.formData().catch(() => null);
  const asked = form?.get('day');
  const day = typeof asked === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(asked) ? asked : localDay(new Date(), await ownerTimeZone());
  after(() => startSleep(day, { force: true }).catch(() => {}));
  return NextResponse.redirect(new URL(`/account?sleeping=${day}`, request.url), 303);
}

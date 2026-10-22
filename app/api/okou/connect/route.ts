import { NextResponse, type NextRequest } from 'next/server';
import { getOwnerSession } from '@/lib/auth-server';
import { okou } from '@/lib/okou-server';
import { sameOrigin } from '@/lib/request';

// The owner connects Okou: off to Okou to approve, back at /api/okou/callback.
export async function POST(request: NextRequest) {
  if (!sameOrigin(request) || !(await getOwnerSession(request.headers))) {
    return NextResponse.redirect(new URL('/login?return_to=/account', request.url), 303);
  }
  try {
    return NextResponse.redirect(await okou().start(), 303);
  } catch {
    return NextResponse.redirect(new URL('/account?okou=unavailable', request.url), 303);
  }
}

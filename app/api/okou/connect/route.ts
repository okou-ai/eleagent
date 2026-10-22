import { NextResponse, type NextRequest } from 'next/server';
import { getOwnerSession } from '@/lib/auth-server';
import { okou } from '@/lib/okou-server';
import { safeReturnTo, sameOrigin } from '@/lib/request';

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

// The Okou mark on the capture page: a plain navigation (a form's redirect to Okou would hit the page's form-action
// policy). Starting an approval is harmless on its own: it still needs the owner's consent at Okou and this session.
export async function GET(request: NextRequest) {
  if (!(await getOwnerSession(request.headers))) return NextResponse.redirect(new URL('/login?return_to=/', request.url), 303);
  try {
    return NextResponse.redirect(await okou().start(safeReturnTo(request.nextUrl.searchParams.get('return_to'))), 303);
  } catch {
    return NextResponse.redirect(new URL('/account?okou=unavailable', request.url), 303);
  }
}

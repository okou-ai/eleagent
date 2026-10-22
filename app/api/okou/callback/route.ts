import { NextResponse, type NextRequest } from 'next/server';
import { getOwnerSession } from '@/lib/auth-server';
import { okou } from '@/lib/okou-server';

// Okou sends the owner back here with an authorization code.
export async function GET(request: NextRequest) {
  if (!(await getOwnerSession(request.headers))) return NextResponse.redirect(new URL('/login?return_to=/account', request.url), 303);
  try {
    await okou().finish(request.nextUrl.searchParams);
    return NextResponse.redirect(new URL('/account?okou=connected', request.url), 303);
  } catch {
    return NextResponse.redirect(new URL('/account?okou=failed', request.url), 303);
  }
}

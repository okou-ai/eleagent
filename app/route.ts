import { NextResponse, type NextRequest } from 'next/server';
import { SESSION_COOKIE, sessionValid } from '@/lib/session';
import { CAPTURE_CSP, CAPTURE_HTML } from '@/lib/capture-page';

// The capture page itself is plain HTML + ES modules from /capture; only the owner may open it.
export async function GET(request: NextRequest) {
  if (!(await sessionValid(request.cookies.get(SESSION_COOKIE)?.value))) {
    return NextResponse.redirect(new URL('/login?return_to=/', request.url), 303);
  }
  return new NextResponse(CAPTURE_HTML, {
    headers: {
      'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Security-Policy': CAPTURE_CSP,
      'Permissions-Policy': 'camera=(self), microphone=(self), geolocation=(self)', 'Referrer-Policy': 'no-referrer',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}

import { NextResponse, type NextRequest } from 'next/server';
import { SESSION_COOKIE, endSession } from '@/lib/session';
import { sameOrigin } from '@/lib/request';

export async function POST(request: NextRequest) {
  if (sameOrigin(request)) await endSession(request.cookies.get(SESSION_COOKIE)?.value);
  const response = NextResponse.redirect(new URL('/login', request.url), 303);
  response.cookies.delete(SESSION_COOKIE);
  return response;
}

import { NextResponse, type NextRequest } from 'next/server';
import { SESSION_COOKIE, createSession, passwordMatches, recordSignInFailure, signInBlocked } from '@/lib/session';
import { clientAddress, safeReturnTo, sameOrigin } from '@/lib/request';

// The sign-in form posts here; success sets the session cookie and returns to the page that asked.
export async function POST(request: NextRequest) {
  const form = await request.formData().catch(() => null);
  const returnTo = safeReturnTo(form?.get('return_to'));
  const back = (error: string) => NextResponse.redirect(
    new URL(`/login?error=${error}&return_to=${encodeURIComponent(returnTo)}`, request.url), 303);
  if (!sameOrigin(request) || !form) return back('invalid');
  if (!process.env.OWNER_PASSWORD) return back('unconfigured');
  const address = clientAddress(request);
  if (await signInBlocked(address)) return back('locked');
  const password = form.get('password');
  if (typeof password !== 'string' || !passwordMatches(password)) {
    await recordSignInFailure(address);
    return back('wrong');
  }
  const { token, expires } = await createSession(request.headers.get('user-agent'));
  const response = NextResponse.redirect(new URL(returnTo, request.url), 303);
  response.cookies.set(SESSION_COOKIE, token, { httpOnly: true, secure: true, sameSite: 'lax', path: '/', expires });
  return response;
}

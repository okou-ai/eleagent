import { NextResponse, type NextRequest } from 'next/server';
import { getAuth } from '@/lib/auth-server';
import { sameOrigin, withCookies } from '@/lib/request';

// Ends this browser's session. Agents connected with offline access keep theirs; revoke them in /account.
export async function POST(request: NextRequest) {
  const response = NextResponse.redirect(new URL('/login', request.url), 303);
  if (!sameOrigin(request)) return response;
  const auth = await getAuth();
  const signedOut = await auth.api.signOut({ headers: request.headers, asResponse: true });
  return withCookies(response, signedOut);
}

import { NextResponse, type NextRequest } from 'next/server';
import { getAuth } from '@/lib/auth-server';
import { passwordMatches } from '@/lib/owner';
import { recordSignInFailure, signInBlocked } from '@/lib/sign-in';
import { clientAddress, jsonApiRequest, safeReturnTo, sameOrigin, withCookies } from '@/lib/request';

// The sign-in form posts here. Success starts a Better Auth session and returns to the page that asked, or, when an
// agent's authorization sent the owner here (a signed oauth_query), continues that authorization.
export async function POST(request: NextRequest) {
  const form = await request.formData().catch(() => null);
  const returnTo = safeReturnTo(form?.get('return_to'));
  const oauthQuery = typeof form?.get('oauth_query') === 'string' ? String(form?.get('oauth_query')) : '';
  const back = (error: string) => {
    const params = new URLSearchParams(oauthQuery || { return_to: returnTo });
    params.set('error', error);
    return NextResponse.redirect(new URL(`/login?${params}`, request.url), 303);
  };
  if (!sameOrigin(request) || !form) return back('invalid');
  if (!process.env.OWNER_PASSWORD) return back('unconfigured');
  const address = clientAddress(request);
  if (await signInBlocked(address)) return back('locked');
  const password = form.get('password');
  if (!passwordMatches(password)) {
    await recordSignInFailure(address);
    return back('wrong');
  }
  const auth = await getAuth();
  const api = jsonApiRequest(request);
  let signedIn: Response;
  try {
    signedIn = await auth.api.signInOwner({
      body: { password: String(password), ...(oauthQuery ? { oauth_query: oauthQuery } : {}) },
      headers: api.headers,
      request: api,
      asResponse: true,
    });
  } catch {
    // An authorization request that expired or was altered on the way.
    return back(oauthQuery ? 'expired' : 'invalid');
  }
  if (!signedIn.ok) return back(oauthQuery ? 'expired' : 'invalid');
  const result = await signedIn.json().catch(() => null) as { url?: unknown } | null;
  const target = typeof result?.url === 'string' ? result.url : returnTo;
  return withCookies(NextResponse.redirect(new URL(target, request.url), 303), signedIn);
}

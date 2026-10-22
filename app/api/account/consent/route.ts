import { NextResponse, type NextRequest } from 'next/server';
import { getAuth, getOwnerSession } from '@/lib/auth-server';
import { jsonApiRequest, sameOrigin } from '@/lib/request';

// The consent form posts here: allowing or denying sends the agent back with a code or an error.
export async function POST(request: NextRequest) {
  const form = await request.formData().catch(() => null);
  const oauthQuery = form?.get('oauth_query');
  if (!sameOrigin(request) || typeof oauthQuery !== 'string' || !(await getOwnerSession(request.headers))) {
    return NextResponse.redirect(new URL('/account', request.url), 303);
  }
  const auth = await getAuth();
  const api = jsonApiRequest(request);
  const decided = await auth.api.oauth2Consent({
    body: { accept: form?.get('accept') === 'allow', oauth_query: oauthQuery },
    headers: api.headers,
    request: api,
    asResponse: true,
  }).catch(() => null);
  const result = await decided?.json().catch(() => null) as { url?: unknown; redirect_uri?: unknown } | null;
  const target = result?.redirect_uri ?? result?.url;
  if (!decided?.ok || typeof target !== 'string') {
    return NextResponse.redirect(new URL(`/consent?${oauthQuery}&error=expired`, request.url), 303);
  }
  return NextResponse.redirect(target, 303);
}

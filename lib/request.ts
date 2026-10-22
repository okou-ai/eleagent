import { NextResponse, type NextRequest } from 'next/server';
import { getOwnerSession } from './auth-server';
export { safeReturnTo } from './paths';

export function jsonError(status: number, code: string, message: string) {
  return NextResponse.json({ error: { code, message } }, { status, headers: { 'Cache-Control': 'no-store' } });
}

// State-changing requests come from this deployment's own pages: browsers send Origin on fetch and form POSTs.
export function sameOrigin(request: NextRequest): boolean {
  const origin = request.headers.get('origin');
  return origin !== null && origin === request.nextUrl.origin;
}

// The owner's session, or the 401 the capture page treats as "sign in again".
export async function requireOwner(request: NextRequest): Promise<NextResponse | null> {
  if (await getOwnerSession(request.headers)) return null;
  return jsonError(401, 'sign_in_required', 'Sign in to continue');
}

export function clientAddress(request: NextRequest): string {
  return (request.headers.get('x-forwarded-for') ?? '').split(',')[0].trim().slice(0, 64) || 'unknown';
}

// Copies the cookies a Better Auth response sets onto the response this app returns.
export function withCookies(response: NextResponse, from: Response): NextResponse {
  for (const cookie of from.headers.getSetCookie()) response.headers.append('Set-Cookie', cookie);
  return response;
}

// For Better Auth endpoints called from this app's routes: the OAuth provider answers a JSON body (never a redirect)
// that the route turns into its own redirect, and it needs the request it continues an authorization for.
export function jsonApiRequest(request: Request): Request {
  const headers = new Headers(request.headers);
  headers.delete('sec-fetch-mode');
  headers.set('Accept', 'application/json');
  return new Request(request.url, { method: request.method, headers });
}

import { NextResponse, type NextRequest } from 'next/server';
import { SESSION_COOKIE, sessionValid } from './session';
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
  if (await sessionValid(request.cookies.get(SESSION_COOKIE)?.value)) return null;
  return jsonError(401, 'sign_in_required', 'Sign in to continue');
}

export function clientAddress(request: NextRequest): string {
  return (request.headers.get('x-forwarded-for') ?? '').split(',')[0].trim().slice(0, 64) || 'unknown';
}

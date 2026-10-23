import { NextResponse, type NextRequest } from 'next/server';
import { getOwnerSession } from '@/lib/auth-server';
import { refused } from '@/lib/handoff';
import { callOkou, okou } from '@/lib/okou-server';

// Okou sends the owner back here with an authorization code.
export async function GET(request: NextRequest) {
  if (!(await getOwnerSession(request.headers))) return NextResponse.redirect(new URL('/login?return_to=/account', request.url), 303);
  try {
    const connection = okou();
    const back = await connection.finish(request.nextUrl.searchParams);
    // Find out now, not at the first request, whether Okou's MCP accepts the token (it must name an organization).
    const problem = await callOkou((await connection.accessToken())!, 'list_agents', {}).then(() => null, (error: unknown) => error);
    if (refused(problem)) {
      await connection.disconnect();
      return NextResponse.redirect(new URL('/account?okou=refused', request.url), 303);
    }
    return NextResponse.redirect(new URL(back === '/account' ? '/account?okou=connected' : back, request.url), 303);
  } catch (error) {
    // Okou's answer, shown as one of /account's own messages (never Okou's text).
    const code = (error as { code?: string }).code;
    const result = code === 'invalid_scope' ? 'scope' : code === 'access_denied' ? 'denied' : 'failed';
    return NextResponse.redirect(new URL(`/account?okou=${result}`, request.url), 303);
  }
}

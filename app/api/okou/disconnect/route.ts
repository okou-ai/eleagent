import { NextResponse, type NextRequest } from 'next/server';
import { getOwnerSession } from '@/lib/auth-server';
import { okou } from '@/lib/okou-server';
import { sameOrigin } from '@/lib/request';

// Stops handing requests to Okou and forgets its tokens (revoke Eleagent in Okou's settings to end the grant there).
export async function POST(request: NextRequest) {
  if (sameOrigin(request) && (await getOwnerSession(request.headers))) await okou().disconnect();
  return NextResponse.redirect(new URL('/account', request.url), 303);
}

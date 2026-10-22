import { NextResponse, type NextRequest } from 'next/server';
import { revokeGrant } from '@/lib/auth';
import { getAuth, getOwnerSession } from '@/lib/auth-server';
import { sameOrigin } from '@/lib/request';

// Disconnects an agent: its consent and every token it holds stop working at once.
export async function POST(request: NextRequest) {
  const form = await request.formData().catch(() => null);
  const clientId = form?.get('client_id');
  const session = sameOrigin(request) ? await getOwnerSession(request.headers) : null;
  if (session && typeof clientId === 'string' && clientId) await revokeGrant(await getAuth(), session.user.id, clientId);
  return NextResponse.redirect(new URL('/account', request.url), 303);
}

import { NextResponse, type NextRequest } from 'next/server';
import { getOwnerSession } from '@/lib/auth-server';
import { okou } from '@/lib/okou-server';
import { jsonError } from '@/lib/request';

// Whether Okou is connected, for the Okou mark on the capture page.
export async function GET(request: NextRequest) {
  if (!(await getOwnerSession(request.headers))) return jsonError(401, 'sign_in_required', 'Sign in to continue');
  const { connected } = await okou().status();
  return NextResponse.json({ connected }, { headers: { 'Cache-Control': 'no-store' } });
}

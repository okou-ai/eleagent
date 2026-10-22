import { getAuth } from '@/lib/auth-server';
import { handleAuthRequest } from '@/lib/auth';

// OAuth endpoints for agents (authorize, token, register, revoke); the rest of Better Auth is not exposed.
export async function GET(request: Request) {
  return handleAuthRequest(await getAuth(), request);
}
export async function POST(request: Request) {
  return handleAuthRequest(await getAuth(), request);
}

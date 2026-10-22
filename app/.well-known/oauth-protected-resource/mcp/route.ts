import { protectedResourceMetadata } from '@/lib/auth';
import { connection } from 'next/server';
import { getAuth } from '@/lib/auth-server';

// RFC 9728: where agents find the authorization server for /mcp.
export async function GET() {
  await connection();
  return Response.json(protectedResourceMetadata(await getAuth()), { headers: { 'Cache-Control': 'no-store' } });
}

import { authorizationServerMetadata } from '@/lib/auth';
import { connection } from 'next/server';
import { getAuth } from '@/lib/auth-server';

// RFC 8414 metadata for the issuer ${origin}/api/auth.
export async function GET() {
  await connection();
  return Response.json(authorizationServerMetadata(await getAuth()), { headers: { 'Cache-Control': 'no-store' } });
}

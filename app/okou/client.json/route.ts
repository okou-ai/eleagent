import { connection } from 'next/server';
import { appOrigin } from '@/lib/auth-server';
import { clientMetadata } from '@/lib/okou';

// Eleagent's Client ID Metadata Document: its URL is the client_id Okou's authorization server knows it by.
export async function GET() {
  await connection();
  return Response.json(clientMetadata(appOrigin()), { headers: { 'Cache-Control': 'public, max-age=3600' } });
}

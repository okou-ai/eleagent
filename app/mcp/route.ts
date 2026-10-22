import { issueSignedToken, presignUrl } from '@vercel/blob';
import { verifyAccess } from '@/lib/auth';
import { getAuth } from '@/lib/auth-server';
import { sql } from '@/lib/db';
import { framesFromUrl } from '@/lib/frames';
import { handleMcp, memoryStore } from '@/lib/mcp';

const DOWNLOAD_MINUTES = 10;

// A presigned GET for one private clip: agents fetch the video without sending their access token anywhere but here.
async function signDownload(pathname: string) {
  const validUntil = Date.now() + DOWNLOAD_MINUTES * 60_000;
  const token = await issueSignedToken({ pathname, operations: ['get'], validUntil });
  const { presignedUrl } = await presignUrl(token, { operation: 'get', pathname, access: 'private', validUntil });
  return { url: presignedUrl, expiresAt: new Date(validUntil) };
}

export async function POST(request: Request) {
  const access = await verifyAccess(await getAuth(), request);
  if (!access.ok) return access.response;
  const store = memoryStore(sql().query, signDownload, framesFromUrl);
  return handleMcp(request, store, access.scopes);
}

export async function GET(request: Request) {
  return handleMcp(request, memoryStore(async () => [], signDownload, framesFromUrl), []);
}
export const DELETE = GET;

import { verifyAccess } from '@/lib/auth';
import { getAuth } from '@/lib/auth-server';
import { signDownload } from '@/lib/blob';
import { sql } from '@/lib/db';
import { framesFromUrl } from '@/lib/frames';
import { handleMcp, memoryStore } from '@/lib/mcp';
import { perceiveAfterResponse } from '@/lib/perception-server';

// Reads may trigger processing of minutes that are ready (see perceiveAfterResponse).
export const maxDuration = 300;

export async function POST(request: Request) {
  const access = await verifyAccess(await getAuth(), request);
  if (!access.ok) return access.response;
  const store = memoryStore(sql().query, signDownload, framesFromUrl);
  perceiveAfterResponse();
  return handleMcp(request, store, access.scopes);
}

export async function GET(request: Request) {
  return handleMcp(request, memoryStore(async () => [], signDownload, framesFromUrl), []);
}
export const DELETE = GET;

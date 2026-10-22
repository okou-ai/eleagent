import { issueSignedToken, presignUrl } from '@vercel/blob';
import { NextResponse, type NextRequest } from 'next/server';
import { MAX_CLIP_BYTES, clipPathname, parseClip, receipt } from '@/lib/clips';
import { sql } from '@/lib/db';
import { jsonError, requireOwner, sameOrigin } from '@/lib/request';

const UPLOAD_MINUTES = 10;

// Step 1 of a clip upload: the page describes the clip and gets a short-lived URL to PUT it straight into the private
// Blob store (function request bodies are capped well below a clip's size). A clip already recorded gets its receipt.
export async function POST(request: NextRequest) {
  if (!sameOrigin(request)) return jsonError(403, 'cross_origin', 'Requests must come from this site');
  const denied = await requireOwner(request);
  if (denied) return denied;
  let body: unknown;
  try { body = await request.json(); } catch { return jsonError(400, 'invalid_json', 'Body must be JSON'); }
  const clip = parseClip(body);
  if (!clip.ok) return jsonError(422, 'invalid_clip', clip.error);
  const { meta, contentType } = clip.value;

  const [existing] = await sql()`SELECT media_id FROM clips WHERE capture_id = ${meta.capture_id} AND clip_seq = ${meta.clip_seq}`;
  if (existing) return NextResponse.json({ receipt: receipt(meta, existing.media_id) }, { headers: { 'Cache-Control': 'no-store' } });

  const pathname = clipPathname(meta, contentType);
  const validUntil = Date.now() + UPLOAD_MINUTES * 60_000;
  const limits = { allowedContentTypes: [contentType], maximumSizeInBytes: MAX_CLIP_BYTES };
  const token = await issueSignedToken({ pathname, operations: ['put'], validUntil, ...limits });
  const { presignedUrl } = await presignUrl(token, {
    operation: 'put', pathname, access: 'private', validUntil, ...limits, addRandomSuffix: false, allowOverwrite: true,
  });
  return NextResponse.json({ pathname, upload_url: presignedUrl }, { headers: { 'Cache-Control': 'no-store' } });
}

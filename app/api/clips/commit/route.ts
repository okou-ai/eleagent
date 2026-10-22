import { randomBytes } from 'node:crypto';
import { head } from '@vercel/blob';
import { NextResponse, type NextRequest } from 'next/server';
import { MAX_CLIP_BYTES, clipPathname, contentTypeOf, parseMeta, receipt } from '@/lib/clips';
import { sql } from '@/lib/db';
import { queueClip } from '@/lib/perception';
import { perceiveAfterResponse } from '@/lib/perception-server';
import { validTimeZone } from '@/lib/sleep';
import { jsonError, requireOwner, sameOrigin } from '@/lib/request';

// After answering, the function stays up to process minutes that became ready (perceiveAfterResponse).
export const maxDuration = 300;

// Step 2 of a clip upload: once the PUT succeeded, record the clip. Recording the same clip twice returns the first
// receipt, so a retry after a lost response is harmless.
export async function POST(request: NextRequest) {
  if (!sameOrigin(request)) return jsonError(403, 'cross_origin', 'Requests must come from this site');
  const denied = await requireOwner(request);
  if (denied) return denied;
  let body: { meta?: unknown; pathname?: unknown };
  try { body = await request.json(); } catch { return jsonError(400, 'invalid_json', 'Body must be JSON'); }
  const meta = parseMeta(body?.meta);
  if (!meta.ok) return jsonError(422, 'invalid_clip', meta.error);
  const pathname = typeof body.pathname === 'string' ? body.pathname : '';
  const contentType = contentTypeOf(pathname);
  if (!contentType || pathname !== clipPathname(meta.value, contentType)) return jsonError(422, 'invalid_pathname', 'pathname does not belong to this clip');

  let blob;
  try { blob = await head(pathname); } catch { return jsonError(503, 'not_uploaded', 'The clip has not reached storage yet; retry'); }
  if (blob.size < 1 || blob.size > MAX_CLIP_BYTES) return jsonError(422, 'invalid_size', 'The stored clip has an invalid size');

  const m = meta.value;
  const mediaId = 'media_' + randomBytes(16).toString('hex');
  await sql()`INSERT INTO captures (id, camera, first_clip_at, last_clip_at)
    VALUES (${m.capture_id}, ${m.camera}, ${m.captured_at}, ${m.captured_at})
    ON CONFLICT (id) DO UPDATE SET last_clip_at = GREATEST(captures.last_clip_at, EXCLUDED.last_clip_at)`;
  const inserted = await sql()`INSERT INTO clips (media_id, capture_id, clip_seq, captured_at, captured_end_at, content_type, size_bytes, pathname, meta)
    VALUES (${mediaId}, ${m.capture_id}, ${m.clip_seq}, ${m.captured_at}, ${m.captured_end_at ?? null}, ${contentType}, ${blob.size},
      ${pathname}, ${JSON.stringify(m)})
    ON CONFLICT (capture_id, clip_seq) DO NOTHING RETURNING media_id`;
  if (inserted[0]) {
    await queueClip(sql().query, m.capture_id, m.captured_at);
    // Days for the diary follow the time zone the phone is in.
    if (validTimeZone(m.timezone)) {
      await sql()`INSERT INTO app_settings (key, value) VALUES ('timezone', ${m.timezone})
        ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value WHERE app_settings.value <> EXCLUDED.value`;
    }
    perceiveAfterResponse({ tail: true });
  }
  const id = inserted[0]?.media_id
    ?? (await sql()`SELECT media_id FROM clips WHERE capture_id = ${m.capture_id} AND clip_seq = ${m.clip_seq}`)[0]?.media_id;
  return NextResponse.json({ receipt: receipt(m, id) }, { headers: { 'Cache-Control': 'no-store' } });
}

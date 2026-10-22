// What the capture page sends about a clip, checked before the server signs an upload or records it.
export const MAX_CLIP_BYTES = 16_000_000;
const MAX_META_BYTES = 16_384;
const CAPTURE_ID = /^web-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}-(front|back)$/;
const TYPES = { 'video/webm': 'webm', 'video/mp4': 'mp4' } as const;

export type ContentType = keyof typeof TYPES;
export type ClipMeta = {
  capture_id: string;
  clip_seq: number;
  captured_at: string;
  captured_end_at?: string;
  camera: 'front' | 'back';
  [key: string]: unknown;
};
export type Clip = { meta: ClipMeta; contentType: ContentType; size: number };
type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

const isInstant = (value: unknown) => typeof value === 'string' && value.length <= 40 && Number.isFinite(Date.parse(value));

export function parseMeta(input: unknown): Parsed<ClipMeta> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { ok: false, error: 'meta must be an object' };
  const meta = input as Record<string, unknown>;
  if (JSON.stringify(meta).length > MAX_META_BYTES) return { ok: false, error: 'meta is too large' };
  if (typeof meta.capture_id !== 'string' || !CAPTURE_ID.test(meta.capture_id)) return { ok: false, error: 'invalid capture_id' };
  if (!Number.isInteger(meta.clip_seq) || (meta.clip_seq as number) < 0 || (meta.clip_seq as number) > 9_999_999) {
    return { ok: false, error: 'invalid clip_seq' };
  }
  if (!isInstant(meta.captured_at)) return { ok: false, error: 'invalid captured_at' };
  if (meta.captured_end_at !== undefined && !isInstant(meta.captured_end_at)) return { ok: false, error: 'invalid captured_end_at' };
  // The capture id ends with the camera that recorded it; the two must agree.
  if (meta.camera !== 'front' && meta.camera !== 'back') return { ok: false, error: 'invalid camera' };
  if (!meta.capture_id.endsWith(`-${meta.camera}`)) return { ok: false, error: 'camera does not match capture_id' };
  if (meta.locations !== undefined && (!Array.isArray(meta.locations) || meta.locations.length > 10)) {
    return { ok: false, error: 'invalid locations' };
  }
  return { ok: true, value: meta as ClipMeta };
}

export function parseClip(input: unknown): Parsed<Clip> {
  const body = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  const meta = parseMeta(body.meta);
  if (!meta.ok) return meta;
  if (typeof body.content_type !== 'string' || !(body.content_type in TYPES)) return { ok: false, error: 'content_type must be video/webm or video/mp4' };
  if (!Number.isInteger(body.size) || (body.size as number) < 1 || (body.size as number) > MAX_CLIP_BYTES) {
    return { ok: false, error: `size must be 1 to ${MAX_CLIP_BYTES} bytes` };
  }
  return { ok: true, value: { meta: meta.value, contentType: body.content_type as ContentType, size: body.size as number } };
}

// One fixed place per clip, so a retried upload lands on the same blob instead of a second copy.
export function clipPathname(meta: ClipMeta, contentType: ContentType): string {
  return `captures/${meta.capture_id}/${String(meta.clip_seq).padStart(7, '0')}.${TYPES[contentType]}`;
}

export function contentTypeOf(pathname: string): ContentType | null {
  return pathname.endsWith('.webm') ? 'video/webm' : pathname.endsWith('.mp4') ? 'video/mp4' : null;
}

// What the capture page checks before it drops a clip from its local queue.
export function receipt(meta: ClipMeta, mediaId: string) {
  return { archived: true, capture_id: meta.capture_id, clip_seq: meta.clip_seq, media_id: mediaId };
}

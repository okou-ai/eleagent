import test from 'node:test';
import assert from 'node:assert/strict';
import { clipPathname, contentTypeOf, parseClip, parseMeta, receipt } from '../lib/clips.ts';
import { safeReturnTo } from '../lib/paths.ts';

const CAPTURE = 'web-0b5f3a2e-8d1c-4e7a-9f20-3c4d5e6f7a8b-back';
const meta = (extra = {}) => ({ capture_id: CAPTURE, clip_seq: 12, captured_at: '2026-10-22T09:00:00.000Z',
  captured_end_at: '2026-10-22T09:00:05.010Z', camera: 'back', source: 'browser_media_recorder', locations: [], ...extra });

test('a well-formed clip parses, and its pathname is fixed by capture, sequence and type', () => {
  const parsed = parseClip({ meta: meta(), content_type: 'video/mp4', size: 1_400_000 });
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  const pathname = clipPathname(parsed.value.meta, parsed.value.contentType);
  assert.equal(pathname, `captures/${CAPTURE}/0000012.mp4`);
  assert.equal(contentTypeOf(pathname), 'video/mp4');
  assert.deepEqual(receipt(parsed.value.meta, 'media_x'), { archived: true, capture_id: CAPTURE, clip_seq: 12, media_id: 'media_x' });
});

test('clips that cannot be stored safely are refused with a reason', () => {
  const cases: [unknown, RegExp][] = [
    [{ meta: meta({ capture_id: '../../etc' }), content_type: 'video/mp4', size: 1 }, /capture_id/],
    [{ meta: meta({ clip_seq: -1 }), content_type: 'video/mp4', size: 1 }, /clip_seq/],
    [{ meta: meta({ clip_seq: 1.5 }), content_type: 'video/mp4', size: 1 }, /clip_seq/],
    [{ meta: meta({ captured_at: 'yesterday' }), content_type: 'video/mp4', size: 1 }, /captured_at/],
    [{ meta: meta({ camera: 'front' }), content_type: 'video/mp4', size: 1 }, /camera/],
    [{ meta: meta({ locations: new Array(11).fill({}) }), content_type: 'video/mp4', size: 1 }, /locations/],
    [{ meta: meta({ note: 'x'.repeat(20_000) }), content_type: 'video/mp4', size: 1 }, /too large/],
    [{ meta: meta(), content_type: 'video/quicktime', size: 1 }, /content_type/],
    [{ meta: meta(), content_type: 'video/mp4', size: 16_000_001 }, /size/],
    [{ meta: meta(), content_type: 'video/mp4', size: 0 }, /size/],
    [{ meta: [], content_type: 'video/mp4', size: 1 }, /meta/],
  ];
  for (const [input, reason] of cases) {
    const parsed = parseClip(input);
    assert.equal(parsed.ok, false, JSON.stringify(input).slice(0, 80));
    if (!parsed.ok) assert.match(parsed.error, reason);
  }
  assert.equal(parseMeta(meta()).ok, true);
});

test('sign-in only returns to paths on this site', () => {
  assert.equal(safeReturnTo('/'), '/');
  assert.equal(safeReturnTo('/login?x=1'), '/login?x=1');
  for (const value of ['//evil.example', '/\\evil.example', 'https://evil.example', 'evil', '', null, 7]) {
    assert.equal(safeReturnTo(value), '/', String(value));
  }
});

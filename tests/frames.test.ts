import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import ffmpeg from '@ffmpeg-installer/ffmpeg';
import { framesFromFile, framesFromUrl } from '../lib/frames.ts';
import { handleMcp, memoryStore } from '../lib/mcp.ts';

// Synthetic test pattern clips in both formats browsers record (WebM from Chrome, MP4 from Safari): no recordings.
const CAPTURE = 'web-0b5f3a2e-8d1c-4e7a-9f20-3c4d5e6f7a8b-back';
const MEDIA = 'media_' + 'b'.repeat(32);
let dir: string;
let server: Server;
let base: string;

const isJpeg = (data: Buffer) => data.length > 500 && data[0] === 0xff && data[1] === 0xd8 && data.at(-2) === 0xff && data.at(-1) === 0xd9;
// Width and height from a baseline/progressive JPEG's start-of-frame segment.
function jpegSize(data: Buffer) {
  for (let i = 2; i < data.length;) {
    const marker = data[i + 1], length = data.readUInt16BE(i + 2);
    if (marker >= 0xc0 && marker <= 0xc2) return { height: data.readUInt16BE(i + 5), width: data.readUInt16BE(i + 7) };
    i += 2 + length;
  }
  return null;
}

before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'eleagent-frames-test-'));
  const source = ['-f', 'lavfi', '-i', 'testsrc=duration=5:size=960x720:rate=15', '-f', 'lavfi', '-i', 'sine=duration=5'];
  await promisify(execFile)(ffmpeg.path, ['-loglevel', 'error', ...source, '-c:v', 'libvpx', '-c:a', 'libopus', join(dir, 'clip.webm')]);
  await promisify(execFile)(ffmpeg.path, ['-loglevel', 'error', ...source, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac',
    '-movflags', 'frag_keyframe+empty_moov', join(dir, 'clip.mp4')]);
  server = createServer(async (request, response) => {
    try { response.end(await readFile(join(dir, request.url!.slice(1)))); } catch { response.statusCode = 404; response.end(); }
  }).listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
after(async () => {
  server?.close();
  await rm(dir, { recursive: true, force: true });
});

test('stills come out of WebM and fragmented MP4 clips, scaled to the requested size', async () => {
  for (const name of ['clip.webm', 'clip.mp4']) {
    const frames = await framesFromFile(join(dir, name), [0, 2.5, 4.75], 480);
    assert.equal(frames.length, 3, name);
    for (const frame of frames) {
      assert.ok(isJpeg(frame), name);
      assert.deepEqual(jpegSize(frame), { width: 480, height: 360 }, name);
    }
  }
});

test('an offset past the end of the video track still yields its last frame', async () => {
  const [frame] = await framesFromFile(join(dir, 'clip.webm'), [30], 320);
  assert.ok(isJpeg(frame));
});

test('a clip that cannot be downloaded is an error, not an empty answer', async () => {
  await assert.rejects(framesFromUrl(`${base}/missing.mp4`, [1], 320), /download failed/);
});

test('get_video_frames returns images by capture and time over MCP', async () => {
  const row = { media_id: MEDIA, capture_id: CAPTURE, captured_at: new Date('2026-10-22T09:00:00Z'),
    captured_end_at: new Date('2026-10-22T09:00:05Z'), pathname: 'clip.mp4' };
  const store = memoryStore(async (text) => (/FROM clips WHERE/.test(text) ? [row] : []),
    async (pathname) => ({ url: `${base}/${pathname}`, expiresAt: new Date(Date.now() + 60_000) }), framesFromUrl);
  const call = (args: object) => handleMcp(new Request('http://127.0.0.1/mcp', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'get_video_frames', arguments: args } }),
  }), store, ['memory:read', 'media:read']).then((response) => response.json());

  const { result } = await call({ capture_id: CAPTURE, at: ['2026-10-22T09:00:01+00:00', '2026-10-22T17:00:04.900+08:00'], size: 320 });
  assert.deepEqual(result.structuredContent.frames.map((frame: { offset: number }) => frame.offset), [1, 4.75]);
  const images = result.content.filter((item: { type: string }) => item.type === 'image');
  assert.equal(images.length, 2);
  assert.ok(isJpeg(Buffer.from(images[0].data, 'base64')));

  const outside = await call({ capture_id: CAPTURE, at: ['2026-10-22T10:00:00Z'] });
  assert.equal(outside.result.isError, true);
  assert.equal(outside.result.structuredContent.error.code, 'not_found');
  const both = await call({ media_id: MEDIA, offsets: [1], capture_id: CAPTURE, at: ['2026-10-22T09:00:01Z'] });
  assert.equal(both.result.structuredContent.error.code, 'invalid_request');
});

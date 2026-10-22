import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import ffmpeg from '@ffmpeg-installer/ffmpeg';
import { applyMigrations } from '../db/apply.mjs';
import { handleMcp, memoryStore } from '../lib/mcp.ts';
import { minuteMedia } from '../lib/minute-media.ts';
import type { PerceiveInput } from '../lib/openrouter.ts';
import { processReadyMinutes, queueClip, segments, type PerceptionDeps } from '../lib/perception.ts';
import { startPostgres } from './postgres.ts';

// Hearing and seeing without calling models: the queue, readiness, results, retries and the MCP tools over them run
// against a real (in-process) Postgres with stand-ins for the media step and the two models. Synthetic data only.

const CAPTURE = 'web-0b5f3a2e-8d1c-4e7a-9f20-3c4d5e6f7a8b-back';
const SELFIE = 'web-1c6f3a2e-8d1c-4e7a-9f20-3c4d5e6f7a8b-front';
const WALK = 'web-2d7f3a2e-8d1c-4e7a-9f20-3c4d5e6f7a8b-back';
let postgres: Awaited<ReturnType<typeof startPostgres>>;
const query = (text: string, params: unknown[]) => postgres.pool.query(text, params).then((result) => result.rows);
const seen: PerceiveInput[] = [];
let failPerception = false;

const deps: PerceptionDeps = {
  query,
  signDownload: async (pathname) => ({ url: `https://blob.example/${pathname}`, expiresAt: new Date(Date.now() + 60_000) }),
  media: async (clips) => ({
    startedAt: clips[0].startedAt, endedAt: clips.at(-1)!.endedAt, audio: Buffer.from('mp3'),
    frames: clips.map((clip) => ({ at: new Date(clip.startedAt.getTime() + 2500), jpeg: Buffer.from('jpeg') })),
  }),
  transcribe: async () => ({ cost: 0.004, words: [
    { text: 'Pass', start: 1, end: 1.3, speaker: 'speaker_0' }, { text: 'the', start: 1.35, end: 1.5, speaker: 'speaker_0' },
    { text: 'eye drops', start: 1.55, end: 2.2, speaker: 'speaker_0' }, { text: '好的', start: 3, end: 3.4, speaker: 'speaker_1' },
  ] }),
  perceive: async (input) => {
    seen.push(input);
    if (failPerception) throw new Error('model unavailable');
    return { cost: 0.0003, perception: { summary: 'At a desk, the owner asks for eye drops.', place: 'office', activity: 'working',
      objects: [{ name: 'eye drops', detail: 'small white bottle' }], visible_text: [{ text: 'Lumina Tears', on: 'bottle label' }] } };
  },
  language: 'English',
};

async function addClip(seq: number, capturedAt: string, uploadedSecondsAgo: number, capture = CAPTURE, meta: object = {}) {
  await query(`INSERT INTO captures (id, camera, first_clip_at, last_clip_at) VALUES ($1, $3, $2, $2)
    ON CONFLICT (id) DO UPDATE SET last_clip_at = GREATEST(captures.last_clip_at, EXCLUDED.last_clip_at)`,
  [capture, capturedAt, capture.endsWith('-front') ? 'front' : 'back']);
  await query(`INSERT INTO clips (media_id, capture_id, clip_seq, captured_at, captured_end_at, content_type, size_bytes, pathname, meta, uploaded_at)
    VALUES ($1, $2, $3, $4, $4::timestamptz + interval '5 seconds', 'video/mp4', 1000, $5, $7, now() - make_interval(secs => $6))`,
  ['media_' + String(seq).padStart(32, '0'), capture, seq, capturedAt, `captures/${capture}/${String(seq).padStart(7, '0')}.mp4`,
    uploadedSecondsAgo, JSON.stringify(meta)]);
  await queueClip(query, capture, capturedAt);
}
const observation = async (minute: string, capture = CAPTURE) =>
  (await query('SELECT * FROM observations WHERE capture_id = $1 AND minute = $2', [capture, minute]))[0];

before(async () => {
  postgres = await startPostgres();
  const client = await postgres.pool.connect();
  try { await applyMigrations(client); } finally { client.release(); }
});
after(async () => { await postgres?.stop(); });

test('words become speaker turns with wall-clock times', () => {
  const turns = segments([
    { text: 'Pass', start: 1, end: 1.3, speaker: 'a' }, { text: 'the', start: 1.35, end: 1.5, speaker: 'a' },
    { text: '好的', start: 3, end: 3.4, speaker: 'b' }, { text: '我', start: 6, end: 6.2, speaker: 'b' }, { text: '来', start: 6.2, end: 6.4, speaker: 'b' },
  ], new Date('2026-10-22T09:00:00Z'));
  assert.deepEqual(turns, [
    { start: '2026-10-22T09:00:01.000Z', end: '2026-10-22T09:00:01.500Z', speaker: 'a', text: 'Pass the' },
    { start: '2026-10-22T09:00:03.000Z', end: '2026-10-22T09:00:03.400Z', speaker: 'b', text: '好的' },
    { start: '2026-10-22T09:00:06.000Z', end: '2026-10-22T09:00:06.400Z', speaker: 'b', text: '我来' },
  ]);
});

test('a minute waits while it is still being recorded, then is heard and seen once the recording moves on', async () => {
  const minute = '2026-10-22T09:00:00.000Z';
  await addClip(0, '2026-10-22T09:00:50Z', 2);
  await addClip(1, '2026-10-22T09:00:55Z', 1);
  assert.equal(await processReadyMinutes(deps), 0, 'clips of this minute are still arriving');
  await addClip(2, '2026-10-22T09:01:00Z', 0);
  assert.equal(await processReadyMinutes(deps), 1, 'the recording moved on to the next minute');
  const done = await observation(minute);
  assert.equal(done.status, 'done');
  assert.equal(done.summary, 'At a desk, the owner asks for eye drops.');
  assert.deepEqual(done.transcript.map((turn: { speaker: string; text: string; start: string }) => [turn.start, turn.speaker, turn.text]),
    [['2026-10-22T09:00:51.000Z', 'speaker_0', 'Pass the eye drops'], ['2026-10-22T09:00:53.000Z', 'speaker_1', '好的']]);
  assert.match(done.search_text, /Lumina Tears/);
  assert.equal(Number(done.cost_usd), 0.0043);
  assert.deepEqual(seen[0].frames.map((frame) => frame.offset), [2.5, 7.5]);
  assert.match(seen[0].transcript, /\[1\.0s\] speaker_0: Pass the eye drops/);
  assert.equal(seen[0].camera, 'back');

  // A clip that arrives late (the phone was offline) puts the minute back in the queue.
  await addClip(3, '2026-10-22T09:00:45Z', 0);
  assert.equal((await observation(minute)).status, 'pending');
});

test('a failed minute is retried later, not in a tight loop', async () => {
  const minute = '2026-10-22T10:00:00.000Z';
  await addClip(10, '2026-10-22T10:00:00Z', 120, SELFIE);
  failPerception = true;
  try {
    // Both ready minutes fail: the selfie minute, and 09:00 again (its late clip put it back in the queue).
    assert.equal(await processReadyMinutes(deps, { max: 5 }), 2);
    const failed = await observation(minute, SELFIE);
    assert.equal(failed.status, 'failed');
    assert.equal(failed.attempts, 1);
    assert.match(failed.error, /model unavailable/);
    assert.equal(await processReadyMinutes(deps, { max: 5 }), 0, 'backs off before retrying');
  } finally {
    failPerception = false;
  }
  await query(`UPDATE observations SET updated_at = now() - interval '3 minutes' WHERE minute = $1`, [minute]);
  assert.equal(await processReadyMinutes(deps, { max: 5 }), 1);
  assert.equal((await observation(minute, SELFIE)).status, 'done');
  assert.equal(seen.at(-1)!.camera, 'front');
});

test('each minute is seen with the previous minutes of the recording as context, and keeps where the phone was', async () => {
  const fix = { captured_at: '2026-10-22T11:01:20Z', latitude: 31.2304, longitude: 121.4737, accuracy_m: 8 };
  await addClip(20, '2026-10-22T11:00:30Z', 300, WALK);
  await addClip(21, '2026-10-22T11:01:20Z', 300, WALK, { locations: [fix] });
  seen.length = 0;
  assert.equal(await processReadyMinutes(deps, { max: 5 }), 2);
  const [first, second] = seen;
  assert.equal(first.context, '');
  assert.equal(second.context, '1 min earlier: At a desk, the owner asks for eye drops.');
  const store = memoryStore(query, deps.signDownload, async () => []);
  const response = await handleMcp(new Request('http://127.0.0.1/mcp', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'list_observations', arguments: { capture_id: WALK } } }),
  }), store, ['memory:read']);
  const { observations } = (await response.json()).result.structuredContent;
  assert.deepEqual(observations.map((item: { location: unknown }) => item.location), [null, fix]);
});

test('MCP lists observations by time and finds them by words in speech or scene', async () => {
  const store = memoryStore(query, deps.signDownload, async () => []);
  const call = (name: string, args: object) => handleMcp(new Request('http://127.0.0.1/mcp', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
  }), store, ['memory:read']).then((response) => response.json()).then((body) => body.result.structuredContent);

  const listed = await call('list_observations', { started_at: '2026-10-22T09:00:30Z', ended_at: '2026-10-22T09:01:30Z' });
  assert.deepEqual(listed.observations.map((item: { minute: string; status: string }) => [item.minute, item.status]),
    [['2026-10-22T09:00:00.000Z', 'failed'], ['2026-10-22T09:01:00.000Z', 'pending']]);
  const found = await call('search_observations', { query: 'eye drops' });
  assert.deepEqual(found.observations.map((item: { capture_id: string; minute: string }) => [item.capture_id, item.minute]),
    [[WALK, '2026-10-22T11:01:00.000Z'], [WALK, '2026-10-22T11:00:00.000Z'], [SELFIE, '2026-10-22T10:00:00.000Z']]);
  assert.deepEqual(found.observations[0].matching_speech.map((turn: { text: string }) => turn.text), ['Pass the eye drops']);
  assert.equal((await call('search_observations', { query: 'lumina 50%' })).observations.length, 0, '% is matched literally');
});

test('a minute\'s media: one still per clip and the clips\' sound on one timeline', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'eleagent-minute-test-'));
  const server: Server = createServer(async (request, response) => response.end(await readFile(join(dir, request.url!.slice(1)))))
    .listen(0, '127.0.0.1');
  try {
    await new Promise((resolve) => server.once('listening', resolve));
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    for (const name of ['a.webm', 'b.webm']) {
      await promisify(execFile)(ffmpeg.path, ['-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc=duration=5:size=640x480:rate=15',
        '-f', 'lavfi', '-i', 'sine=duration=5', '-c:v', 'libvpx', '-c:a', 'libopus', join(dir, name)]);
    }
    const start = Date.parse('2026-10-22T09:00:00Z');
    const media = await minuteMedia([
      { url: `${base}/a.webm`, startedAt: new Date(start), endedAt: new Date(start + 5000) },
      { url: `${base}/b.webm`, startedAt: new Date(start + 10_000), endedAt: new Date(start + 15_000) },
    ]);
    assert.deepEqual(media.frames.map((frame) => frame.at.toISOString()), ['2026-10-22T09:00:02.500Z', '2026-10-22T09:00:12.500Z']);
    assert.ok(media.frames.every((frame) => frame.jpeg[0] === 0xff && frame.jpeg[1] === 0xd8));
    assert.equal(media.endedAt.toISOString(), '2026-10-22T09:00:15.000Z');
    assert.ok(media.audio && media.audio.length > 40_000, 'about 15 s of 48 kbit/s MP3, including the 5 s gap');
  } finally {
    server.close();
    await rm(dir, { recursive: true, force: true });
  }
});

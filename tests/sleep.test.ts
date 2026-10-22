import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { applyMigrations } from '../db/apply.mjs';
import { handleMcp, memoryStore } from '../lib/mcp.ts';
import { dueDays, episodesOf, instantAt, localDay, talksOf, type Minute } from '../lib/sleep.ts';
import { runTool, type SleepRun } from '../lib/sleep-tools.ts';
import { startPostgres } from './postgres.ts';

// The sleeping agent's tools against a real (in-process) Postgres, called the way the agent calls them, plus the
// MCP memory tools over what they write. Synthetic data only.

const TZ = 'Asia/Shanghai';
const CAPTURE = 'web-0b5f3a2e-8d1c-4e7a-9f20-3c4d5e6f7a8b-back';
let postgres: Awaited<ReturnType<typeof startPostgres>>;
const query = (text: string, params: unknown[]) => postgres.pool.query(text, params).then((result) => result.rows);
const frames: number[][] = [];
const deps = {
  query,
  signDownload: async (pathname: string) => ({ url: `https://blob.example/${pathname}`, expiresAt: new Date() }),
  extractFrames: async (_url: string, offsets: number[]) => { frames.push(offsets); return offsets.map(() => Buffer.from('jpeg')); },
};
const run: SleepRun = { day: '2026-10-22', timeZone: TZ, startedAt: '2026-10-22T00:00:00.000Z' };
const tool = (name: string, args: Record<string, unknown> = {}) => runTool(deps, run, name, args).then((result) => result.text);

async function addMinute(minute: string, summary: string, speech: string[], location: object | null = null) {
  await query(`INSERT INTO captures (id, camera, first_clip_at, last_clip_at) VALUES ($1, 'back', $2::timestamptz, $2::timestamptz)
    ON CONFLICT (id) DO UPDATE SET last_clip_at = GREATEST(captures.last_clip_at, EXCLUDED.last_clip_at)`, [CAPTURE, minute]);
  await query(`INSERT INTO clips (media_id, capture_id, clip_seq, captured_at, captured_end_at, content_type, size_bytes, pathname, meta)
    VALUES ('media_' || md5($2::text), $1, (SELECT count(*) FROM clips), $2::timestamptz, $2::timestamptz + interval '60 seconds', 'video/mp4', 1, md5($2::text), $3)`,
  [CAPTURE, minute, JSON.stringify({ locations: location ? [location] : [] })]);
  const transcript = speech.map((text, i) => ({ start: new Date(Date.parse(minute) + (i + 1) * 5000).toISOString(), end: minute, speaker: `speaker_${i % 2}`, text }));
  await query(`INSERT INTO observations (capture_id, minute, status, clip_count, processed_clips, started_at, ended_at, summary, perception, transcript, search_text)
    VALUES ($1, $2::timestamptz, 'done', 1, 1, $2::timestamptz, $2::timestamptz + interval '60 seconds', $3::text, $4, $5, $3::text)`,
  [CAPTURE, minute, summary, JSON.stringify({ place: 'office', activity: 'working', visible_text: [{ text: 'Lumina Tears', on: 'bottle' }] }), JSON.stringify(transcript)]);
}

before(async () => {
  postgres = await startPostgres();
  const client = await postgres.pool.connect();
  try { await applyMigrations(client); } finally { client.release(); }
  // 09:00–09:02 in Shanghai with speech, a gap, 09:30 with speech, 09:31 silent.
  await addMinute('2026-10-22T01:00:00Z', 'At a desk.', ['Pass me the eye drops', '好的']);
  await addMinute('2026-10-22T01:01:00Z', 'Using the eye drops.', ['These are Lumina Tears']);
  await addMinute('2026-10-22T01:02:00Z', 'Typing.', []);
  await addMinute('2026-10-22T01:30:00Z', 'A video plays on a laptop.', ['…and that is the weather for today']);
  await addMinute('2026-10-22T01:31:00Z', 'Walking outside.', [], { latitude: 31.25, longitude: 121.5 });
  await query(`INSERT INTO sleep_days (day, timezone, status, started_at) VALUES ('2026-10-22', $1, 'running', $2)`, [TZ, run.startedAt]);
});
after(async () => { await postgres?.stop(); });

test('local days and times follow the owner\'s time zone, including daylight-saving changes', () => {
  assert.equal(localDay(new Date('2026-10-21T17:30:00Z'), TZ), '2026-10-22');
  assert.equal(instantAt('2026-10-22', '09:01', TZ)?.toISOString(), '2026-10-22T01:01:00.000Z');
  assert.equal(instantAt('2026-03-08', '03:30', 'America/Los_Angeles')?.toISOString(), '2026-03-08T10:30:00.000Z');
});

test('a day is cut into episodes at gaps and moves, and into conversation candidates where there is speech', () => {
  const minute = (at: string, speech: boolean, latitude?: number): Minute => ({ capture_id: CAPTURE, minute: at, started_at: at,
    ended_at: new Date(Date.parse(at) + 60_000).toISOString(), summary: '', perception: {},
    transcript: speech ? [{ start: at, speaker: 's', text: 'hi' }] : [], location: latitude === undefined ? null : { latitude, longitude: 121.47 } });
  const minutes = [minute('2026-10-22T01:00:00Z', true, 31.23), minute('2026-10-22T01:02:00Z', true, 31.2301),
    minute('2026-10-22T01:05:00Z', true, 31.2301), minute('2026-10-22T01:30:00Z', false, 31.2301), minute('2026-10-22T01:31:00Z', true, 31.26)];
  assert.deepEqual(episodesOf(minutes, TZ).map((episode) => [episode.id, episode.minutes.length]),
    [['episode:20261022-0900', 3], ['episode:20261022-0930', 1], ['episode:20261022-0931', 1]]);
  assert.deepEqual(talksOf(minutes, TZ).map((talk) => [talk.id, talk.minutes]),
    [['talk:20261022-0900', 2], ['talk:20261022-0905', 1], ['talk:20261022-0931', 1]]);
});

test('recall_day and view_episode show the day; view_moments shows what the camera saw', async () => {
  const recalled = await tool('recall_day');
  assert.match(recalled, /episode:20261022-0900 {2}09:00–09:03, 3 min \| office/);
  assert.match(recalled, /talk:20261022-0900 {2}09:00–09:02, 2 min, 3 turns, up to 2 speakers per minute — not yet remembered or dismissed/);
  assert.match(recalled, /talk:20261022-0930/);
  assert.match(await tool('view_episode', { id: 'episode:20261022-0900' }), /\[09:00:05\] speaker_0: Pass me the eye drops/);
  assert.match(await runTool(deps, run, 'view_episode', { id: 'episode:nope' }).catch((error) => error.message), /No episode/);
  const moments = await runTool(deps, run, 'view_moments', { times: ['09:01:30', '12:00'] });
  assert.equal(moments.images?.length, 1);
  assert.match(moments.text, /image 1: 09:01:30 .*\n12:00:00: nothing was recorded/);
  assert.deepEqual(frames, [[30]]);
});

test('the agent builds memories, occurrences and the diary, and finish holds it to the conversations and the diary', async () => {
  assert.match(await tool('consolidate', { kind: 'object', name: 'Lumina Tears eye drops', description: 'Eye drops on the desk.',
    evidence: [{ time: '09:01', text: 'named aloud' }] }), /Created object:lumina-tears-eye-drops/);
  await tool('consolidate', { kind: 'object', name: 'Eye drops bottle', description: 'A small bottle.' });
  assert.match(await tool('consolidate', { id: 'object:lumina-tears-eye-drops', kind: 'object', name: 'Lumina Tears eye drops',
    description: 'Lumina Tears, a small white bottle kept on the desk.', merge: ['object:eye-drops-bottle', 'person:owner'] }),
  /Updated object:lumina-tears-eye-drops; merged object:eye-drops-bottle into it/);
  assert.match(await tool('consolidate', { kind: 'person', name: 'Desk colleague', description: 'Sits next to the owner.' }), /person:desk-colleague/);
  assert.match(await tool('remember_event', { title: 'Used eye drops', description: '…', start: '09:01', end: '09:02', related: ['object:lumina-tears-eye-drops'] }),
    /Saved event:20261022-0901-used-eye-drops, linked to object:lumina-tears-eye-drops/);

  assert.match(await tool('finish'), /Not finished: conversation candidates neither remembered nor dismissed: talk:20261022-0900, talk:20261022-0930; the diary was not written/);
  assert.match(await tool('remember_conversation', { talk: 'talk:20261022-0900', title: 'Asking for eye drops', summary: 'The owner asked for the eye drops.',
    participants: ['person:desk-colleague'] }), /Saved conversation:20261022-0900-asking-for-eye-drops with 3 transcribed turns, linked to person:desk-colleague/);
  assert.match(await tool('dismiss_conversation', { talk: 'talk:20261022-0930', reason: 'a weather video playing' }), /Dismissed/);
  assert.match(await tool('forget', { ids: ['person:owner', 'conversation:20261022-0900-asking-for-eye-drops'] }), /cannot be forgotten/);
  assert.match(await tool('link', { a: 'person:desk-colleague', b: 'object:lumina-tears-eye-drops', text: 'Handed them over on 2026-10-22.' }), /Linked/);
  assert.match(await tool('write_diary', { title: 'Eye drops', text: 'I asked for my eye drops ⟦09:00⟧ and used them ⟦09:01⟧; later ⟦11:00⟧.',
    refs: ['object:lumina-tears-eye-drops'] }), /3 time anchors; nothing was recorded at 11:00/);
  assert.equal(await tool('finish'), 'The night is complete. Stop here.');
  assert.equal((await query("SELECT status FROM sleep_days WHERE day = '2026-10-22'", []))[0].status, 'done');
  assert.equal((await query("SELECT count(*)::int AS n FROM entities WHERE id = 'object:eye-drops-bottle'", []))[0].n, 0, 'merged away');
  assert.deepEqual(await dueDays(query, TZ, new Date('2026-10-23T12:00:00Z')), [], 'a slept day is not due again');
});

test('MCP reads what sleep wrote, like the self-hosted graph', async () => {
  const store = memoryStore(query, deps.signDownload, async () => []);
  const call = (name: string, args: object) => handleMcp(new Request('http://127.0.0.1/mcp', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
  }), store, ['memory:read']).then((response) => response.json()).then((body) => body.result.structuredContent);
  const diary = await call('get_entity', { id: 'diary:20261022' });
  assert.deepEqual(diary.properties.moments.map((moment: { anchor: string; minute: string | null }) => [moment.anchor, moment.minute]),
    [['09:00', '2026-10-22T01:00:00.000Z'], ['09:01', '2026-10-22T01:01:00.000Z'], ['11:00', null]]);
  const conversation = await call('get_entity', { id: 'conversation:20261022-0900-asking-for-eye-drops' });
  assert.deepEqual(conversation.properties.transcript.map((turn: { text: string }) => turn.text), ['Pass me the eye drops', '好的', 'These are Lumina Tears']);
  assert.deepEqual((await call('search_entities', { search: 'Lumina', filter: { kind: 'object' } })).entities.map((e: { id: string }) => e.id),
    ['object:lumina-tears-eye-drops']);
  const links = await call('list_entity_links', { id: 'object:lumina-tears-eye-drops' });
  assert.deepEqual(links.links.map((link: { a: string; b: string }) => `${link.a} ${link.b}`).sort(), [
    'diary:20261022 object:lumina-tears-eye-drops', 'event:20261022-0901-used-eye-drops object:lumina-tears-eye-drops',
    'object:lumina-tears-eye-drops person:desk-colleague']);
  assert.equal((await call('get_subgraph', { ids: ['person:desk-colleague'], depth: 2 })).entities.length, 5);
});

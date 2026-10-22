import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { applyMigrations } from '../db/apply.mjs';
import { handleMcp, memoryStore } from '../lib/mcp.ts';
import { dueDays, episodesOf, instantAt, localDay, sleepDay, sleepDueDays, type Minute, type SleepDeps } from '../lib/sleep.ts';
import { startPostgres } from './postgres.ts';

// Sleep against a real (in-process) Postgres with a stand-in for the text model: episodes, the day's memories, links
// and diary, re-running a day, and the MCP memory tools. Synthetic data only.

const TZ = 'Asia/Shanghai';
const CAPTURE = 'web-0b5f3a2e-8d1c-4e7a-9f20-3c4d5e6f7a8b-back';
let postgres: Awaited<ReturnType<typeof startPostgres>>;
const query = (text: string, params: unknown[]) => postgres.pool.query(text, params).then((result) => result.rows);
const prompts: { system: string; user: string }[] = [];

const consolidation: { memories: { id: string | null; [key: string]: unknown }[]; events: Record<string, unknown>[]; [key: string]: unknown } = {
  diary: { title: 'A desk day', text: 'I started at my desk ⟦09:00⟧ and asked a colleague for the Lumina Tears eye drops ⟦09:01⟧.' },
  memories: [
    { id: null, kind: 'object', name: 'Lumina Tears eye drops', description: 'A small white bottle of eye drops kept on the desk.',
      evidence: [{ time: '09:01', text: 'asked for them by name' }] },
    { id: null, kind: 'person', name: 'Desk colleague', description: 'A colleague who sits next to the owner.', evidence: [] },
    { id: 'person:owner', kind: 'person', name: 'Owner', description: 'Works at a desk and uses eye drops.', evidence: [] },
  ],
  events: [{ title: 'Asked for eye drops', description: 'Asked the colleague to pass the eye drops.', start: '09:01', end: '09:01',
    related: ['Lumina Tears eye drops'] }],
  conversations: [{ title: 'Eye drops request', summary: 'The owner asked for the eye drops; the colleague agreed.', start: '09:01',
    end: '09:01', participants: ['person:owner', 'Desk colleague'] }],
  links: [{ a: 'person:owner', b: 'Lumina Tears eye drops', text: 'The owner uses these eye drops at the desk.' },
    { a: 'Desk colleague', b: 'nobody known', text: 'ignored: unknown memory' }],
  diary_mentions: ['Lumina Tears eye drops', 'Desk colleague'],
};
const deps: SleepDeps = {
  query,
  language: 'English',
  complete: async (system, user) => {
    prompts.push({ system, user });
    if (system.includes('Digest one episode')) return { cost: 0.001, json: { title: 'At the desk', summary: 'Worked; asked for eye drops.' } };
    return { cost: 0.01, json: consolidation };
  },
};

async function addMinute(minute: string, summary: string, location: object | null = null) {
  await query(`INSERT INTO captures (id, camera, first_clip_at, last_clip_at) VALUES ($1, 'back', $2, $2)
    ON CONFLICT (id) DO UPDATE SET last_clip_at = GREATEST(captures.last_clip_at, EXCLUDED.last_clip_at)`, [CAPTURE, minute]);
  await query(`INSERT INTO clips (media_id, capture_id, clip_seq, captured_at, captured_end_at, content_type, size_bytes, pathname, meta)
    VALUES ('media_' || md5($2::text), $1, (SELECT count(*) FROM clips), $2::timestamptz, $2::timestamptz + interval '5 seconds', 'video/mp4', 1, md5($2::text), $3)`,
  [CAPTURE, minute, JSON.stringify({ locations: location ? [location] : [] })]);
  await query(`INSERT INTO observations (capture_id, minute, status, clip_count, processed_clips, started_at, ended_at, summary, perception, transcript, search_text)
    VALUES ($1, $2::timestamptz, 'done', 1, 1, $2::timestamptz, $2::timestamptz + interval '5 seconds', $3::text, $4, $5, $3::text)`,
  [CAPTURE, minute, summary, JSON.stringify({ place: 'office', activity: 'working' }),
    JSON.stringify([{ start: new Date(Date.parse(minute) + 1000).toISOString(), end: minute, speaker: 'speaker_0', text: 'Pass me the eye drops' }])]);
}

before(async () => {
  postgres = await startPostgres();
  const client = await postgres.pool.connect();
  try { await applyMigrations(client); } finally { client.release(); }
  // 09:00 and 09:01 in Shanghai on 2026-10-22, then a gap, then somewhere else.
  await addMinute('2026-10-22T01:00:00Z', 'At a desk.', { latitude: 31.2304, longitude: 121.4737 });
  await addMinute('2026-10-22T01:01:00Z', 'Asked a colleague for eye drops.', { latitude: 31.2305, longitude: 121.4737 });
  await addMinute('2026-10-22T01:30:00Z', 'Walking outside.', { latitude: 31.25, longitude: 121.5 });
});
after(async () => { await postgres?.stop(); });

test('local days and times follow the owner\'s time zone', () => {
  assert.equal(localDay(new Date('2026-10-21T17:30:00Z'), TZ), '2026-10-22');
  assert.equal(instantAt('2026-10-22', '09:01', TZ)?.toISOString(), '2026-10-22T01:01:00.000Z');
  assert.equal(instantAt('2026-03-08', '03:30', 'America/Los_Angeles')?.toISOString(), '2026-03-08T10:30:00.000Z');
});

test('a day is cut into episodes at gaps and moves', () => {
  const minute = (at: string, latitude?: number): Minute => ({ capture_id: CAPTURE, minute: at, started_at: at, ended_at: at, summary: '',
    perception: {}, transcript: [], location: latitude === undefined ? null : { latitude, longitude: 121.47 } });
  const episodes = episodesOf([minute('2026-10-22T01:00:00Z', 31.23), minute('2026-10-22T01:05:00Z', 31.2301),
    minute('2026-10-22T01:30:00Z', 31.2301), minute('2026-10-22T01:31:00Z', 31.26)], TZ);
  assert.deepEqual(episodes.map((episode) => [episode.id, episode.minutes.length]),
    [['episode:20261022-0900', 2], ['episode:20261022-0930', 1], ['episode:20261022-0931', 1]]);
});

test('a day becomes memories, events, conversations, links and a diary', async () => {
  assert.deepEqual(await dueDays(query, TZ, new Date('2026-10-22T12:00:00Z')), [], 'the day has not ended yet');
  assert.deepEqual(await dueDays(query, TZ, new Date('2026-10-22T17:00:00Z')), ['2026-10-22']);
  assert.equal(await sleepDueDays(deps, TZ, {}), false);
  // sleepDueDays used the real clock, so sleep the day directly as a manual run would.
  assert.equal(await sleepDay(deps, '2026-10-22', TZ), true);
  assert.equal(prompts.filter((prompt) => prompt.system.includes('Digest one episode')).length, 2, 'two episodes, digested once each');
  assert.match(prompts.find((prompt) => prompt.system.includes('Digest one episode'))!.user, /\[09:00:01\] speaker_0: Pass me the eye drops/);

  const entities = await query('SELECT id, kind, name, properties FROM entities ORDER BY id', []);
  assert.deepEqual(entities.map((row) => row.id), ['conversation:20261022-0901-eye-drops-request', 'diary:20261022',
    'event:20261022-0901-asked-for-eye-drops', 'object:lumina-tears-eye-drops', 'person:desk-colleague', 'person:owner']);
  const byId = Object.fromEntries(entities.map((row) => [row.id, row]));
  assert.equal(byId['event:20261022-0901-asked-for-eye-drops'].properties.t_start, '2026-10-22T01:01:00.000Z');
  assert.deepEqual(byId['conversation:20261022-0901-eye-drops-request'].properties.transcript.map((turn: { text: string }) => turn.text),
    ['Pass me the eye drops']);
  assert.deepEqual(byId['diary:20261022'].properties.moments.map((moment: { anchor: string; minute: string }) => [moment.anchor, moment.minute]),
    [['09:00', '2026-10-22T01:00:00.000Z'], ['09:01', '2026-10-22T01:01:00.000Z']]);
  assert.equal(byId['person:owner'].properties.description, 'Works at a desk and uses eye drops.');
  const links = await query('SELECT a, b FROM entity_links ORDER BY a, b', []);
  assert.deepEqual(links.map((row) => `${row.a} — ${row.b}`), [
    'conversation:20261022-0901-eye-drops-request — person:desk-colleague',
    'conversation:20261022-0901-eye-drops-request — person:owner',
    'diary:20261022 — object:lumina-tears-eye-drops',
    'diary:20261022 — person:desk-colleague',
    'event:20261022-0901-asked-for-eye-drops — object:lumina-tears-eye-drops',
    'object:lumina-tears-eye-drops — person:owner',
  ]);
  assert.equal((await query("SELECT status FROM sleep_days WHERE day = '2026-10-22'", []))[0].status, 'done');
});

test('sleeping a day again rewrites its occurrences and diary but keeps and enriches memories', async () => {
  prompts.length = 0;
  consolidation.memories[0] = { ...consolidation.memories[0], id: 'object:lumina-tears-eye-drops' };
  consolidation.events[0] = { ...consolidation.events[0], title: 'Asked for the eye drops' };
  assert.equal(await sleepDay(deps, '2026-10-22', TZ), true);
  assert.equal(prompts.filter((prompt) => prompt.system.includes('Digest one episode')).length, 0, 'unchanged episodes keep their digests');
  assert.match(prompts[0].user, /object:lumina-tears-eye-drops \| object \| Lumina Tears eye drops/, 'existing memories are offered');
  const ids = (await query("SELECT id FROM entities WHERE kind IN ('event', 'object') ORDER BY id", [])).map((row) => row.id);
  assert.deepEqual(ids, ['event:20261022-0901-asked-for-the-eye-drops', 'object:lumina-tears-eye-drops']);
  const drops = (await query("SELECT properties FROM entities WHERE id = 'object:lumina-tears-eye-drops'", []))[0].properties;
  assert.equal(drops.evidence.length, 2, 'evidence accumulates');
});

test('MCP reads memories like the self-hosted graph: search, entity, links, subgraph', async () => {
  const store = memoryStore(query, async () => ({ url: '', expiresAt: new Date() }), async () => []);
  const call = (name: string, args: object) => handleMcp(new Request('http://127.0.0.1/mcp', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
  }), store, ['memory:read']).then((response) => response.json()).then((body) => body.result.structuredContent);

  const diaries = await call('search_entities', { filter: { kind: 'diary' } });
  assert.deepEqual(diaries.entities.map((item: { id: string }) => item.id), ['diary:20261022']);
  assert.match(diaries.entities[0].properties.text, /Lumina Tears/);
  const found = await call('search_entities', { search: 'eye drops', filter: { kind: 'object' } });
  assert.deepEqual(found.entities.map((item: { id: string }) => item.id), ['object:lumina-tears-eye-drops']);
  assert.equal((await call('get_entity', { id: 'person:owner' })).properties.name, 'Owner');
  assert.equal((await call('get_entity', { id: 'person:nobody' })).error.code, 'not_found');
  const links = await call('list_entity_links', { id: 'object:lumina-tears-eye-drops' });
  assert.equal(links.links.length, 3);
  const graph = await call('get_subgraph', { ids: ['person:owner'], depth: 2, max_entities: 4 });
  assert.equal(graph.entities.length, 4);
  assert.equal(graph.truncated, true);
});

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Memory, pairKey } from './memory.mjs';
import { readTimeline } from './timeline.mjs';

const at = (seconds) => new Date(Date.parse('2026-10-14T12:00:00Z') + seconds * 1000).toISOString();
const event = (id, seconds, kind = 'minicpm', capture = 'capture-1') => ({ event_id: id, kind, capture_id: capture,
  started_at: at(seconds), ended_at: at(seconds + 5), body: kind === 'minicpm' ? { generated_text: 'A device plays a tutorial' } : { text: 'Please open Settings' } });
const episode = (id, start, end) => ({ id, kind: 'episode', capture_id: 'capture-1', t_start: at(start), t_end_us: Date.parse(at(end)) * 1000,
  duration_s: end - start, observations: ['old unanchored summary'] });

function memory(t, nodes = {}, edges = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sleep-memory-test-'));
  fs.writeFileSync(path.join(dir, 'working.json'), JSON.stringify({ nodes, edges, day: '2026-10-14', captures: ['capture-1'] }));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return new Memory(dir);
}

function archive(t, handler) {
  const prior = { url: process.env.ARCHIVE_URL, token: process.env.SCENE_ARCHIVE_TOKEN, fetch: globalThis.fetch };
  process.env.ARCHIVE_URL = 'http://archive.test'; process.env.SCENE_ARCHIVE_TOKEN = 'synthetic-test-token';
  globalThis.fetch = async (url) => ({ ok: true, json: async () => handler(new URL(url)) });
  t.after(() => {
    globalThis.fetch = prior.fetch;
    for (const [key, value] of [['ARCHIVE_URL', prior.url], ['SCENE_ARCHIVE_TOKEN', prior.token]]) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  });
}

test('archive pagination retains timestamp ties and obeys the bounded capture query', async (t) => {
  const requests = [];
  archive(t, (url) => {
    requests.push(url);
    if (url.searchParams.get('kind') === 'speech') return { items: [event('s1', 5, 'speech')], has_more: false };
    return url.searchParams.has('after') ? { items: [event('m2', 0), event('m3', 10)], has_more: false }
      : { items: [event('m1', 0)], has_more: true, next_cursor: 'm1' };
  });
  assert.deepEqual((await readTimeline('capture-1', Date.parse(at(0)), Date.parse(at(15)))).map((e) => e.event_id), ['m1', 'm2', 's1', 'm3']);
  for (const url of requests) {
    assert.equal(url.searchParams.get('capture_id'), 'capture-1');
    assert.equal(url.searchParams.get('started_at'), at(0));
    assert.equal(url.searchParams.get('ended_at'), at(15));
  }
  assert.equal(requests.filter((url) => url.searchParams.get('after') === 'm1').length, 1);
});

test('non-advancing archive cursor fails instead of accepting an incomplete timeline', async (t) => {
  archive(t, (url) => url.searchParams.get('kind') === 'speech' ? { items: [], has_more: false }
    : { items: [event('m1', 0)], has_more: true, next_cursor: 'm1' });
  await assert.rejects(readTimeline('capture-1', Date.parse(at(0)), Date.parse(at(10))), /pagination did not advance/);
});

test('semantic event crosses physical episodes while preserving sources and only attaching overlapping clips', async (t) => {
  const ep1 = episode('episode:a', 0, 10), ep2 = episode('episode:b', 10, 20);
  const conv = { id: 'conversation:x', kind: 'conversation', layer: 'memory', t_start: at(0), t_last: at(20), transcript: [{ t: at(5), text: 'Open Settings', speaker: 'unknown' }] };
  const m = memory(t, { [ep1.id]: ep1, [ep2.id]: ep2, [conv.id]: conv });
  archive(t, (url) => {
    if (url.pathname.endsWith('/media')) return { items: [-5, 0, 5, 10, 15, 20].map((s) => ({ media_id: `clip-${s}`, capture_id: 'capture-1', captured_at: at(s), duration_seconds: 5 })), has_more: false };
    if (url.searchParams.get('kind') === 'speech') return { items: [event('speech', 5, 'speech')], has_more: false };
    return { items: [event('before', 0), event('first', 5), event('last', 10), event('after', 15)], has_more: false };
  });
  const viewed = await m.view_episode({ id: ep1.id });
  assert.match(viewed.text, /first \| 05:00:05–05:00:10/);
  assert.doesNotMatch(viewed.text, /- old unanchored summary/);
  await m.view_episode({ id: ep2.id });
  await m.remember_event({ first: 'first', last: 'last', title: 'Watching a phone tutorial', description: 'The topic changes to phone settings within the inspected windows.',
    evidence: [{ id: conv.id, text: 'The transcript contains the device tutorial.' }] });
  const saved = [...m.nodes.values()].find((n) => n.kind === 'event');
  assert.equal(saved.t_start, at(5)); assert.equal(saved.t_last, at(15));
  assert.deepEqual(saved.media_ids, ['clip-5', 'clip-10']);
  assert.deepEqual(m.nodes.get(ep1.id), ep1); assert.deepEqual(m.nodes.get(ep2.id), ep2);
  assert.deepEqual(m.nodes.get(conv.id), conv);
  assert.ok(m.edges.has(pairKey(saved.id, conv.id)));
  // New event records use only properties already used by existing memory entities.
  assert.deepEqual(Object.keys(saved).sort(), ['id', 'kind', 'layer', 'name', 'description', 'summary', 'text', 't_start', 't_last',
    't_start_us', 't_end_us', 'media_ids', 'occurrences', 'created_by', 'nights', '_touched'].sort());
  await assert.rejects(m.remember_event({ first: 'first', last: 'last', title: 'Duplicate', description: 'Duplicate' }), /already covers/);
  await m.write_diary({ title: 'Today', text: 'Watched a phone tutorial.', refs: [saved.id] });
  await m.finish();
  const result = JSON.parse(fs.readFileSync(path.join(m.dir, 'result.json'), 'utf8'));
  const persisted = result.upserts.find((n) => n.id === saved.id);
  assert.deepEqual(Object.keys(persisted).sort(), ['id', 'kind', 'layer', 'name', 'description', 'summary', 'text', 't_start', 't_last',
    't_start_us', 't_end_us', 'media_ids', 'occurrences', 'created_by', 'nights'].sort());
  assert.doesNotMatch(JSON.stringify(result), /"(?:timeline|first|last|event_id|started_at|ended_at)"/);
});

test('invalid or unavailable event evidence cannot mutate memory or consume an episode', async (t) => {
  const ep = episode('episode:a', 0, 10), m = memory(t, { [ep.id]: ep });
  const before = JSON.stringify([...m.nodes]);
  await assert.rejects(m.remember_event({ first: 'unseen', last: 'unseen', title: 'Test', description: 'Test' }), /Inspect/);
  await assert.rejects(m.consolidate({ ids: [ep.id], new: { kind: 'event', name: 'Test', description: 'Test' }, why: 'test' }), /remember_event/);
  m.timeline.set('a', event('a', 5)); m.timeline.set('b', event('b', 0)); m.timeline.set('c', event('c', 10, 'minicpm', 'other-capture'));
  for (const last of ['b', 'c']) await assert.rejects(m.remember_event({ first: 'a', last, title: 'Test', description: 'Test' }), /ordered windows/);
  archive(t, () => { throw new Error('offline'); });
  await assert.rejects(m.remember_event({ first: 'a', last: 'a', title: 'Test', description: 'Test' }), /offline/);
  assert.equal(JSON.stringify([...m.nodes]), before);
  const view = await m.view_episode({ id: ep.id });
  assert.match(view.text, /no per-observation timestamps/);
  assert.match(view.text, /old unanchored summary/);
});

test('merging events preserves the latest evidence end rather than the latest start', async (t) => {
  const a = { id: 'event:a', kind: 'event', layer: 'memory', name: 'Activity', t_start: at(0), t_last: at(90), occurrences: 0 };
  const b = { id: 'event:b', kind: 'event', layer: 'memory', name: 'Activity', t_start: at(30), t_last: at(60), occurrences: 0 };
  const m = memory(t, { [a.id]: a, [b.id]: b });
  await m.consolidate({ ids: [b.id], into: a.id, why: 'same occurrence' });
  assert.equal(m.nodes.get(a.id).t_start, at(0)); assert.equal(m.nodes.get(a.id).t_last, at(90));
  assert.equal(m.nodes.get(a.id).t_end_us, Date.parse(at(90)) * 1000);
  assert.equal(m.nodes.has(b.id), false);
});

test('memory evidence does not turn model references or missing dates into a use history', async (t) => {
  const entity = { id: 'object:a', kind: 'object', layer: 'memory', name: 'Object', occurrences: 5 };
  const diary = { id: 'diary:20261014', kind: 'diary', layer: 'memory', name: 'Diary' };
  const m = memory(t, { [entity.id]: entity, [diary.id]: diary });
  const before = m.evidenceLine(entity);
  await m.link({ a: diary.id, b: entity.id, text: 'The diary mentions the object.' });
  assert.equal(m.evidenceLine(entity), before);
  const view = await m.recall_day();
  assert.match(view.text, /source material count 5; evidence time envelope unknown – unknown/);
  assert.match(view.text, /not recall histories/);
  assert.equal(m.nodes.get(entity.id).occurrences, 5);
});

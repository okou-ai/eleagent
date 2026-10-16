import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import * as capture from '../capture-state.js';

const source = readFileSync(new URL('../app.js', import.meta.url), 'utf8');
function harness(responses, { storageUnavailable = false } = {}) {
  const elements = new Map();
  const get = id => {
    if (!elements.has(id)) elements.set(id, { textContent: '', dataset: {}, classList: { toggle() {} }, setAttribute() {}, addEventListener() {} });
    return elements.get(id);
  };
  let clip = { meta: { capture_id: 'web-synthetic-back', clip_seq: 7 }, blob: new Blob(['video'], { type: 'video/webm' }) };
  let removed = 0;
  const storage = new Map([['eleagent-token', 'legacy-private-credential'], ['eleagent-camera', 'front']]);
  const storageCalls = [];
  const redirects = [], calls = [], timers = new Map(), events = new Map();
  let timerId = 0;
  const context = {
    ...capture, document: { getElementById: get, addEventListener() {}, hidden: false },
    window: { addEventListener(name, handler) { events.set(name, handler); }, location: { assign(url) { redirects.push(url); } } },
    navigator: { onLine: true }, performance, localStorage: {
      getItem(key) { storageCalls.push(['getItem', key]); assert.notEqual(key, 'eleagent-token'); return storage.get(key) ?? null; },
      setItem(key, value) { storageCalls.push(['setItem', key]); assert.notEqual(key, 'eleagent-token'); storage.set(key, value); },
      removeItem(key) { storageCalls.push(['removeItem', key]); if (storageUnavailable) throw new Error('storage unavailable'); storage.delete(key); },
    },
    setTimeout: fn => { timers.set(++timerId, fn); return timerId; }, clearTimeout: id => timers.delete(id),
    setInterval() {}, clearInterval() {}, Blob, FormData, AbortController, Promise,
    fetch: async (...args) => { calls.push(args); return Array.isArray(responses) ? responses.shift() : responses; },
  };
  vm.runInNewContext(source.replace(/^import [\s\S]*?;\n/gm, '').replace(/\nvoid pollObservation\(\);\nvoid initialize\(\);\s*$/, '') + `
    globalThis.api = { start, upload, pollObservation, signIn, state, renderObservation,
      setQueue(value) { queue = value; ready = true; },
      setLoop(value) { session = value; },
      observation: () => observation,
      blocked: () => blocked
    };
  `, context);
  context.api.setQueue({
    async first() { return clip; },
    async remove() { removed++; clip = null; },
    async stats() { return { count: clip ? 1 : 0, bytes: clip ? 5 : 0 }; },
  });
  return { ...context.api, elements, timers, events, calls, redirects, storage, storageCalls, removed: () => removed };
}

test('latest capture UI has no token field, fragment handler or browser credential; camera preference remains', () => {
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  assert.doesNotMatch(html, /id=["']token["']|service token|access token/i);
  assert.doesNotMatch(source, /TOKEN_KEY|URLSearchParams|location\.hash|Authorization|consumeTokenLink|prompt\(/);
  const credentialReferences = source.split('\n').filter(line => line.includes('eleagent-token'));
  assert.equal(credentialReferences.length, 1);
  assert.match(credentialReferences[0], /localStorage\.removeItem\('eleagent-token'\)/);
  assert.match(source, /CAMERA_KEY = 'eleagent-camera'/);
  for (const id of ['preview', 'status', 'shutter', 'flip', 'observation', 'observation-age', 'observation-text']) {
    assert.ok(html.includes(`id="${id}"`), id);
  }
});

test('legacy browser credential is removed once without reading/writing it; camera preference survives', () => {
  const h = harness({ status: 204 });
  assert.equal(h.storage.has('eleagent-token'), false);
  assert.equal(h.storage.get('eleagent-camera'), 'front');
  assert.deepEqual(h.storageCalls.filter(([, key]) => key === 'eleagent-token'), [['removeItem', 'eleagent-token']]);
});

test('unavailable legacy storage does not prevent session UI initialization', () => {
  const h = harness({ status: 204 }, { storageUnavailable: true });
  assert.equal(h.elements.get('shutter').disabled, true);
  assert.equal(h.storageCalls.filter(([op]) => op === 'removeItem').length, 1);
});

for (const response of [{ status: 401, ok: false }, { status: 403, ok: false }, { status: 0, ok: false, type: 'opaqueredirect' }, { status: 302, ok: false }]) {
  for (const endpoint of ['upload', 'pollObservation']) {
    test(`${endpoint}: expired session (${response.status}) retains queue, waits for save, blocks automatic resume and redirects once`, async () => {
      const h = harness(response);
      h.state.activate(h.state.acquire('web-synthetic-back'));
      let saveDone;
      h.setLoop(new Promise(resolve => { saveDone = resolve; }));
      await h[endpoint]();
      assert.equal(h.state.phase, 'paused');
      assert.equal(h.blocked(), 'auth');
      assert.equal(h.removed(), 0);
      assert.deepEqual(h.redirects, []);
      const options = h.calls[0][1];
      assert.equal(options.credentials, 'same-origin');
      assert.equal(options.redirect, 'manual');
      assert.equal(options.headers?.Authorization, undefined);
      if (endpoint === 'upload') assert.ok(options.body instanceof FormData);
      h.signIn();
      await h.pollObservation();
      assert.equal(h.calls.length, 1);
      assert.equal(h.elements.get('shutter').disabled, true);
      let warned = false;
      h.events.get('beforeunload')({ preventDefault() { warned = true; } });
      assert.equal(warned, true, 'manual navigation still warns while final clip is saving');
      saveDone();
      await new Promise(resolve => setImmediate(resolve));
      assert.deepEqual(h.redirects, ['/auth/sign-in?return_to=/']);
      h.events.get('beforeunload')({ preventDefault() { assert.fail('durable sign-in navigation must not prompt'); } });
      assert.equal(h.removed(), 0);
    });
  }
}

test('observation session expiry during async queue initialization cannot start the camera afterward', async () => {
  const h = harness({ status: 401, ok: false });
  let loaded;
  h.setQueue({ stats: () => new Promise(resolve => { loaded = resolve; }) });
  const starting = h.start();
  await h.pollObservation();
  assert.equal(h.blocked(), 'auth');
  loaded({ count: 0, bytes: 0 });
  await starting;
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.state.phase, 'idle');
  assert.deepEqual(h.redirects, ['/auth/sign-in?return_to=/']);
});

test('cookie-session upload deletes a clip only after valid archive confirmation', async () => {
  const h = harness({ status: 200, ok: true, json: async () => ({ archived: true, capture_id: 'web-synthetic-back', clip_seq: 7, media_id: 'media-confirmed' }) });
  h.state.activate(h.state.acquire('web-synthetic-back'));
  h.state.pause('user_pause');
  await h.upload();
  assert.equal(h.removed(), 1);
  assert.deepEqual(h.redirects, []);
  assert.equal(h.state.pauseReason, 'user_pause');
});

test('invalid archive receipt retains local clip', async () => {
  const h = harness({ status: 200, ok: true, json: async () => ({ archived: true, capture_id: 'wrong', clip_seq: 7, media_id: 'media-confirmed' }) });
  await h.upload();
  assert.equal(h.removed(), 0);
});

test('latest observation UI preserves text-safe rendering, ETag/304, 204 clearing and polling while paused', async () => {
  const observation = { text: '<img onerror=alert(1)> Latest scene', captured_to: new Date().toISOString() };
  const h = harness([
    { status: 200, json: async () => observation, headers: { get: key => key === 'ETag' ? '"obs-1"' : null } },
    { status: 304 }, { status: 204 },
  ]);
  h.state.activate(h.state.acquire('web-synthetic-back'));
  h.state.pause('user_pause');
  await h.pollObservation();
  assert.equal(h.observation(), observation);
  assert.equal(h.elements.get('observation').hidden, false);
  assert.equal(h.elements.get('observation-text').textContent, observation.text);
  assert.match(h.elements.get('observation-age').textContent, /ago$/);
  await h.pollObservation();
  assert.equal(h.calls[1][0], '/v1/observations/latest');
  assert.equal(h.calls[1][1].headers['If-None-Match'], '"obs-1"');
  assert.equal(h.observation(), observation);
  await h.pollObservation();
  assert.equal(h.observation(), null);
  assert.equal(h.elements.get('observation').hidden, true);
  assert.equal(h.state.pauseReason, 'user_pause');
  assert.equal(h.timers.size, 1);
});

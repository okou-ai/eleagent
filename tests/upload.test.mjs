import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import * as capture from '../public/capture/capture-state.js';

// Runs the real capture script against fake DOM, storage and network, then drives upload() directly.
const source = readFileSync(new URL('../public/capture/app.js', import.meta.url), 'utf8');
const json = (status, body) => ({ ok: status >= 200 && status < 300, status, type: 'basic', json: async () => body });

function harness(network) {
  const element = () => ({ textContent: '', dataset: {}, classList: { toggle() {} }, setAttribute() {}, addEventListener() {} });
  const elements = new Map();
  const queued = [{ meta: { capture_id: 'web-synthetic-back', clip_seq: 7 }, blob: new Blob(['video'], { type: 'video/mp4;codecs=avc1' }) }];
  const calls = [], redirects = [], timers = [];
  const context = {
    ...capture, Blob, AbortController, Promise, JSON, performance,
    document: { getElementById: id => elements.get(id) ?? elements.set(id, element()).get(id), addEventListener() {}, hidden: false },
    window: { addEventListener() {}, location: { assign: url => redirects.push(url) } },
    navigator: { onLine: true },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    setTimeout: (fn, ms) => timers.push(ms), clearTimeout() {}, setInterval() {}, clearInterval() {},
    fetch: async (url, init = {}) => {
      calls.push({ url, method: init.method, body: typeof init.body === 'string' ? JSON.parse(init.body) : init.body, headers: init.headers });
      return network(url, init);
    },
  };
  vm.runInNewContext(source.replace(/^import [\s\S]*?;\n/gm, '').replace(/\nvoid initialize\(\);\s*$/, '') + `
    globalThis.api = { upload, okouStatus, openOkou, blocked: () => blocked, setQueue(value) { queue = value; ready = true; } };
  `, context);
  context.api.setQueue({
    first: async () => queued[0], remove: async item => queued.splice(queued.indexOf(item), 1),
    stats: async () => ({ count: queued.length, bytes: 5 }),
  });
  return { api: context.api, calls, redirects, timers, queued, elements };
}

const plan = { pathname: 'captures/web-synthetic-back/0000007.mp4', upload_url: 'https://store.private.blob.vercel-storage.com/x?sig=1' };
const receipt = { archived: true, capture_id: 'web-synthetic-back', clip_seq: 7, media_id: 'media_1' };

test('a clip is signed, stored straight in Blob, recorded, and only then dropped from the local queue', async () => {
  const h = harness(url => url === '/api/clips/prepare' ? json(200, plan) : url === plan.upload_url ? json(200, {}) : json(200, { receipt }));
  await h.api.upload();
  assert.deepEqual(h.calls.map(c => `${c.method} ${c.url}`), ['POST /api/clips/prepare', `PUT ${plan.upload_url}`, 'POST /api/clips/commit']);
  assert.deepEqual(h.calls[0].body, { meta: { capture_id: 'web-synthetic-back', clip_seq: 7 }, content_type: 'video/mp4', size: 5 });
  // The PUT carries the bare type the upload URL was signed for, not the recorder's codec string.
  assert.equal(h.calls[1].headers['Content-Type'], 'video/mp4');
  assert.deepEqual(h.calls[2].body, { meta: { capture_id: 'web-synthetic-back', clip_seq: 7 }, pathname: plan.pathname });
  assert.equal(h.queued.length, 0);
});

test('a clip the server already has is dropped without uploading it again', async () => {
  const h = harness(() => json(200, { receipt }));
  await h.api.upload();
  assert.equal(h.calls.length, 1);
  assert.equal(h.queued.length, 0);
});

test('an expired session stops uploads and sends the owner to sign in, keeping the clip', async () => {
  const h = harness(() => json(401, { error: { code: 'sign_in_required' } }));
  await h.api.upload();
  assert.equal(h.api.blocked(), 'auth');
  assert.equal(h.queued.length, 1);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(h.redirects, ['/login?return_to=/']);
});

test('a refused clip blocks uploads; a failed store or a wrong receipt keeps the clip for a retry', async () => {
  const refused = harness(() => json(422, { error: { code: 'invalid_clip' } }));
  await refused.api.upload();
  assert.equal(refused.api.blocked(), 'clip');
  assert.equal(refused.queued.length, 1);

  const storeDown = harness(url => url === '/api/clips/prepare' ? json(200, plan) : json(503, {}));
  await storeDown.api.upload();
  assert.equal(storeDown.api.blocked(), null);
  assert.equal(storeDown.queued.length, 1);
  assert.ok(storeDown.timers.includes(5000), 'a retry is scheduled in 5 s');

  const wrong = harness(() => json(200, { receipt: { ...receipt, clip_seq: 8 } }));
  await wrong.api.upload();
  assert.equal(wrong.queued.length, 1);
});

test('the Okou mark is grey until Okou is connected; grey connects, colour opens the account page', async () => {
  for (const [connected, target] of [[false, '/api/okou/connect?return_to=/'], [true, '/account']]) {
    const h = harness(() => json(200, { connected }));
    await h.api.okouStatus();
    assert.equal(h.elements.get('okou').dataset.connected, String(connected));
    h.api.openOkou();
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(h.redirects, [target]);
  }
  const offline = harness(() => { throw new Error('offline'); });
  await offline.api.okouStatus();
  assert.equal(offline.elements.get('okou').dataset.connected, undefined, 'keeps its state when the status cannot be read');
});

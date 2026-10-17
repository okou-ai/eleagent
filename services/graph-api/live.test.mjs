import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { mkdtemp, mkdir, rm, writeFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApiServer } from './server.mjs';
import { createLiveHandler } from './live.mjs';

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'eleagent-live-'));
  const root = join(dir, 'live');
  await mkdir(join(root, 'assets/models'), { recursive: true });
  await writeFile(join(root, 'index.html'), '<!doctype html><title>Eleagent Live</title>');
  await writeFile(join(root, 'live.js'), 'export {};');
  await writeFile(join(root, 'assets/models/yunet.onnx'), Buffer.from([1, 2, 3]));
  await writeFile(join(dir, 'secret.txt'), 'outside');
  await symlink(join(dir, 'secret.txt'), join(root, 'escape.txt'));
  const face = Array.from({ length: 128 }, (_, i) => i / 128), voice = Array.from({ length: 192 }, () => 0.1);
  const records = [
    { id: 'person:owner', name: 'Owner', face, voice },
    { id: 'person:partial', name: null, face: [1, 2, 3], voice: null },
  ].map(row => ({ get: key => row[key] }));
  const store = { read: async callback => callback({ run: async () => ({ records }) }) };
  const listener = http.createServer(); listener.listen(0, '127.0.0.1'); await once(listener, 'listening');
  const origin = `http://127.0.0.1:${listener.address().port}`;
  const authService = { getOwnerSession: async headers => headers.get('cookie') === 'session=owner' ? { user: { id: 'owner' } } : null };
  const api = createApiServer({ store, cursorKey: 'k'.repeat(64), authService, authPublicUrl: origin,
    live: createLiveHandler({ store, rootDir: root }) });
  listener.on('request', api.listeners('request')[0]);
  t.after(async () => { await new Promise(r => listener.close(r)); await rm(dir, { recursive: true, force: true }); });
  const get = (path, owner = true) => fetch(origin + path, { redirect: 'manual', headers: owner ? { cookie: 'session=owner' } : {} });
  return { get };
}

test('live page and feature pack require the owner session', async t => {
  const f = await fixture(t);
  const page = await f.get('/live', false);
  assert.equal(page.status, 302);
  assert.equal(page.headers.get('location'), '/auth/sign-in?return_to=%2Flive');
  assert.equal((await f.get('/v1/live/context', false)).status, 401);
  assert.equal((await f.get('/live/assets/models/yunet.onnx', false)).status, 401);
});

test('live responses are cross-origin isolated and allow WASM', async t => {
  const f = await fixture(t);
  for (const path of ['/live', '/live?wasm', '/live/live.js', '/live/assets/models/yunet.onnx', '/v1/live/context']) {
    const response = await f.get(path);
    assert.equal(response.status, 200, path);
    assert.equal(response.headers.get('cross-origin-opener-policy'), 'same-origin');
    assert.equal(response.headers.get('cross-origin-embedder-policy'), 'require-corp');
    assert.match(response.headers.get('content-security-policy'), /'wasm-unsafe-eval'/);
  }
  assert.equal((await f.get('/live/assets/models/yunet.onnx')).headers.get('content-type'), 'application/octet-stream');
  assert.equal((await f.get('/live/live.js')).headers.get('content-type'), 'text/javascript');
});

test('static paths cannot leave the live root', async t => {
  const f = await fixture(t);
  for (const path of ['/live/escape.txt', '/live/../secret.txt', '/live/%2e%2e/secret.txt', '/live/.hidden', '/live/assets/missing.onnx', '/live/live.js?x=1']) {
    const response = await f.get(path);
    assert.notEqual(response.status, 200, path);
    assert.notEqual(await response.text(), 'outside', path);
  }
});

test('feature pack carries names and well-formed vectors only', async t => {
  const f = await fixture(t);
  const body = await (await f.get('/v1/live/context')).json();
  assert.deepEqual(body.thresholds.face, { threshold: 0.55, margin: 0.08 });
  assert.equal(body.people.length, 2);
  assert.equal(body.people[0].face[0].length, 128);
  assert.equal(body.people[0].voice[0].length, 192);
  assert.deepEqual(body.people[1].face, []);
  assert.deepEqual(body.people[1].voice, []);
});

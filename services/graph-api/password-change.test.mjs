import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { runInNewContext } from 'node:vm';
import { createAuthService } from './auth.mjs';
import { createApiServer } from './server.mjs';
import { authPage, AUTH_JS } from './auth-pages.mjs';

// Never use production configuration, accounts, database paths or credentials.
test('official password change preserves current owner capture access and revokes other browsers', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'password-change-'));
  const canonical = 'http://127.0.0.1:49871';
  let service, server;
  t.after(async () => {
    if (server) await new Promise(resolve => server.close(resolve));
    if (service) await service.close();
    await rm(dir, { recursive: true, force: true });
  });
  service = await createAuthService({ publicUrl: canonical, databasePath: join(dir, 'auth.sqlite'), secret: randomBytes(48).toString('hex') });
  const email = 'temporary-owner@example.test';
  const initialPassword = randomBytes(24).toString('base64url');
  const newPassword = randomBytes(24).toString('base64url');
  await service.setupOwner({ email, password: initialPassword });
  server = createApiServer({ store: {}, cursorKey: randomBytes(32).toString('hex'), authService: service, authPublicUrl: canonical,
    capture: { proxy(req, res) { req.resume(); res.writeHead(200); res.end('temporary capture authorized'); } } });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const origin = `http://127.0.0.1:${server.address().port}`;
  let browserNumber = 0;
  const browserIps = new WeakMap();
  const browser = () => { const jar = new Map(); browserIps.set(jar, `192.0.2.${++browserNumber}`); return jar; };
  const cookie = jar => [...jar].map(([key, value]) => `${key}=${value}`).join('; ');
  async function request(jar, path, body, source = canonical) {
    const response = await fetch(origin + path, { redirect: 'manual', method: body === undefined ? 'GET' : 'POST',
      headers: { Cookie: cookie(jar), 'X-Forwarded-For': browserIps.get(jar), ...(body === undefined ? {} : { Origin: source, 'Content-Type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body) });
    for (const value of response.headers.getSetCookie()) {
      const pair = value.split(';')[0]; const at = pair.indexOf('=');
      jar.set(pair.slice(0, at), pair.slice(at + 1));
    }
    return response;
  }
  const login = (jar, password) => request(jar, '/api/auth/sign-in/email', { email, password });
  const current = browser(), other = browser();
  assert.equal((await login(current, initialPassword)).status, 200);
  assert.equal((await login(other, initialPassword)).status, 200);
  assert.notEqual(cookie(current), cookie(other), 'independent browser sessions');
  for (const jar of [current, other]) assert.equal((await request(jar, '/')).status, 200);
  const change = { currentPassword: initialPassword, newPassword, revokeOtherSessions: true };
  const wrong = await request(current, '/api/auth/change-password', { ...change, currentPassword: randomBytes(24).toString('hex') });
  assert.ok([400, 401].includes(wrong.status), 'wrong current password rejected');
  // Exercise Better Auth itself, not only the HTTP adapter Origin guard.
  const badOrigin = await service.handler(new Request(canonical + '/api/auth/change-password', {
    method: 'POST', headers: { Cookie: cookie(current), Origin: 'https://attacker.invalid', 'Content-Type': 'application/json' }, body: JSON.stringify(change),
  }));
  assert.equal(badOrigin.status, 403);
  assert.equal((await request(current, '/api/auth/change-password', change, 'https://attacker.invalid')).status, 403);
  for (const jar of [current, other]) assert.equal((await request(jar, '/')).status, 200, 'rejections do not revoke sessions');
  const changed = await request(current, '/api/auth/change-password', change);
  assert.equal(changed.status, 200);
  assert.equal((await request(current, '/')).status, 200, 'updated current cookie still authorizes capture');
  const currentSession = await request(current, '/api/auth/get-session');
  assert.equal((await currentSession.json()).user.email, email);
  assert.equal((await request(other, '/')).status, 302, 'other existing browser loses capture access');
  assert.equal(await (await request(other, '/api/auth/get-session')).json(), null);
  assert.equal((await login(browser(), initialPassword)).status, 401, 'old password no longer works');
  const fresh = browser();
  assert.equal((await login(fresh, newPassword)).status, 200);
  assert.equal((await request(fresh, '/')).status, 200);
});

test('account HTML exposes accessible password controls and script compiles', () => {
  const html = authPage('account');
  assert.match(html, /<form id="change-password" aria-describedby="password-help">/);
  for (const name of ['currentPassword', 'newPassword', 'confirmNewPassword']) {
    assert.match(html, new RegExp(`<label>[^<]+<input name="${name}" type="password"[^>]+required>`));
  }
  assert.match(html, /name="currentPassword"[^>]+autocomplete="current-password"/);
  for (const name of ['newPassword', 'confirmNewPassword']) {
    assert.match(html, new RegExp(`name="${name}"[^>]+autocomplete="new-password"[^>]+minlength="12" maxlength="128"`));
  }
  assert.match(html, /role="status" id="status" aria-live="polite"/);
  new Function(AUTH_JS);
  assert.doesNotMatch(AUTH_JS, /console\.|localStorage|sessionStorage/);
});

test('account script validates bounds and confirmation, posts official payload, clears only on success', async () => {
  const status = { textContent: '' }, button = { disabled: false };
  let listener, resetCount = 0, fail = false;
  const values = { currentPassword: 'temporary-current', newPassword: '', confirmNewPassword: '' };
  const calls = [];
  const form = { addEventListener(type, fn) { assert.equal(type, 'submit'); listener = fn; }, querySelector() { return button; },
    reset() { resetCount++; for (const key of Object.keys(values)) values[key] = ''; } };
  const elements = { '#status': status, '#change-password': form, '#sign-out': { addEventListener() {} }, '#identity': {}, '#grants': {} };
  runInNewContext(AUTH_JS, {
    document: { body: { dataset: { page: 'account' } }, querySelector: selector => elements[selector] },
    FormData: class { get(key) { return values[key]; } },
    location: { origin: 'https://local.example', assign() { throw new Error('Unexpected navigation'); } }, URL, URLSearchParams,
    fetch: async (path, options) => {
      if (path === '/api/auth/get-session') return { json: async () => ({ user: { email: 'temporary@example.test' } }) };
      if (path === '/auth/grants') return { ok: true, json: async () => [] };
      calls.push({ path, options });
      assert.equal(button.disabled, true);
      return { ok: !fail, json: async () => ({}) };
    },
    console: { log() { throw new Error('Must never log'); }, error() { throw new Error('Must never log'); } },
  });
  await new Promise(resolve => setImmediate(resolve));
  const submit = () => listener({ preventDefault() {} });
  for (const length of [0, 11, 129]) {
    values.newPassword = values.confirmNewPassword = 'x'.repeat(length);
    await submit(); assert.equal(calls.length, 0); assert.match(status.textContent, /12 and 128/);
  }
  values.newPassword = 'x'.repeat(12); values.confirmNewPassword = 'y'.repeat(12);
  await submit(); assert.equal(calls.length, 0); assert.match(status.textContent, /do not match/);
  values.currentPassword = ''; values.confirmNewPassword = values.newPassword;
  await submit(); assert.equal(calls.length, 0); assert.match(status.textContent, /current password/);
  values.currentPassword = 'temporary-current';
  fail = true; await submit();
  assert.equal(resetCount, 0); assert.equal(button.disabled, false); assert.match(status.textContent, /Unable to change/);
  assert.ok(values.currentPassword, 'failure preserves fields for correction');
  fail = false;
  for (const length of [12, 128]) {
    values.currentPassword = 'temporary-current'; values.newPassword = values.confirmNewPassword = 'x'.repeat(length);
    await submit();
    const { path, options } = calls.at(-1);
    assert.equal(path, '/api/auth/change-password'); assert.equal(options.method, 'POST');
    assert.equal(options.credentials, 'same-origin');
    assert.equal(options.headers['Content-Type'], 'application/json');
    const body = JSON.parse(options.body);
    assert.deepEqual(Object.keys(body).sort(), ['currentPassword', 'newPassword', 'revokeOtherSessions']);
    assert.equal(body.revokeOtherSessions, true); assert.equal(body.newPassword.length, length);
    assert.ok(Object.values(values).every(value => value === ''));
    assert.equal(button.disabled, false); assert.match(status.textContent, /Password changed successfully/);
  }
  assert.equal(resetCount, 2);
});

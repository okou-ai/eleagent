import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, rm, stat, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { SignJWT } from 'jose';
import { fetchClientMetadataResource } from '@better-auth/cimd/node';
import { createAuthService } from './auth.mjs';

const SECRET = 'test-only-secret-with-more-than-thirty-two-characters';
const BOOTSTRAP = 'test-only-existing-graph-api-token';
const EMAIL = 'owner@example.com';
const PASSWORD = 'test-only-strong-owner-password';

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'graph-auth-'));
  const databasePath = join(dir, 'auth.sqlite');
  let service;
  const server = createServer(async (req, res) => {
    try {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const request = new Request(`${origin}${req.url}`, {
        method: req.method, headers: req.headers,
        ...(!['GET', 'HEAD'].includes(req.method) ? { body: Buffer.concat(chunks) } : {}),
      });
      const response = await service.handler(request);
      const responseHeaders = Object.fromEntries([...response.headers].filter(([key]) => key !== 'set-cookie'));
      const cookies = response.headers.getSetCookie();
      if (cookies.length) responseHeaders['set-cookie'] = cookies;
      res.writeHead(response.status, responseHeaders);
      res.end(Buffer.from(await response.arrayBuffer()));
    } catch (error) { res.statusCode = 500; res.end(error.message); }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const origin = `http://127.0.0.1:${server.address().port}`;
  const config = { publicUrl: origin, databasePath, secret: SECRET, bootstrapToken: BOOTSTRAP, ownerEmail: EMAIL };
  service = await createAuthService(config);
  t.after(async () => { await service.close(); await new Promise(resolve => server.close(resolve)); await rm(dir, { recursive: true, force: true }); });
  const cookies = new Map();
  async function request(path, { method = 'GET', body, cookie = true, form = false, headers = {} } = {}) {
    const response = await fetch(path.startsWith('http') ? path : `${origin}${path}`, {
      method, redirect: 'manual', headers: {
        ...(cookie && cookies.size ? { cookie: [...cookies].map(([key, value]) => `${key}=${value}`).join('; ') } : {}),
        ...(body !== undefined ? { 'content-type': form ? 'application/x-www-form-urlencoded' : 'application/json', origin } : {}), ...headers,
      }, body: body === undefined ? undefined : form ? new URLSearchParams(body) : JSON.stringify(body),
    });
    if (cookie) for (const value of response.headers.getSetCookie()) {
      const pair = value.split(';')[0];
      const at = pair.indexOf('=');
      cookies.set(pair.slice(0, at), pair.slice(at + 1));
    }
    return response;
  }
  const cookieHeaders = () => ({ cookie: [...cookies].map(([key, value]) => `${key}=${value}`).join('; ') });
  async function owner() { return service.setupOwner({ email: EMAIL, password: PASSWORD, bootstrapToken: BOOTSTRAP }); }
  async function login(oauth_query) {
    const response = await request('/api/auth/sign-in/email', { method: 'POST', body: { email: EMAIL, password: PASSWORD, ...(oauth_query ? { oauth_query } : {}) } });
    assert.equal(response.status, 200, await response.clone().text());
    return response.json();
  }
  async function register(overrides = {}) {
    const response = await request('/api/auth/oauth2/register', { method: 'POST', cookie: false, body: {
      client_name: 'Graph test client', redirect_uris: ['http://127.0.0.1:9812/callback'],
      token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'], scope: 'graph:read media:read offline_access', ...overrides,
    } });
    assert.equal(response.status, 201, await response.clone().text());
    return response.json();
  }
  function authorization(client, scopes = 'graph:read media:read offline_access', overrides = {}) {
    const verifier = randomBytes(48).toString('base64url');
    const query = new URLSearchParams({ client_id: client.client_id, redirect_uri: client.redirect_uris[0],
      response_type: 'code', scope: scopes, resource: `${origin}/mcp`, state: 'csrf-state',
      code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256', ...overrides });
    return { verifier, url: `/api/auth/oauth2/authorize?${query}` };
  }
  async function authorize(client, scopes, { loggedIn = true, accept = true, prompt } = {}) {
    const flow = authorization(client, scopes, prompt ? { prompt } : {});
    const response = await request(flow.url, { headers: { accept: 'text/html' } });
    assert.ok([200, 302].includes(response.status), await response.clone().text());
    let location = new URL(response.status === 302 ? response.headers.get('location') : (await response.json()).url, origin);
    if (!loggedIn) {
      assert.equal(location.pathname, '/auth/sign-in');
      const signedQuery = location.search.slice(1);
      const loginResult = await login(signedQuery);
      assert.ok(loginResult.url, 'sign-in must return continuation URL');
      location = new URL(loginResult.url, origin);
    }
    if (location.pathname === '/auth/consent') {
      const details = await service.consentDetails(new Request(location, { headers: cookieHeaders() }));
      assert.ok(!(details instanceof Response), details instanceof Response ? await details.text() : '');
      assert.equal(details.clientId, client.client_id);
      assert.equal(details.clientName, client.client_name);
      const consent = await request('/api/auth/oauth2/consent', { method: 'POST', body: { accept, oauth_query: location.search.slice(1) } });
      assert.equal(consent.status, 200, await consent.clone().text());
      const result = await consent.json();
      location = new URL(result.url || result.redirect_uri, origin);
    }
    if (!accept) return { ...flow, location };
    assert.equal(location.searchParams.get('state'), 'csrf-state');
    assert.equal(location.searchParams.get('iss'), `${origin}/api/auth`);
    const code = location.searchParams.get('code');
    assert.ok(code, `missing authorization code at ${location.pathname}`);
    return { ...flow, code, location };
  }
  async function exchange(client, flow, overrides = {}) {
    return request('/api/auth/oauth2/token', { method: 'POST', cookie: false, form: true, body: {
      grant_type: 'authorization_code', code: flow.code, client_id: client.client_id,
      redirect_uri: client.redirect_uris[0], code_verifier: flow.verifier, resource: `${origin}/mcp`, ...overrides,
    } });
  }
  const tokenRequest = token => new Request(`${origin}/mcp`, { method: 'POST', headers: { authorization: `Bearer ${token}` } });
  return { get service() { return service; }, origin, databasePath, config, request, owner, login, register, authorization, authorize, exchange, tokenRequest, cookieHeaders,
    async restart() { await service.close(); service = await createAuthService(config); },
  };
}

test('official metadata, closed signup, canonical origin, private persistent WAL database and first-owner latch', async t => {
  const f = await fixture(t);
  const metadata = await (await f.request('/.well-known/oauth-authorization-server/api/auth')).json();
  assert.equal(metadata.issuer, `${f.origin}/api/auth`);
  assert.equal(metadata.client_id_metadata_document_supported, true);
  assert.deepEqual(metadata.code_challenge_methods_supported, ['S256']);
  assert.deepEqual(metadata.grant_types_supported, ['authorization_code', 'refresh_token']);
  const resource = await (await f.request('/.well-known/oauth-protected-resource/mcp')).json();
  assert.equal(resource.resource, `${f.origin}/mcp`);
  assert.deepEqual(resource.scopes_supported, ['graph:read', 'media:read']);
  const signup = await f.request('/api/auth/sign-up/email', { method: 'POST', body: { name: 'attacker', email: 'attacker@example.com', password: PASSWORD } });
  assert.ok(signup.status >= 400);
  await assert.rejects(f.service.setupOwner({ email: EMAIL, password: PASSWORD, bootstrapToken: 'wrong' }), error => error.status === 403);
  const attempts = await Promise.allSettled([f.owner(), f.owner()]);
  assert.equal(attempts.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(f.service.getSetupStatus().configured, true);
  await assert.rejects(f.owner(), error => error.status === 409);
  await f.login();
  assert.equal((await stat(f.databasePath)).mode & 0o777, 0o600);
  const db = new DatabaseSync(f.databasePath);
  assert.equal(db.prepare('PRAGMA journal_mode').get().journal_mode, 'wal');
  const password = db.prepare('SELECT password FROM account').get().password;
  assert.notEqual(password, PASSWORD);
  db.close();
  assert.ok(!(await readFile(f.databasePath)).includes(Buffer.from(PASSWORD)));
  await f.restart();
  await f.login();
  await assert.rejects(f.owner(), error => error.status === 409);
  assert.equal((await f.service.handler(new Request('https://untrusted.example/api/auth/get-session'))).status, 400);
  for (const publicUrl of ['http://example.com', 'https://good.example/path', 'https://user:pass@good.example', 'https://good.example?query=1']) {
    await assert.rejects(createAuthService({ ...f.config, publicUrl }));
  }
});

test('HTTP login → signed consent → PKCE code → opaque resource token → refresh rotation → revocation', async t => {
  const f = await fixture(t);
  await f.owner();
  const client = await f.register();
  const flow = await f.authorize(client, undefined, { loggedIn: false });
  const response = await f.exchange(client, flow);
  assert.equal(response.status, 200, await response.clone().text());
  const tokens = await response.json();
  assert.ok(tokens.access_token && tokens.refresh_token);
  assert.ok(!tokens.access_token.includes('.'), 'provider must issue revocable opaque access tokens');
  const principal = await f.service.verify(f.tokenRequest(tokens.access_token), { scopes: ['graph:read', 'media:read'] });
  assert.ok(!(principal instanceof Response), principal instanceof Response ? await principal.text() : '');
  assert.equal(principal.claims.iss, `${f.origin}/api/auth`);
  assert.ok([principal.claims.aud].flat().includes(`${f.origin}/mcp`));
  assert.equal(principal.clientId, client.client_id);
  const db = new DatabaseSync(f.databasePath);
  assert.notEqual(db.prepare('SELECT token FROM oauthAccessToken').get().token, tokens.access_token);
  assert.notEqual(db.prepare('SELECT token FROM oauthRefreshToken').get().token, tokens.refresh_token);
  db.close();
  await f.restart();
  assert.equal((await f.service.verify(f.tokenRequest(tokens.access_token), { scopes: ['graph:read'] })).clientId, client.client_id);
  assert.deepEqual((await f.service.listGrants(f.cookieHeaders())).map(grant => grant.clientId), [client.client_id]);
  const refreshed = await f.request('/api/auth/oauth2/token', { method: 'POST', cookie: false, form: true, body: {
    grant_type: 'refresh_token', refresh_token: tokens.refresh_token, client_id: client.client_id, resource: `${f.origin}/mcp`,
  } });
  assert.equal(refreshed.status, 200, await refreshed.clone().text());
  const next = await refreshed.json();
  assert.ok(next.refresh_token && next.refresh_token !== tokens.refresh_token);
  const revoke = await f.request('/api/auth/oauth2/revoke', { method: 'POST', cookie: false, form: true, body: {
    token: next.access_token, token_type_hint: 'access_token', client_id: client.client_id,
  } });
  assert.equal(revoke.status, 200, await revoke.clone().text());
  assert.equal((await f.service.verify(f.tokenRequest(next.access_token), { scopes: [] })).status, 401);
  const revokedRefresh = await f.request('/api/auth/oauth2/revoke', { method: 'POST', cookie: false, form: true, body: {
    token: next.refresh_token, token_type_hint: 'refresh_token', client_id: client.client_id,
  } });
  assert.equal(revokedRefresh.status, 200, await revokedRefresh.clone().text());
  const refreshAgain = await f.request('/api/auth/oauth2/token', { method: 'POST', cookie: false, form: true, body: {
    grant_type: 'refresh_token', refresh_token: next.refresh_token, client_id: client.client_id, resource: `${f.origin}/mcp`,
  } });
  assert.equal(refreshAgain.status, 400);
});

test('scope enforcement, signed-consent forgery, unknown tokens, wrong issuer/audience and expired tokens fail closed', async t => {
  const f = await fixture(t);
  await f.owner(); await f.login();
  const client = await f.register();
  const flow = await f.authorize(client, 'graph:read');
  const response = await f.exchange(client, flow);
  assert.equal(response.status, 200, await response.clone().text());
  const token = (await response.json()).access_token;
  const allowed = await f.service.verify(f.tokenRequest(token), { scopes: ['graph:read'] });
  assert.equal(allowed.clientId, client.client_id);
  const forbidden = await f.service.verify(f.tokenRequest(token), { scopes: ['media:read'] });
  assert.equal(forbidden.status, 403);
  assert.match(forbidden.headers.get('www-authenticate'), /insufficient_scope/);
  assert.match(forbidden.headers.get('www-authenticate'), /media:read/);
  const noToken = await f.service.verify(new Request(`${f.origin}/mcp`), { scopes: [] });
  assert.equal(noToken.status, 401);
  assert.match(noToken.headers.get('www-authenticate'), /oauth-protected-resource\/mcp/);
  assert.equal((await f.service.verify(f.tokenRequest(BOOTSTRAP))).status, 401);
  assert.equal((await f.service.verify(f.tokenRequest('unknown'))).status, 401);
  const forged = await new SignJWT({ sub: allowed.userId, scope: 'graph:read media:read' }).setProtectedHeader({ alg: 'HS256' })
    .setIssuer('https://attacker.example/api/auth').setAudience(`${f.origin}/mcp`).setExpirationTime('1h').sign(new TextEncoder().encode(SECRET));
  assert.equal((await f.service.verify(f.tokenRequest(forged), { scopes: [] })).status, 401);
  const forgedConsent = await f.service.consentDetails(new Request(`${f.origin}/auth/consent?client_id=${client.client_id}&scope=graph:read`, { headers: f.cookieHeaders() }));
  assert.equal(forgedConsent.status, 400);
  // In opaque mode issuer/aud are authoritative server-side introspection claims.
  // Changing the canonical issuer invalidates the resource binding, with no Host inference.
  const other = await createAuthService({ ...f.config, publicUrl: 'https://other.example' });
  try { assert.equal((await other.verify(new Request('https://other.example/mcp', { headers: { authorization: `Bearer ${token}` } }))).status, 401); }
  finally { await other.close(); }
  const db = new DatabaseSync(f.databasePath);
  db.prepare('UPDATE oauthAccessToken SET resources=?').run(JSON.stringify(['https://wrong.example/mcp']));
  assert.equal((await f.service.verify(f.tokenRequest(token))).status, 401);
  db.prepare('UPDATE oauthAccessToken SET resources=?, expiresAt=?').run(JSON.stringify([`${f.origin}/mcp`]), 0);
  assert.equal((await f.service.verify(f.tokenRequest(token))).status, 401);
  db.close();
});

test('owner grant revocation removes consent and all access/refresh tokens; direct official delete-consent is hardened', async t => {
  const f = await fixture(t);
  await f.owner(); await f.login();
  const client = await f.register();
  const flow = await f.authorize(client);
  const response = await f.exchange(client, flow);
  assert.equal(response.status, 200, await response.clone().text());
  const tokens = await response.json();
  assert.equal((await f.service.listGrants({})).status, 401);
  assert.equal((await f.service.revokeGrant(client.client_id, {})).status, 401);
  assert.deepEqual(await f.service.revokeGrant(client.client_id, f.cookieHeaders()), { success: true });
  assert.equal((await f.service.verify(f.tokenRequest(tokens.access_token))).status, 401);
  const refresh = await f.request('/api/auth/oauth2/token', { method: 'POST', cookie: false, form: true, body: {
    grant_type: 'refresh_token', refresh_token: tokens.refresh_token, client_id: client.client_id, resource: `${f.origin}/mcp`,
  } });
  assert.equal(refresh.status, 400);
  assert.deepEqual(await f.service.listGrants(f.cookieHeaders()), []);
  const flow2 = await f.authorize(client);
  const response2 = await f.exchange(client, flow2);
  const tokens2 = await response2.json();
  const consents = await (await f.request('/api/auth/oauth2/get-consents')).json();
  const denied = await f.request('/api/auth/oauth2/delete-consent', { method: 'POST', body: { id: consents[0].id }, headers: { origin: 'https://attacker.example' } });
  assert.equal(denied.status, 403);
  assert.ok(!(await f.service.verify(f.tokenRequest(tokens2.access_token)) instanceof Response));
  const deleted = await f.request('/api/auth/oauth2/delete-consent', { method: 'POST', body: { id: consents[0].id } });
  assert.equal(deleted.status, 200, await deleted.clone().text());
  assert.equal((await f.service.verify(f.tokenRequest(tokens2.access_token))).status, 401);
});

test('refresh-token replay is rejected and revokes its token family', async t => {
  const f = await fixture(t);
  await f.owner(); await f.login();
  const client = await f.register();
  const flow = await f.authorize(client);
  const tokens = await (await f.exchange(client, flow)).json();
  const refresh = value => f.request('/api/auth/oauth2/token', { method: 'POST', cookie: false, form: true, body: {
    grant_type: 'refresh_token', refresh_token: value, client_id: client.client_id, resource: `${f.origin}/mcp`,
  } });
  const rotated = await refresh(tokens.refresh_token);
  assert.equal(rotated.status, 200, await rotated.clone().text());
  const next = await rotated.json();
  assert.notEqual(next.refresh_token, tokens.refresh_token);
  assert.equal((await refresh(tokens.refresh_token)).status, 400);
  assert.equal((await refresh(next.refresh_token)).status, 400);
  assert.equal((await f.service.verify(f.tokenRequest(next.access_token))).status, 401);
});

test('consent display requires signed unchanged query, owner session and existing enabled client', async t => {
  const f = await fixture(t);
  await f.owner(); await f.login();
  const client = await f.register();
  const flow = f.authorization(client, 'graph:read');
  const response = await f.request(flow.url);
  const location = new URL((await response.json()).url, f.origin);
  assert.equal(location.pathname, '/auth/consent');
  assert.equal((await f.service.consentDetails(new Request(location))).status, 401);
  const details = await f.service.consentDetails(new Request(location, { headers: f.cookieHeaders() }));
  assert.equal(details.clientId, client.client_id);
  const tampered = new URL(location);
  tampered.searchParams.set('scope', 'graph:read media:read');
  assert.equal((await f.service.consentDetails(new Request(tampered, { headers: f.cookieHeaders() }))).status, 400);
  const db = new DatabaseSync(f.databasePath);
  db.prepare('UPDATE oauthClient SET disabled=1 WHERE clientId=?').run(client.client_id);
  assert.equal((await f.service.consentDetails(new Request(location, { headers: f.cookieHeaders() }))).status, 400);
  db.prepare('DELETE FROM oauthClient WHERE clientId=?').run(client.client_id);
  assert.equal((await f.service.consentDetails(new Request(location, { headers: f.cookieHeaders() }))).status, 400);
  db.close();
});

test('secure official CIMD Node transport rejects private metadata and DCR cannot skip consent or disable PKCE', async t => {
  for (const url of ['http://127.0.0.1/client.json', 'https://127.0.0.1/client.json', 'https://169.254.169.254/client.json']) {
    await assert.rejects(fetchClientMetadataResource(url));
  }
  const f = await fixture(t);
  for (const extra of [{ skip_consent: true }, { require_pkce: false }, { scope: 'graph:write' }]) {
    const response = await f.request('/api/auth/oauth2/register', { method: 'POST', cookie: false, body: {
      client_name: 'Hostile registration', redirect_uris: ['http://127.0.0.1:9812/callback'], token_endpoint_auth_method: 'none', ...extra,
    } });
    if (extra.skip_consent || extra.scope) {
      assert.equal(response.status, 400, await response.clone().text());
    } else {
      // DCR strips management-only require_pkce and assigns server-owned scope capabilities.
      assert.equal(response.status, 201, await response.clone().text());
      const client = await response.json();
      assert.ok(!client.scope.includes('graph:write'));
      const flow = f.authorization(client, extra.scope || 'graph:read', { code_challenge: '', code_challenge_method: '' });
      const denied = await f.request(flow.url);
      assert.ok(denied.status >= 400 || new URL((await denied.json()).url, f.origin).searchParams.has('error'));
    }
  }
});

test('PKCE S256 is mandatory, bad verifier and cross-resource exchange denied, denied consent emits no code', async t => {
  const f = await fixture(t);
  await f.owner(); await f.login();
  const client = await f.register();
  const missing = f.authorization(client, 'graph:read', { code_challenge: '', code_challenge_method: '' });
  const missingResponse = await f.request(missing.url);
  assert.ok(missingResponse.status >= 400 || new URL((await missingResponse.json()).url, f.origin).searchParams.has('error'));
  const plain = f.authorization(client, 'graph:read', { code_challenge_method: 'plain' });
  const plainResponse = await f.request(plain.url, { headers: { accept: 'text/html' } });
  const plainLocation = plainResponse.status === 302 ? plainResponse.headers.get('location') : plainResponse.ok ? (await plainResponse.json()).url : '';
  assert.ok(plainResponse.status >= 400 || new URL(plainLocation, f.origin).searchParams.has('error'));
  const flow = await f.authorize(client, 'graph:read');
  const bad = await f.exchange(client, flow, { code_verifier: randomBytes(48).toString('base64url') });
  assert.equal(bad.status, 400);
  const otherFlow = await f.authorize(client, 'graph:read');
  assert.equal((await f.exchange(client, otherFlow, { resource: 'https://wrong.example/mcp' })).status, 400);
  const otherClient = await f.register({ client_name: 'Second test client' });
  const denied = await f.authorize(otherClient, 'graph:read', { accept: false });
  assert.equal(denied.location.searchParams.get('error'), 'access_denied');
  assert.equal(denied.location.searchParams.has('code'), false);
});

async function refreshToken(f, client, token) {
  return f.request('/api/auth/oauth2/token', { method: 'POST', cookie: false, form: true, body: {
    grant_type: 'refresh_token', refresh_token: token, client_id: client.client_id, resource: `${f.origin}/mcp`,
  } });
}

function pendingCodeCount(f, client) {
  const db = new DatabaseSync(f.databasePath);
  try {
    return db.prepare(`SELECT count(*) AS n FROM verification
      WHERE json_valid(value) AND json_extract(value, '$.type')='authorization_code'
      AND json_extract(value, '$.query.client_id')=?`).get(client.client_id).n;
  } finally { db.close(); }
}

for (const route of ['owner', 'official']) {
  test(`${route} revocation durably destroys outstanding code lineage, survives restart and permits ordinary reconnect`, async t => {
    const f = await fixture(t);
    await f.owner(); await f.login();
    const client = await f.register();
    const outstanding = await f.authorize(client);
    const existing = await (await f.exchange(client, await f.authorize(client))).json();
    const unrelatedClient = await f.register({ client_name: 'Unaffected client' });
    const unrelated = await f.authorize(unrelatedClient);
    assert.equal(pendingCodeCount(f, client), 1);
    if (route === 'owner') {
      assert.deepEqual(await f.service.revokeGrant(client.client_id, f.cookieHeaders()), { success: true });
    } else {
      const consents = await (await f.request('/api/auth/oauth2/get-consents')).json();
      const consent = consents.find(value => value.clientId === client.client_id);
      assert.equal((await f.request('/api/auth/oauth2/delete-consent', { method: 'POST', body: { id: consent.id } })).status, 200);
    }
    assert.equal(pendingCodeCount(f, client), 0, 'actual official verification code row must be deleted');
    await f.restart();
    assert.equal((await f.exchange(client, outstanding)).status, 400);
    assert.equal((await refreshToken(f, client, existing.refresh_token)).status, 400);
    assert.equal((await f.service.verify(f.tokenRequest(existing.access_token))).status, 401);
    const fresh = await f.authorize(client);
    assert.equal((await f.exchange(client, outstanding)).status, 400, 'reconsent must not revive pre-revoke code');
    assert.equal((await refreshToken(f, client, existing.refresh_token)).status, 400);
    assert.equal((await f.service.verify(f.tokenRequest(existing.access_token))).status, 401);
    const reconnected = await (await f.exchange(client, fresh)).json();
    assert.equal((await f.service.verify(f.tokenRequest(reconnected.access_token))).clientId, client.client_id);
    assert.equal((await refreshToken(f, client, reconnected.refresh_token)).status, 200);
    assert.equal((await f.exchange(unrelatedClient, unrelated)).status, 200, 'other client lineage is untouched');
  });
}

for (const route of ['update', 'approval']) {
  test(`${route} scope narrowing destroys old credentials even when scopes are subsequently restored`, async t => {
    const f = await fixture(t);
    await f.owner(); await f.login();
    const client = await f.register();
    const outstanding = await f.authorize(client);
    const tokens = await (await f.exchange(client, await f.authorize(client))).json();
    const oldNarrowTokens = await (await f.exchange(client, await f.authorize(client, 'graph:read'))).json();
    let narrowFlow;
    if (route === 'update') {
      const [consent] = await (await f.request('/api/auth/oauth2/get-consents')).json();
      assert.equal((await f.request('/api/auth/oauth2/update-consent', {
        method: 'POST', body: { id: consent.id, update: { scopes: ['graph:read'] } },
      })).status, 200);
    } else {
      narrowFlow = await f.authorize(client, 'graph:read', { prompt: 'consent' });
    }
    assert.equal((await f.service.verify(f.tokenRequest(tokens.access_token))).status, 401);
    assert.equal((await refreshToken(f, client, tokens.refresh_token)).status, 400);
    assert.equal((await f.service.verify(f.tokenRequest(oldNarrowTokens.access_token))).status, 401,
      'even old credentials whose scopes are still allowed must be invalidated');
    await f.restart();
    const restored = await f.authorize(client);
    assert.equal((await f.exchange(client, outstanding)).status, 400);
    assert.equal((await f.service.verify(f.tokenRequest(tokens.access_token))).status, 401);
    assert.equal((await refreshToken(f, client, tokens.refresh_token)).status, 400);
    assert.equal((await f.service.verify(f.tokenRequest(oldNarrowTokens.access_token))).status, 401);
    if (narrowFlow) assert.equal((await f.exchange(client, narrowFlow)).status, 200, 'new narrower consent code remains usable');
    assert.equal((await f.exchange(client, restored)).status, 200);
  });
}

// Pause only the return boundary of the REAL official handler: no tokens, DB
// records, PKCE verification or consent behavior are mocked. This deterministically
// overlaps requests while the provider has consumed/minted, or is deleting consent.
function pauseOfficialResponse(service, pathname) {
  const original = service.auth.handler;
  let enteredResolve, release;
  const entered = new Promise(resolve => { enteredResolve = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  service.auth.handler = async request => {
    const response = await original(request);
    if (new URL(request.url).pathname === pathname) {
      enteredResolve();
      await gate;
    }
    return response;
  };
  return { entered, release, restore() { service.auth.handler = original; } };
}

for (const order of ['exchange-first', 'revoke-first', 'refresh-first']) {
  test(`concurrent ${order} cannot leave credentials that survive revoke/reconsent`, { timeout: 15000 }, async t => {
    const f = await fixture(t);
    await f.owner(); await f.login();
    const client = await f.register();
    const flow = await f.authorize(client);
    const initial = order === 'refresh-first' ? await (await f.exchange(client, flow)).json() : null;
    const issue = () => initial ? refreshToken(f, client, initial.refresh_token) : f.exchange(client, flow);
    const pause = pauseOfficialResponse(f.service, order === 'revoke-first' ? '/api/auth/oauth2/delete-consent' : '/api/auth/oauth2/token');
    t.after(() => { pause.release(); pause.restore(); });
    let issuance, revocation;
    if (order === 'revoke-first') {
      revocation = f.service.revokeGrant(client.client_id, f.cookieHeaders());
      await pause.entered;
      issuance = issue();
    } else {
      issuance = issue();
      await pause.entered;
      revocation = f.service.revokeGrant(client.client_id, f.cookieHeaders());
    }
    pause.release();
    const [response, revoked] = await Promise.all([issuance, revocation]);
    pause.restore();
    assert.deepEqual(revoked, { success: true });
    assert.equal(pendingCodeCount(f, client), 0);
    assert.equal(response.status, order === 'revoke-first' ? 400 : 200);
    const issued = response.ok ? await response.json() : null;
    const fresh = await f.authorize(client);
    if (issued) {
      assert.equal((await f.service.verify(f.tokenRequest(issued.access_token))).status, 401);
      assert.equal((await refreshToken(f, client, issued.refresh_token)).status, 400);
    }
    assert.equal((await f.exchange(client, flow)).status, 400);
    assert.equal((await f.exchange(client, fresh)).status, 200);
  });
}

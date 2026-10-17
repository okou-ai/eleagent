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
import { ACCESS_TOKEN_LIFETIME_SECONDS, createAuthService } from './auth.mjs';
import { authPage, AUTH_JS } from './auth-pages.mjs';
import { createContext, runInContext } from 'node:vm';

const SECRET = 'test-only-secret-with-more-than-thirty-two-characters';
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
  const config = { publicUrl: origin, databasePath, secret: SECRET };
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
  async function owner() { return service.setupOwner({ email: EMAIL, password: PASSWORD }); }
  async function login(oauth_query) {
    const response = await request('/api/auth/sign-in/email', { method: 'POST', body: { email: EMAIL, password: PASSWORD, ...(oauth_query ? { oauth_query } : {}) } });
    assert.equal(response.status, 200, await response.clone().text());
    return response.json();
  }
  async function register(overrides = {}) {
    const response = await request('/api/auth/oauth2/register', { method: 'POST', cookie: false, body: {
      client_name: 'Graph test client', redirect_uris: ['http://127.0.0.1:9812/callback'],
      token_endpoint_auth_method: 'none', grant_types: ['authorization_code'],
      response_types: ['code'], scope: 'graph:read media:read', ...overrides,
    } });
    assert.equal(response.status, 201, await response.clone().text());
    return response.json();
  }
  function authorization(client, scopes = 'graph:read media:read', overrides = {}) {
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

test('capture session gate accepts only the singleton owner, not just any authenticated session', async t => {
  const f = await fixture(t);
  assert.equal(await f.service.getOwnerSession({}), null);
  await f.owner();
  await f.login();
  const owner = await f.service.getOwnerSession(f.cookieHeaders());
  assert.equal(owner.user.email, EMAIL);
  const context = await f.service.auth.$context;
  const otherEmail = 'not-the-owner@example.net';
  const other = await context.internalAdapter.createUser({ email: otherEmail, name: 'Not owner', emailVerified: true });
  await context.internalAdapter.linkAccount({ userId: other.id, providerId: 'credential', accountId: other.id, password: await context.password.hash(PASSWORD) });
  const response = await f.request('/api/auth/sign-in/email', { method: 'POST', body: { email: otherEmail, password: PASSWORD } });
  assert.equal(response.status, 200);
  assert.equal((await f.service.auth.api.getSession({ headers: f.cookieHeaders() })).user.id, other.id);
  assert.equal(await f.service.getOwnerSession(f.cookieHeaders()), null);
  await f.service.close();
  assert.equal(await f.service.getOwnerSession(f.cookieHeaders()), null);
});

test('optional library ownerEmail constraint is not a default or CLI identity', async () => {
  const config = { publicUrl: 'http://127.0.0.1:9080', databasePath: ':memory:', secret: SECRET };
  await assert.rejects(createAuthService({ ...config, ownerEmail: 'invalid' }), /Invalid ownerEmail/);
  const service = await createAuthService({ ...config, ownerEmail: '  Chosen@Example.net  ' });
  try {
    await assert.rejects(service.setupOwner({ email: EMAIL, password: PASSWORD }), error => error.status === 400);
    assert.equal((await service.setupOwner({ email: 'chosen@example.net', password: PASSWORD })).email, 'chosen@example.net');
  } finally { await service.close(); }
});

test('browser sign-in distinguishes local capture returns from signed OAuth and has no public setup UI', async () => {
  assert.doesNotMatch(authPage('sign-in'), /First-time setup|\/auth\/setup|bootstrapToken/);
  assert.doesNotMatch(AUTH_JS, /\/auth\/setup|bootstrapToken|page==='setup'/);
  assert.match(authPage('account'), /href="\/">Back to Capture/);
  const scope = createContext({ URL, URLSearchParams, location: { origin: 'https://capture.example' },
    document: { querySelector: () => ({}), body: { dataset: { page: 'test' } } } });
  runInContext(AUTH_JS, scope);
  const continuation = search => JSON.parse(runInContext(`JSON.stringify(loginContinuation(${JSON.stringify(search)}))`, scope));
  assert.deepEqual(continuation('?return_to=%2F'), { returnTo: '/' });
  assert.deepEqual(continuation('?return_to=%2Frecordings%3Fday%3Dtoday'), { returnTo: '/recordings?day=today' });
  assert.deepEqual(continuation(''), {});
  const oauth = 'client_id=client&scope=graph%3Aread&sig=signature';
  assert.deepEqual(continuation(`?${oauth}`), { oauthQuery: oauth });
  for (const path of ['https://evil.example/', '//evil.example', '/\\\\evil.example', '/ok\nnext', '/ok\u007fnext', '', 'relative']) {
    assert.throws(() => continuation(`?return_to=${encodeURIComponent(path)}`), /Invalid return path/);
  }
  for (const query of ['?return_to=%2F&return_to=%2Fother', '?return_to=%2F&sig=signature']) {
    assert.throws(() => continuation(query), /Invalid return path/);
  }
});

test('browser submit sends return_to login without oauth_query and preserves signed OAuth flow', async () => {
  for (const search of ['?return_to=%2F', '?return_to=%2Frecordings%3Fday%3Dtoday', '?return_to=%2F%2Fevil.example', '?client_id=client&sig=signed']) {
    let submitted;
    let destination;
    const form = { addEventListener: (_, handler) => { submitted = handler; }, querySelectorAll: () => [], reset() {} };
    const calls = [];
    const scope = createContext({ URL, URLSearchParams,
      location: { origin: 'https://capture.example', search, assign: url => { destination = url; } },
      document: { querySelector: selector => selector === '#status' ? {} : form, body: { dataset: { page: 'sign-in' } } },
      FormData: class { get(key) { return key === 'email' ? EMAIL : PASSWORD; } },
      fetch: async (path, options) => { calls.push({ path, body: JSON.parse(options.body) }); return { ok: true, json: async () => ({ redirect: true, url: '/auth/consent?signed=1' }) }; },
    });
    runInContext(AUTH_JS, scope);
    await submitted({ preventDefault() {} });
    if (search.includes('evil.example')) {
      assert.equal(calls.length, 0);
      assert.equal(destination, undefined);
    } else if (search.includes('return_to')) {
      assert.deepEqual(calls, [{ path: '/api/auth/sign-in/email', body: { email: EMAIL, password: PASSWORD } }]);
      assert.equal(destination, `https://capture.example${search.includes('recordings') ? '/recordings?day=today' : '/'}`);
    } else {
      assert.equal(calls[0].body.oauth_query, search.slice(1));
      assert.equal(destination, 'https://capture.example/auth/consent?signed=1');
    }
  }
});

test('minimal metadata, closed signup, canonical origin, private persistent WAL database and first-owner latch', async t => {
  const f = await fixture(t);
  const metadata = await (await f.request('/.well-known/oauth-authorization-server/api/auth')).json();
  assert.deepEqual(metadata, {
    issuer: `${f.origin}/api/auth`,
    authorization_endpoint: `${f.origin}/api/auth/oauth2/authorize`,
    token_endpoint: `${f.origin}/api/auth/oauth2/token`,
    registration_endpoint: `${f.origin}/api/auth/oauth2/register`,
    scopes_supported: ['graph:read', 'media:read'],
    response_types_supported: ['code'],
    response_modes_supported: ['query'],
    grant_types_supported: ['authorization_code'],
    token_endpoint_auth_methods_supported: ['none'],
    code_challenge_methods_supported: ['S256'],
    authorization_response_iss_parameter_supported: true,
    client_id_metadata_document_supported: true,
  });
  for (const path of ['/.well-known/oauth-protected-resource/mcp', '/.well-known/oauth-protected-resource']) {
    assert.deepEqual(await (await f.request(path)).json(), {
      resource: `${f.origin}/mcp`, authorization_servers: [`${f.origin}/api/auth`],
      bearer_methods_supported: ['header'], scopes_supported: ['graph:read', 'media:read'],
    });
  }
  const signup = await f.request('/api/auth/sign-up/email', { method: 'POST', body: { name: 'attacker', email: 'attacker@example.com', password: PASSWORD } });
  assert.ok(signup.status >= 400);
  assert.deepEqual(f.service.getSetupStatus(), { configured: false, setupClaimed: false });
  for (const path of ['/auth/setup', '/api/auth/setup-owner']) {
    assert.ok((await f.request(path, { method: 'POST', body: { email: EMAIL, password: PASSWORD } })).status >= 400);
  }
  await assert.rejects(f.service.setupOwner({ email: 'invalid', password: PASSWORD }), error => error.status === 400);
  await assert.rejects(f.service.setupOwner({ email: EMAIL, password: 'short' }), error => error.status === 400);
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

test('HTTP login → signed consent → PKCE code → long-lived opaque token without refresh → owner revocation', async t => {
  const f = await fixture(t);
  await f.owner();
  const client = await f.register();
  const flow = await f.authorize(client, undefined, { loggedIn: false });
  const response = await f.exchange(client, flow);
  assert.equal(response.status, 200, await response.clone().text());
  const tokens = await response.json();
  assert.ok(tokens.access_token);
  assert.equal(tokens.refresh_token, undefined, 'no refresh tokens are issued');
  assert.ok(tokens.expires_in > ACCESS_TOKEN_LIFETIME_SECONDS - 60 && tokens.expires_in <= ACCESS_TOKEN_LIFETIME_SECONDS);
  assert.ok(!tokens.access_token.includes('.'), 'provider must issue revocable opaque access tokens');
  const principal = await f.service.verify(f.tokenRequest(tokens.access_token), { scopes: ['graph:read', 'media:read'] });
  assert.ok(!(principal instanceof Response), principal instanceof Response ? await principal.text() : '');
  assert.equal(principal.claims.iss, `${f.origin}/api/auth`);
  assert.ok([principal.claims.aud].flat().includes(`${f.origin}/mcp`));
  assert.equal(principal.clientId, client.client_id);
  const db = new DatabaseSync(f.databasePath);
  assert.notEqual(db.prepare('SELECT token FROM oauthAccessToken').get().token, tokens.access_token);
  assert.equal(db.prepare('SELECT count(*) AS n FROM oauthRefreshToken').get().n, 0);
  db.close();
  await f.restart();
  assert.equal((await f.service.verify(f.tokenRequest(tokens.access_token), { scopes: ['graph:read'] })).clientId, client.client_id);
  assert.deepEqual((await f.service.listGrants(f.cookieHeaders())).map(grant => grant.clientId), [client.client_id]);
  assert.deepEqual(await f.service.revokeGrant(client.client_id, f.cookieHeaders()), { success: true });
  assert.equal((await f.service.verify(f.tokenRequest(tokens.access_token), { scopes: [] })).status, 401);
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

test('owner grant revocation removes consent and tokens; consent management is not reachable over HTTP', async t => {
  const f = await fixture(t);
  await f.owner(); await f.login();
  const client = await f.register();
  const flow = await f.authorize(client);
  const response = await f.exchange(client, flow);
  assert.equal(response.status, 200, await response.clone().text());
  const tokens = await response.json();
  assert.equal((await f.service.listGrants({})).status, 401);
  assert.equal((await f.service.revokeGrant(client.client_id, {})).status, 401);
  for (const [path, method] of [['/api/auth/oauth2/get-consents', 'GET'], ['/api/auth/oauth2/delete-consent', 'POST'], ['/api/auth/oauth2/update-consent', 'POST']]) {
    assert.equal((await f.request(path, { method, ...(method === 'POST' ? { body: {} } : {}) })).status, 404, path);
  }
  assert.ok(!(await f.service.verify(f.tokenRequest(tokens.access_token)) instanceof Response));
  assert.deepEqual(await f.service.revokeGrant(client.client_id, f.cookieHeaders()), { success: true });
  assert.equal((await f.service.verify(f.tokenRequest(tokens.access_token))).status, 401);
  assert.deepEqual(await f.service.listGrants(f.cookieHeaders()), []);
});

test('unneeded protocol surface is closed: endpoints, refresh, offline_access, DPoP and client secrets', async t => {
  const f = await fixture(t);
  await f.owner(); await f.login();
  for (const [method, path] of [
    ['GET', '/api/auth/jwks'], ['GET', '/api/auth/token'], ['POST', '/api/auth/oauth2/introspect'], ['POST', '/api/auth/oauth2/revoke'],
    ['GET', '/api/auth/oauth2/userinfo'], ['GET', '/api/auth/oauth2/end-session'], ['POST', '/api/auth/oauth2/create-client'],
    ['GET', '/api/auth/oauth2/get-clients'], ['POST', '/api/auth/oauth2/continue'], ['POST', '/api/auth/oauth2/authorize'],
    ['POST', '/api/auth/sign-up/email'], ['POST', '/api/auth/sign-in/social'], ['POST', '/api/auth/request-password-reset'],
    ['POST', '/api/auth/update-user'], ['POST', '/api/auth/delete-user'], ['GET', '/api/auth/list-sessions'], ['POST', '/api/auth/refresh-token'],
    ['GET', '/.well-known/openid-configuration'], ['GET', '/.well-known/oauth-authorization-server'],
  ]) {
    assert.equal((await f.request(path, { method, ...(method === 'POST' ? { body: {} } : {}) })).status, 404, `${method} ${path}`);
  }
  const client = await f.register();
  // offline_access is not a supported scope.
  const offline = await f.request(f.authorization(client, 'graph:read offline_access').url);
  assert.ok(offline.status >= 400 || new URL((await offline.json()).url, f.origin).searchParams.get('error') === 'invalid_scope');
  // Refresh grants are rejected even for a client whose metadata lists refresh_token.
  const legacy = await f.register({ client_name: 'Legacy refresh client', grant_types: ['authorization_code', 'refresh_token'] });
  const legacyTokens = await (await f.exchange(legacy, await f.authorize(legacy))).json();
  assert.ok(legacyTokens.access_token);
  assert.equal(legacyTokens.refresh_token, undefined);
  const refresh = await f.request('/api/auth/oauth2/token', { method: 'POST', cookie: false, form: true, body: {
    grant_type: 'refresh_token', refresh_token: 'anything', client_id: legacy.client_id, resource: `${f.origin}/mcp`,
  } });
  assert.equal(refresh.status, 400);
  assert.equal((await refresh.json()).error, 'unsupported_grant_type');
  // Bearer only: DPoP proofs and DPoP-bound codes are refused.
  const dpopFlow = await f.authorize(client);
  const dpop = await f.request('/api/auth/oauth2/token', { method: 'POST', cookie: false, form: true, headers: { dpop: 'proof' }, body: {
    grant_type: 'authorization_code', code: dpopFlow.code, client_id: client.client_id,
    redirect_uri: client.redirect_uris[0], code_verifier: dpopFlow.verifier, resource: `${f.origin}/mcp`,
  } });
  assert.equal(dpop.status, 400);
  assert.equal((await f.request(f.authorization(client, 'graph:read', { dpop_jkt: 'thumbprint' }).url)).status, 400);
  const principal = await f.service.verify(new Request(`${f.origin}/mcp`, { headers: { authorization: 'DPoP token' } }));
  assert.equal(principal.status, 401);
  // Public clients only.
  for (const method of ['client_secret_basic', 'client_secret_post', 'private_key_jwt']) {
    const response = await f.request('/api/auth/oauth2/register', { method: 'POST', cookie: false, body: {
      client_name: 'Confidential client', redirect_uris: ['http://127.0.0.1:9812/callback'], token_endpoint_auth_method: method,
    } });
    assert.equal(response.status, 400, method);
    assert.equal((await response.json()).error, 'invalid_client_metadata');
  }
  const defaulted = await f.request('/api/auth/oauth2/register', { method: 'POST', cookie: false, body: {
    client_name: 'Defaulted client', redirect_uris: ['http://127.0.0.1:9812/callback'],
  } });
  assert.equal(defaulted.status, 201, await defaulted.clone().text());
  const registered = await defaulted.json();
  assert.equal(registered.token_endpoint_auth_method, 'none');
  assert.equal(registered.client_secret, undefined);
  const secretFlow = await f.authorize(client);
  assert.equal((await f.exchange(client, secretFlow, { client_secret: 'guess' })).status, 401);
  assert.equal((await f.request('/api/auth/oauth2/token', { method: 'POST', cookie: false, form: true,
    headers: { authorization: `Basic ${Buffer.from(`${client.client_id}:guess`).toString('base64')}` }, body: {
      grant_type: 'authorization_code', code: secretFlow.code, redirect_uri: client.redirect_uris[0], code_verifier: secretFlow.verifier, resource: `${f.origin}/mcp`,
    } })).status, 401);
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

function pendingCodeCount(f, client) {
  const db = new DatabaseSync(f.databasePath);
  try {
    return db.prepare(`SELECT count(*) AS n FROM verification
      WHERE json_valid(value) AND json_extract(value, '$.type')='authorization_code'
      AND json_extract(value, '$.query.client_id')=?`).get(client.client_id).n;
  } finally { db.close(); }
}

{
  test('owner revocation durably destroys outstanding code lineage, survives restart and permits ordinary reconnect', async t => {
    const f = await fixture(t);
    await f.owner(); await f.login();
    const client = await f.register();
    const outstanding = await f.authorize(client);
    const existing = await (await f.exchange(client, await f.authorize(client))).json();
    const unrelatedClient = await f.register({ client_name: 'Unaffected client' });
    const unrelated = await f.authorize(unrelatedClient);
    assert.equal(pendingCodeCount(f, client), 1);
    assert.deepEqual(await f.service.revokeGrant(client.client_id, f.cookieHeaders()), { success: true });
    assert.equal(pendingCodeCount(f, client), 0, 'actual official verification code row must be deleted');
    await f.restart();
    assert.equal((await f.exchange(client, outstanding)).status, 400);
    assert.equal((await f.service.verify(f.tokenRequest(existing.access_token))).status, 401);
    const fresh = await f.authorize(client);
    assert.equal((await f.exchange(client, outstanding)).status, 400, 'reconsent must not revive pre-revoke code');
    assert.equal((await f.service.verify(f.tokenRequest(existing.access_token))).status, 401);
    const reconnected = await (await f.exchange(client, fresh)).json();
    assert.equal((await f.service.verify(f.tokenRequest(reconnected.access_token))).clientId, client.client_id);
    assert.equal((await f.exchange(unrelatedClient, unrelated)).status, 200, 'other client lineage is untouched');
  });
}

{
  test('consent narrowing destroys old credentials even when scopes are subsequently restored', async t => {
    const f = await fixture(t);
    await f.owner(); await f.login();
    const client = await f.register();
    const outstanding = await f.authorize(client);
    const tokens = await (await f.exchange(client, await f.authorize(client))).json();
    const oldNarrowTokens = await (await f.exchange(client, await f.authorize(client, 'graph:read'))).json();
    const narrowFlow = await f.authorize(client, 'graph:read', { prompt: 'consent' });
    assert.equal((await f.service.verify(f.tokenRequest(tokens.access_token))).status, 401);
    assert.equal((await f.service.verify(f.tokenRequest(oldNarrowTokens.access_token))).status, 401,
      'even old credentials whose scopes are still allowed must be invalidated');
    await f.restart();
    const restored = await f.authorize(client);
    assert.equal((await f.exchange(client, outstanding)).status, 400);
    assert.equal((await f.service.verify(f.tokenRequest(tokens.access_token))).status, 401);
    assert.equal((await f.service.verify(f.tokenRequest(oldNarrowTokens.access_token))).status, 401);
    assert.equal((await f.exchange(client, narrowFlow)).status, 200, 'new narrower consent code remains usable');
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

for (const order of ['exchange-first', 'revoke-first']) {
  test(`concurrent ${order} cannot leave credentials that survive revoke/reconsent`, { timeout: 15000 }, async t => {
    const f = await fixture(t);
    await f.owner(); await f.login();
    const client = await f.register();
    const flow = await f.authorize(client);
    const issue = () => f.exchange(client, flow);
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
    }
    assert.equal((await f.exchange(client, flow)).status, 400);
    assert.equal((await f.exchange(client, fresh)).status, 200);
  });
}

test('resource verification is local: CIMD clients are never re-fetched per request', async t => {
  const f = await fixture(t);
  await f.owner(); await f.login();
  // A CIMD client whose metadata URL cannot be fetched. Resolving it would fail,
  // so verification only succeeds if it reads local state.
  const clientId = 'https://metadata.invalid/client.json';
  const token = randomBytes(32).toString('base64url');
  const now = new Date();
  const db = new DatabaseSync(f.databasePath);
  const ownerId = db.prepare('SELECT user_id FROM graph_auth_owner').get().user_id;
  db.prepare(`INSERT INTO oauthClient (id, clientId, clientDiscoveryId, disabled, scopes, redirectUris, tokenEndpointAuthMethod,
    grantTypes, responseTypes, requirePKCE, name, createdAt, updatedAt) VALUES (?, ?, 'cimd', 0, ?, ?, 'none', ?, ?, 1, 'Distributed client', ?, ?)`)
    .run('cimd-client', clientId, JSON.stringify(['graph:read', 'media:read']), JSON.stringify(['https://app.example/callback']),
      JSON.stringify(['authorization_code']), JSON.stringify(['code']), now.toISOString(), now.toISOString());
  db.prepare('INSERT INTO oauthConsent (id, clientId, userId, scopes, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?)')
    .run('cimd-consent', clientId, ownerId, JSON.stringify(['graph:read', 'media:read']), now.toISOString(), now.toISOString());
  db.prepare('INSERT INTO oauthAccessToken (id, token, clientId, userId, resources, scopes, expiresAt, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run('cimd-token', createHash('sha256').update(token).digest('base64url'), clientId, ownerId, JSON.stringify([`${f.origin}/mcp`]),
      JSON.stringify(['graph:read', 'media:read']), new Date(Date.now() + ACCESS_TOKEN_LIFETIME_SECONDS * 1000).toISOString(), now.toISOString());
  db.close();
  for (let i = 0; i < 100; i++) {
    const principal = await f.service.verify(f.tokenRequest(token), { scopes: ['graph:read', 'media:read'] });
    assert.equal(principal.clientId, clientId, `verification ${i + 1} must not depend on a metadata fetch`);
  }
});

test('access outlives the approving browser session and ends on revocation, expiry or client disable', async t => {
  const f = await fixture(t);
  await f.owner(); await f.login();
  const client = await f.register();
  const tokens = await (await f.exchange(client, await f.authorize(client))).json();
  const db = new DatabaseSync(f.databasePath);
  assert.equal(db.prepare('SELECT sessionId FROM oauthAccessToken').get().sessionId, null, 'issued tokens are not session-bound');
  // A token bound before this change is detached when the service starts.
  const sessionId = db.prepare('SELECT id FROM session LIMIT 1').get().id;
  db.prepare('UPDATE oauthAccessToken SET sessionId=?').run(sessionId);
  await f.restart();
  assert.equal(db.prepare('SELECT sessionId FROM oauthAccessToken').get().sessionId, null);
  await f.login();
  assert.equal((await f.request('/api/auth/change-password', { method: 'POST', body: {
    currentPassword: PASSWORD, newPassword: `${PASSWORD}-changed`, revokeOtherSessions: true,
  } })).status, 200);
  assert.equal((await f.request('/api/auth/sign-out', { method: 'POST', body: {} })).status, 200);
  db.prepare('DELETE FROM session').run();
  assert.equal(db.prepare('SELECT count(*) AS n FROM oauthAccessToken WHERE revoked IS NOT NULL').get().n, 0);
  assert.equal((await f.service.verify(f.tokenRequest(tokens.access_token), { scopes: ['graph:read'] })).clientId, client.client_id);
  db.prepare('UPDATE oauthClient SET disabled=1 WHERE clientId=?').run(client.client_id);
  assert.equal((await f.service.verify(f.tokenRequest(tokens.access_token))).status, 401);
  db.prepare('UPDATE oauthClient SET disabled=0 WHERE clientId=?').run(client.client_id);
  db.prepare('UPDATE oauthAccessToken SET revoked=?').run(new Date().toISOString());
  assert.equal((await f.service.verify(f.tokenRequest(tokens.access_token))).status, 401);
  db.prepare('UPDATE oauthAccessToken SET revoked=NULL, expiresAt=?').run(new Date(Date.now() - 1000).toISOString());
  assert.equal((await f.service.verify(f.tokenRequest(tokens.access_token))).status, 401);
  db.close();
});

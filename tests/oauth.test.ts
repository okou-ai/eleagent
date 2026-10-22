import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { getMigrations } from 'better-auth/db/migration';
import { applyMigrations } from '../db/apply.mjs';
import {
  authorizationServerMetadata, consentRequest, createAuth, handleAuthRequest, listGrants, ownerSession,
  protectedResourceMetadata, revokeGrant, verifyAccess, type Auth,
} from '../lib/auth.ts';
import { handleMcp, memoryStore } from '../lib/mcp.ts';
import { startPostgres } from './postgres.ts';

// The whole agent connection against a real (in-process) Postgres: an MCP client registers, the owner signs in and
// allows it, the client reads memory over MCP, refreshes its token after the owner signs out, and loses access when
// the owner disconnects it.

const ORIGIN = 'http://127.0.0.1:3000';
const REDIRECT = 'https://agent.example/callback';
const PASSWORD = 'correct horse battery staple';
const CAPTURE = 'web-0b5f3a2e-8d1c-4e7a-9f20-3c4d5e6f7a8b-back';
const MEDIA = 'media_' + 'a'.repeat(32);

let postgres: Awaited<ReturnType<typeof startPostgres>>;
let auth: Auth;

before(async () => {
  process.env.OWNER_PASSWORD = PASSWORD;
  postgres = await startPostgres();
  const client = await postgres.pool.connect();
  try { await applyMigrations(client); } finally { client.release(); }
  await postgres.pool.query(`INSERT INTO captures (id, camera, first_clip_at, last_clip_at)
    VALUES ($1, 'back', '2026-10-22T09:00:00Z', '2026-10-22T09:00:05Z')`, [CAPTURE]);
  await postgres.pool.query(`INSERT INTO clips (media_id, capture_id, clip_seq, captured_at, captured_end_at, content_type, size_bytes, pathname, meta)
    VALUES ($1, $2, 0, '2026-10-22T09:00:00Z', '2026-10-22T09:00:05Z', 'video/mp4', 1000, $3, '{"locations":[]}')`,
  [MEDIA, CAPTURE, `captures/${CAPTURE}/0000000.mp4`]);
  const [{ value: secret }] = (await postgres.pool.query("SELECT value FROM app_settings WHERE key = 'auth_secret'")).rows;
  auth = createAuth({ origin: ORIGIN, secret, database: postgres.pool });
});
after(async () => { await postgres?.stop(); });

// What this app's form routes pass to Better Auth (see jsonApiRequest).
const route = (path: string, cookie?: string) => new Request(ORIGIN + path,
  { method: 'POST', headers: { Accept: 'application/json', ...(cookie ? { cookie } : {}) } });
const call = (path: string, init: RequestInit = {}) => handleAuthRequest(auth, new Request(ORIGIN + path, init));
const form = (fields: Record<string, string>) => ({
  method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(fields),
});
const store = () => memoryStore((text, params) => postgres.pool.query(text, params).then((result) => result.rows),
  async (pathname) => ({ url: `https://blob.example/${pathname}?signed`, expiresAt: new Date(Date.now() + 600_000) }));
async function mcp(token: string | null, method: string, params: object = {}) {
  const request = new Request(`${ORIGIN}/mcp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream',
      ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const access = await verifyAccess(auth, request);
  if (!access.ok) return { status: access.response.status, challenge: access.response.headers.get('www-authenticate') };
  const response = await handleMcp(request, store(), access.scopes);
  return { status: response.status, body: await response.json() };
}
async function refresh(clientId: string, refreshToken: string) {
  return call('/api/auth/oauth2/token', form({ grant_type: 'refresh_token', client_id: clientId, refresh_token: refreshToken,
    resource: `${ORIGIN}/mcp` }));
}

test('the database schema matches what Better Auth expects', async () => {
  const { toBeCreated, toBeAdded } = await getMigrations(auth.options);
  assert.deepEqual([...toBeCreated, ...toBeAdded].map((table) => table.table), []);
});

test('only the OAuth endpoints agents need are reachable, and discovery points at them', async () => {
  for (const [method, path] of [['POST', '/api/auth/sign-up/email'], ['POST', '/api/auth/sign-in/owner'],
    ['POST', '/api/auth/sign-in/email'], ['GET', '/api/auth/oauth2/get-consents'], ['POST', '/api/auth/oauth2/consent']]) {
    assert.equal((await call(path, { method })).status, 404, path);
  }
  assert.equal((await call('/api/auth/oauth2/token', form({ grant_type: 'client_credentials' }))).status, 400);
  assert.equal((await call('/api/auth/oauth2/token', form({ grant_type: 'authorization_code', client_secret: 'x' }))).status, 401);
  const metadata = authorizationServerMetadata(auth);
  assert.equal(metadata.issuer, `${ORIGIN}/api/auth`);
  assert.ok(metadata.scopes_supported.includes('offline_access'));
  assert.deepEqual(protectedResourceMetadata(auth).authorization_servers, [metadata.issuer]);
  const unauthenticated = await mcp(null, 'tools/list');
  assert.equal(unauthenticated.status, 401);
  assert.match(unauthenticated.challenge ?? '', /resource_metadata="http:\/\/127\.0\.0\.1:3000\/\.well-known\/oauth-protected-resource\/mcp"/);
});

test('an agent connects with the owner\'s consent, reads memory, keeps access after sign-out and loses it on disconnect', async () => {
  const registered = await call('/api/auth/oauth2/register', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_name: 'Test agent', redirect_uris: [REDIRECT], grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'], scope: 'memory:read media:read offline_access' }),
  });
  assert.equal(registered.status, 201, await registered.clone().text());
  const { client_id: clientId, client_secret: clientSecret } = await registered.json();
  assert.equal(clientSecret, undefined, 'registered clients are public');

  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const authorize = await call('/api/auth/oauth2/authorize?' + new URLSearchParams({
    response_type: 'code', client_id: clientId, redirect_uri: REDIRECT, scope: 'memory:read media:read offline_access',
    state: 'state-1', code_challenge: challenge, code_challenge_method: 'S256', resource: `${ORIGIN}/mcp`,
  }));
  assert.equal(authorize.status, 302);
  const login = new URL(authorize.headers.get('location')!, ORIGIN);
  assert.equal(login.pathname, '/login');

  await assert.rejects(auth.api.signInOwner({ body: { password: 'wrong', oauth_query: login.search.slice(1) }, headers: new Headers() }));
  const signedIn = await auth.api.signInOwner({
    body: { password: PASSWORD, oauth_query: login.search.slice(1) }, headers: new Headers(), request: route('/api/auth/login'), asResponse: true,
  });
  assert.equal(signedIn.status, 200, await signedIn.clone().text());
  const cookie = signedIn.headers.getSetCookie().map((value) => value.split(';')[0]).join('; ');
  const owner = await ownerSession(auth, new Headers({ cookie }));
  assert.ok(owner, 'signing in starts an owner session');
  const consentUrl = new URL((await signedIn.json()).url, ORIGIN);
  assert.equal(consentUrl.pathname, '/consent');

  const consent = await consentRequest(auth, consentUrl.search.slice(1));
  assert.equal(consent?.clientName, 'Test agent');
  assert.deepEqual(consent?.scopes, ['memory:read', 'media:read', 'offline_access']);
  assert.equal(await consentRequest(auth, consentUrl.search.slice(1).replace('state-1', 'state-2')), null, 'the query is signed');

  const allowed = await auth.api.oauth2Consent({
    body: { accept: true, oauth_query: consentUrl.search.slice(1) }, headers: new Headers({ cookie }),
    request: route('/api/account/consent', cookie), asResponse: true,
  });
  const decision = await allowed.json();
  const callback = new URL(decision.redirect_uri ?? decision.url);
  assert.equal(callback.origin + callback.pathname, REDIRECT);
  assert.equal(callback.searchParams.get('state'), 'state-1');

  const exchanged = await call('/api/auth/oauth2/token', form({ grant_type: 'authorization_code', client_id: clientId,
    code: callback.searchParams.get('code')!, redirect_uri: REDIRECT, code_verifier: verifier, resource: `${ORIGIN}/mcp` }));
  assert.equal(exchanged.status, 200, await exchanged.clone().text());
  const tokens = await exchanged.json();
  assert.ok(tokens.access_token && tokens.refresh_token);

  const listed = await mcp(tokens.access_token, 'tools/list');
  assert.deepEqual(listed.body.result.tools.map((tool: { name: string }) => tool.name).sort(), ['get_clip', 'list_captures', 'list_clips']);
  const captures = await mcp(tokens.access_token, 'tools/call', { name: 'list_captures', arguments: {} });
  assert.deepEqual(captures.body.result.structuredContent.captures,
    [{ capture_id: CAPTURE, camera: 'back', started_at: '2026-10-22T09:00:00.000Z', last_clip_at: '2026-10-22T09:00:05.000Z', clips: 1 }]);
  const clip = await mcp(tokens.access_token, 'tools/call', { name: 'get_clip', arguments: { media_id: MEDIA } });
  assert.equal(clip.body.result.structuredContent.download_url, `https://blob.example/captures/${CAPTURE}/0000000.mp4?signed`);
  assert.deepEqual((await listGrants(auth, owner.user.id)).map((grant) => grant.clientName), ['Test agent']);

  // Offline access: the owner's browser session ending does not disconnect the agent.
  await auth.api.signOut({ headers: new Headers({ cookie }) });
  const refreshed = await refresh(clientId, tokens.refresh_token);
  assert.equal(refreshed.status, 200, await refreshed.clone().text());
  const renewed = await refreshed.json();
  assert.equal((await mcp(renewed.access_token, 'tools/call', { name: 'list_clips', arguments: { capture_id: CAPTURE } })).status, 200);

  await revokeGrant(auth, owner.user.id, clientId);
  assert.equal((await mcp(renewed.access_token, 'tools/list')).status, 401);
  assert.equal((await refresh(clientId, renewed.refresh_token)).status, 400);
  assert.deepEqual(await listGrants(auth, owner.user.id), []);
});

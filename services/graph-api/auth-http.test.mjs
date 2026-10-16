import assert from 'node:assert/strict';
import { once } from 'node:events';
import { before, after, test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createApiServer } from './server.mjs';
import { authPage, AUTH_JS } from './auth-pages.mjs';

// Adapter/routing tests. Real Better Auth OAuth verification is covered in auth.test.mjs.
let server, origin;
const seen = [];
const token = 'legacy-bootstrap-token-not-an-oauth-token-123';
const store = {
  getEntity: async (id) => ({ id, properties: { kind: 'episode' } }),
  listEntities: async () => ({ entities: [], after: null }),
  listLinks: async () => ({ entities: [], links: [], after: null }),
  subgraph: async () => ({ entities: [], links: [], truncated: false }),
};
const challenge = (status, scopes) => new Response(JSON.stringify({ error: status === 401 ? 'invalid_token' : 'insufficient_scope' }), {
  status, headers: { 'Content-Type': 'application/json', 'WWW-Authenticate': `Bearer resource_metadata="https://canonical.test/.well-known/oauth-protected-resource/mcp", scope="${scopes.join(' ')}"` },
});
before(async () => {
  const authService = {
    async verify(request, { scopes }) {
      seen.push({ url: request.url, scopes });
      const granted = request.headers.get('Authorization') === 'Bearer oauth-graph' ? ['graph:read']
        : request.headers.get('Authorization') === 'Bearer oauth-media' ? ['media:read'] : null;
      if (!granted) return challenge(401, scopes);
      if (scopes.some((s) => !granted.includes(s))) return challenge(403, scopes);
      return { userId: 'synthetic-owner', scopes: granted };
    },
    async handler(request) {
      if (new URL(request.url).pathname.includes('well-known')) return Response.json({ issuer: 'https://canonical.test/api/auth' });
      const headers = new Headers({ 'Content-Type': 'application/json' });
      headers.append('Set-Cookie', 'first=1; HttpOnly'); headers.append('Set-Cookie', 'second=2; HttpOnly');
      return new Response('{}', { headers });
    },
    async setupOwner(body) { if (body.bootstrapToken !== token) throw new Error('never echo this secret'); },
    async consentDetails() { return { clientName: '<script>bad</script>', scopes: ['graph:read'] }; },
    async listGrants(headers) { if (!headers.get('cookie')) throw new Error(); return []; },
    async revokeGrant() {},
    auth: { api: { getSession: async () => null } },
  };
  server = createApiServer({ store, token, authService, authPublicUrl: 'https://canonical.test', archive: {
    proxyOriginal: async (req, res) => { res.writeHead(200); res.end('synthetic video'); },
  } });
  server.listen(0, '127.0.0.1'); await once(server, 'listening'); origin = `http://127.0.0.1:${server.address().port}`;
});
after(async () => new Promise((resolve) => server.close(resolve)));

test('OAuth challenges protect MCP, originals and REST; old bootstrap key is not an access token', async () => {
  for (const path of ['/mcp', `/v1/archive/media/media_${'a'.repeat(32)}/original`, '/v1/graph/entities']) {
    for (const authorization of [undefined, `Bearer ${token}`]) {
      const r = await fetch(origin + path, { headers: authorization ? { Authorization: authorization } : {} });
      assert.equal(r.status, 401); assert.ok(r.headers.get('www-authenticate').includes('resource_metadata='));
    }
  }
});
test('tool and original scope checks cannot be bypassed by URL or protocol method', async () => {
  const client = new Client({ name: 'scope-adapter-test', version: '1.0.0' });
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(origin + '/mcp'), { requestInit: { headers: { Authorization: 'Bearer oauth-graph' } } }));
    const entity = await client.callTool({ name: 'get_entity', arguments: { id: 'synthetic' } });
    assert.equal(entity.structuredContent.id, 'synthetic');
    const r = await fetch(origin + '/mcp', { method: 'POST', headers: { Authorization: 'Bearer oauth-graph', 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'list_video_clips', arguments: {} } }) });
    assert.equal(r.status, 403); assert.ok(r.headers.get('www-authenticate').includes('media:read'));
    const path = `/v1/archive/media/media_${'a'.repeat(32)}/original`;
    assert.equal((await fetch(origin + path, { headers: { Authorization: 'Bearer oauth-graph' } })).status, 403);
    assert.equal((await fetch(origin + path, { headers: { Authorization: 'Bearer oauth-media' } })).status, 200);
    assert.equal((await fetch(origin + '/v1/graph/entities', { headers: { Authorization: 'Bearer oauth-media' } })).status, 403);
  } finally { await client.close(); }
});
test('canonical URL ignores untrusted host and forwarding headers', async () => {
  await fetch(origin + '/mcp', { headers: { 'X-Forwarded-Host': 'evil.invalid', 'X-Forwarded-Proto': 'http' } });
  assert.equal(seen.at(-1).url, 'https://canonical.test/mcp');
});
test('discovery is public, setup requires same-origin and API Set-Cookie headers survive', async () => {
  const discovery = await fetch(origin + '/.well-known/oauth-protected-resource/mcp');
  assert.equal(discovery.status, 200);
  const response = await fetch(origin + '/api/auth/get-session');
  assert.equal(response.headers.getSetCookie().length, 2);
  const bad = await fetch(origin + '/auth/setup', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ bootstrapToken: token }) });
  assert.equal(bad.status, 403);
  const setup = await fetch(origin + '/auth/setup', { method: 'POST', headers: { Origin: 'https://canonical.test', 'Content-Type': 'application/json' }, body: JSON.stringify({ bootstrapToken: token, email: 'owner@example.test', password: 'synthetic-long-password' }) });
  assert.equal(setup.status, 201);
  const large = await fetch(origin + '/api/auth/sign-in/email', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ padding: 'x'.repeat(65537) }) });
  assert.equal(large.status, 413);
});
test('account is session-gated; pages are CSP-protected and consent labels escaped', async () => {
  assert.equal((await fetch(origin + '/auth/account', { redirect: 'manual' })).headers.get('location'), '/auth/sign-in');
  assert.equal((await fetch(origin + '/auth/grants')).status, 401);
  const response = await fetch(origin + '/auth/consent?untrusted=still-validated-by-core');
  assert.ok(response.headers.get('content-security-policy').includes("frame-ancestors 'none'"));
  const html = await response.text(); assert.ok(!html.includes('<script>bad</script>')); assert.ok(html.includes('&lt;script&gt;'));
  const page = authPage('setup'); assert.ok(!page.includes(token)); assert.ok(page.includes('type="password"'));
  new Function(AUTH_JS);
});

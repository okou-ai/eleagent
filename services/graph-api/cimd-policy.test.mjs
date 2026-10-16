import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { validateCimdMetadata } from '@better-auth/cimd';
import { CIMD_ORIGIN_BOUND_FIELDS, createAuthService } from './auth.mjs';

const CLIENT_ID = 'https://api.example.com/oauth/client.json';
const CALLBACK = 'https://app.example.com/callback';
const metadata = overrides => ({
  client_id: CLIENT_ID,
  client_name: 'Synthetic distributed client',
  client_uri: 'https://app.example.com/',
  redirect_uris: [CALLBACK],
  token_endpoint_auth_method: 'none',
  ...overrides,
});
const validate = overrides => validateCimdMetadata(CLIENT_ID, metadata(overrides), {
  originBoundFields: CIMD_ORIGIN_BOUND_FIELDS,
});
function rejected(result, pattern) {
  assert.equal(result.valid, false, JSON.stringify(result));
  assert.match(result.error, pattern);
}

test('production exports only the immutable logout-origin constraint', () => {
  assert.deepEqual(CIMD_ORIGIN_BOUND_FIELDS, ['post_logout_redirect_uris']);
  assert.ok(Object.isFrozen(CIMD_ORIGIN_BOUND_FIELDS));
});

test('actual policy accepts distributed client homepage and callback; official default rejects homepage', () => {
  const result = validate();
  assert.equal(result.valid, true, JSON.stringify(result));
  rejected(validateCimdMetadata(CLIENT_ID, metadata()), /client_uri.*origin/i);
});

test('client_id must still equal the metadata document URL', () => {
  rejected(validate({ client_id: 'https://app.example.com/client.json' }), /client_id.*match/i);
});

// These are metadata URL checks, not DNS resolution or transport SSRF tests.
for (const field of ['client_uri', 'logo_uri', 'tos_uri', 'policy_uri']) {
  test(`${field}: public cross-origin HTTPS remains valid`, () => {
    const result = validate({ [field]: 'https://assets.example.com/public' });
    assert.equal(result.valid, true, JSON.stringify(result));
  });
  for (const [label, url, error] of [
    ['private HTTP', 'http://127.0.0.1/private', /private|reserved/i],
    ['private HTTPS', 'https://192.168.1.1/private', /private|reserved/i],
    ['link-local HTTPS', 'https://169.254.169.254/latest', /private|reserved/i],
    ['HTTPS credentials', 'https://user:password@app.example.com/', /credentials/i],
    ['javascript', 'javascript:alert(1)', /HTTP\(S\)/i],
  ]) {
    test(`${field}: ${label} is rejected with the actual policy`, () => {
      rejected(validate({ [field]: url }), error);
    });
  }
}

test('cross-origin logout is rejected, same-origin logout is allowed', () => {
  rejected(validate({ post_logout_redirect_uris: ['https://app.example.com/logout'] }), /post_logout_redirect_uris.*origin/i);
  const result = validate({ post_logout_redirect_uris: ['https://api.example.com/logout'] });
  assert.equal(result.valid, true, JSON.stringify(result));
  rejected(validate({ post_logout_redirect_uris: [
    'https://api.example.com/logout', 'https://foreign.example.com/logout',
  ] }), /post_logout_redirect_uris.*origin/i);
});

test('metadata validation intentionally does not bind callback origins or validate an authorization request', () => {
  const result = validate({ redirect_uris: ['https://foreign.example.com/callback'] });
  assert.equal(result.valid, true, JSON.stringify(result));
});

// Real service + official provider over loopback HTTP, with ephemeral SQLite.
// DCR avoids fetching public CIMD documents; this tests provider exact matching,
// not the CIMD fetch -> discovery -> authorize chain. No owner/login is needed.
test('actual provider HTTP rejects unregistered redirects, including same-origin path mismatch', { timeout: 15000 }, async t => {
  let service;
  let origin;
  const server = createServer(async (req, res) => {
    try {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const response = await service.handler(new Request(`${origin}${req.url}`, {
        method: req.method, headers: req.headers,
        ...(!['GET', 'HEAD'].includes(req.method) ? { body: Buffer.concat(chunks) } : {}),
      }));
      res.writeHead(response.status, Object.fromEntries(response.headers));
      res.end(Buffer.from(await response.arrayBuffer()));
    } catch {
      res.writeHead(500); res.end('test bridge failure');
    }
  });
  t.after(async () => {
    await new Promise(resolve => server.close(resolve));
    if (service) await service.close();
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  origin = `http://127.0.0.1:${server.address().port}`;
  service = await createAuthService({
    publicUrl: origin, databasePath: ':memory:',
    secret: 'synthetic-cimd-policy-test-secret-not-a-real-account-secret',
  });
  const registration = await fetch(`${origin}/api/auth/oauth2/register`, {
    method: 'POST', headers: { 'content-type': 'application/json', origin },
    body: JSON.stringify({ client_name: 'Synthetic redirect boundary', redirect_uris: [CALLBACK],
      token_endpoint_auth_method: 'none', grant_types: ['authorization_code'],
      response_types: ['code'], scope: 'graph:read' }),
  });
  assert.equal(registration.status, 201, await registration.clone().text());
  const client = await registration.json();
  for (const redirect of [CALLBACK, 'https://foreign.example.com/callback', `${CALLBACK}/unregistered`]) {
    const query = new URLSearchParams({ client_id: client.client_id, redirect_uri: redirect,
      response_type: 'code', scope: 'graph:read', resource: `${origin}/mcp`, state: 'synthetic-state',
      code_challenge: createHash('sha256').update('x'.repeat(64)).digest('base64url'), code_challenge_method: 'S256' });
    const response = await fetch(`${origin}/api/auth/oauth2/authorize?${query}`, {
      redirect: 'manual', headers: { accept: 'text/html' },
    });
    if (redirect === CALLBACK) {
      assert.ok([200, 302].includes(response.status), await response.clone().text());
      const destination = response.status === 302 ? response.headers.get('location') : (await response.json()).url;
      const login = new URL(destination, origin);
      assert.equal(login.origin, origin);
      assert.equal(login.pathname, '/auth/sign-in');
    } else {
      assert.equal(response.status, 200, await response.clone().text());
      assert.equal(response.headers.get('location'), null, 'must not redirect to an unregistered callback');
      const denial = await response.json();
      assert.equal(denial.redirect, true);
      const errorUrl = new URL(denial.url);
      assert.equal(errorUrl.origin, origin, 'error stays at the authorization server');
      assert.equal(errorUrl.pathname, '/api/auth/error');
      assert.equal(errorUrl.searchParams.get('error'), 'invalid_redirect');
      assert.equal(errorUrl.searchParams.has('code'), false);
    }
  }
});

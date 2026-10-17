import { betterAuth } from 'better-auth';
import { getMigrations } from 'better-auth/db/migration';
import { mcp } from '@better-auth/mcp';
import { cimd } from '@better-auth/cimd';
import { fetchClientMetadataResource } from '@better-auth/cimd/node';
import { getOAuthProviderApi, verifyOAuthQueryParams } from '@better-auth/oauth-provider';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { chmod, lstat, mkdir, open } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

export const RESOURCE_SCOPES = Object.freeze(['graph:read', 'media:read']);
// client_uri is a display/homepage URL, not a redirect or client identifier.
// Distributed clients may serve metadata and their product on different origins
// (CIMD draft-02 section 8.1 permits server policy here). Keep logout URLs bound;
// registered OAuth redirects still require exact matching by the provider.
export const CIMD_ORIGIN_BOUND_FIELDS = Object.freeze(['post_logout_redirect_uris']);
// One long-lived access token per authorization; there are no refresh tokens.
// The owner ends access by revoking the application at /auth/account.
export const ACCESS_TOKEN_LIFETIME_SECONDS = 60 * 60 * 24 * 365;

// The only Better Auth routes reachable over HTTP. Everything else, including
// introspection, token revocation, JWKS, userinfo, signup and client management, is 404.
const PUBLIC_ROUTES = new Set([
  'GET /api/auth/oauth2/authorize',
  'POST /api/auth/oauth2/token',
  'POST /api/auth/oauth2/register',
  'POST /api/auth/oauth2/consent',
  'POST /api/auth/sign-in/email',
  'POST /api/auth/sign-out',
  'GET /api/auth/get-session',
  'POST /api/auth/change-password',
  'GET /api/auth/error',
]);
const PROTECTED_RESOURCE_METADATA_PATHS = ['/.well-known/oauth-protected-resource/mcp', '/.well-known/oauth-protected-resource'];
const AUTHORIZATION_SERVER_METADATA_PATH = '/.well-known/oauth-authorization-server/api/auth';

function oauthError(error, description, status = 400) {
  return json({ error, error_description: description }, status);
}

function canonicalOrigin(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error('publicUrl must be an explicit canonical origin'); }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/' ||
      (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback))) {
    throw new Error('publicUrl must be an HTTPS origin (HTTP is allowed only on loopback)');
  }
  return url.origin;
}

function json(body, status = 200, headers = {}) {
  return Response.json(body, { status, headers: { 'cache-control': 'no-store', ...headers } });
}

function setupError(status, message) {
  const error = new Error(message);
  error.status = error.statusCode = status;
  return error;
}

/** Real Better Auth OAuth provider. The caller owns the Node HTTP/Fetch bridge and UI. */
export async function createAuthService({ publicUrl, databasePath, secret, ownerEmail } = {}) {
  const origin = canonicalOrigin(publicUrl);
  const issuer = `${origin}/api/auth`;
  const resource = `${origin}/mcp`;
  if (typeof secret !== 'string' || secret.length < 32) throw new Error('A persistent auth secret of at least 32 characters is required');
  if (typeof databasePath !== 'string' || !databasePath.length) throw new Error('A dedicated SQLite databasePath is required');
  // Optional library constraint for tests/embedders; the operator CLI has no fixed email.
  const expectedEmail = ownerEmail?.trim().toLowerCase();
  if (ownerEmail !== undefined && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(expectedEmail)) throw new Error('Invalid ownerEmail');

  // Create privately before SQLite opens it, including sidecar files inherited from its mode.
  if (databasePath !== ':memory:') {
    databasePath = resolve(databasePath);
    await mkdir(dirname(databasePath), { recursive: true, mode: 0o700 });
    try {
      const file = await open(databasePath, 'wx', 0o600);
      await file.close();
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const info = await lstat(databasePath);
      if (!info.isFile() || info.isSymbolicLink()) throw new Error('Auth database must be a regular file');
    }
    await chmod(databasePath, 0o600);
  }
  const database = new DatabaseSync(databasePath);
  database.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');
  let closed = false;
  try {
    const provider = mcp({
      resource,
      loginPage: '/auth/sign-in',
      consentPage: '/auth/consent',
      scopes: RESOURCE_SCOPES,
      resources: [{ identifier: resource, allowedScopes: RESOURCE_SCOPES }],
      // refresh_token stays accepted in client metadata only so existing CIMD
      // documents and DCR requests that list it still register. Without the
      // offline_access scope no refresh token is ever issued, and the public
      // token endpoint rejects the refresh grant.
      grantTypes: ['authorization_code', 'refresh_token'],
      // Resource-bound JWTs in 1.7.10 cannot be revoked, even via introspection.
      // This official option provides hashed opaque tokens and live revocation.
      disableJwtPlugin: true,
      storeTokens: 'hashed',
      accessTokenExpiresIn: ACCESS_TOKEN_LIFETIME_SECONDS,
      clientRegistrationRequirePKCE: true,
      allowDynamicClientRegistration: true,
      allowUnauthenticatedClientRegistration: true,
      clientRegistrationDefaultApplicationType: 'infer',
      clientRegistrationDefaultScopes: RESOURCE_SCOPES,
      clientPrivileges: () => false,
      resourcePrivileges: () => false,
    });
    const auth = betterAuth({
      appName: 'Graph API',
      baseURL: issuer,
      basePath: '/api/auth',
      secret,
      database,
      trustedOrigins: [origin],
      emailAndPassword: { enabled: true, disableSignUp: true, minPasswordLength: 12, maxPasswordLength: 128 },
      user: { changeEmail: { enabled: false }, deleteUser: { enabled: false } },
      session: { cookieCache: { enabled: false } },
      rateLimit: { enabled: true, storage: 'database' },
      advanced: { useSecureCookies: origin.startsWith('https:'), database: { transaction: true } },
      logger: { disabled: true },
      plugins: [provider, cimd({ fetchClientMetadataResource, originBoundFields: CIMD_ORIGIN_BOUND_FIELDS })],
    });
    const migrations = await getMigrations(auth.options);
    await migrations.runMigrations();
    database.exec(`CREATE TABLE IF NOT EXISTS graph_auth_owner (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      user_id TEXT,
      claimed_at TEXT NOT NULL
    )`);
    const context = await auth.$context;
    const providerOptions = provider.options;
    // Better Auth binds access tokens to the browser session that approved them
    // and revokes them when that session ends (sign-out, password change,
    // session expiry). Grants here last until expiry or revocation at
    // /auth/account instead, so issued tokens are detached from the session.
    const detachFromSession = database.prepare('UPDATE oauthAccessToken SET sessionId=NULL WHERE token=?');
    database.prepare('UPDATE oauthAccessToken SET sessionId=NULL WHERE sessionId IS NOT NULL AND revoked IS NULL').run();
    // One service instance / one Node process owns this DB. All official HTTP
    // issuance (including login continuations), consent changes, revocation and
    // resource verification share this queue. This is NOT a cross-process lock;
    // callers must not invoke mutating auth.api methods outside this boundary.
    let operationTail = Promise.resolve();
    function serialized(operation) {
      const result = operationTail.then(() => closed ? json({ error: 'auth_unavailable' }, 503) : operation());
      operationTail = result.then(() => {}, () => {});
      return result;
    }
    function invalidateGrant(userId, clientId) {
      // Better Auth 1.7.10 redirectWithAuthorizationCode persists this exact
      // typed JSON in verification.value; checkVerificationValue consumes it.
      // No secondary storage is configured. Delete the actual code lineage,
      // not merely today's tokens/consent, durably in the same SQLite commit.
      database.exec('BEGIN IMMEDIATE');
      try {
        database.prepare(`DELETE FROM verification WHERE json_valid(value)
          AND json_extract(value, '$.type') = 'authorization_code'
          AND json_extract(value, '$.userId') = ?
          AND json_extract(value, '$.query.client_id') = ?`).run(userId, clientId);
        database.prepare('DELETE FROM oauthAccessToken WHERE userId=? AND clientId=?').run(userId, clientId);
        database.prepare('DELETE FROM oauthRefreshToken WHERE userId=? AND clientId=?').run(userId, clientId);
        database.exec('COMMIT');
      } catch (error) {
        database.exec('ROLLBACK');
        throw error;
      }
    }
    const endpointContext = request => ({ context, request, headers: request.headers });
    const ownerId = () => database.prepare('SELECT user_id FROM graph_auth_owner WHERE singleton=1').get()?.user_id;
    const ownerSession = async request => {
      if (closed) return null;
      const session = await auth.api.getSession({ headers: request.headers });
      return session?.user.id === ownerId() ? session : null;
    };
    const consentFor = async (userId, clientId) => context.adapter.findOne({
      model: 'oauthConsent', where: [{ field: 'userId', value: userId }, { field: 'clientId', value: clientId }],
    });
    const challenge = (status, scopes, invalid = false) => {
      const error = status === 403 ? 'insufficient_scope' : invalid ? 'invalid_token' : undefined;
      return json({ error: error ?? 'unauthorized' }, status, {
        'www-authenticate': `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp"${error ? `, error="${error}"` : ''}${scopes.length ? `, scope="${scopes.join(' ')}"` : ''}`,
      });
    };

    // Local library API only: never expose this method through an HTTP route.
    // Operators must stop graph-api before running init-owner.mjs (single writer).
    async function setupOwner(input = {}) {
      if (closed) throw setupError(503, 'Auth service is closed');
      const email = typeof input.email === 'string' ? input.email.trim().toLowerCase() : '';
      const password = input.password;
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || (expectedEmail && expectedEmail !== email)) throw setupError(400, 'Invalid owner email');
      if (typeof password !== 'string' || password.length < 12 || password.length > 128) throw setupError(400, 'Password must be between 12 and 128 characters');
      // Hash before taking the process-independent SQLite first-owner latch.
      const hash = await context.password.hash(password);
      if (database.prepare('SELECT count(*) AS n FROM user').get().n !== 0) throw setupError(409, 'Owner is already configured');
      try {
        database.prepare('INSERT INTO graph_auth_owner(singleton, claimed_at) VALUES(1, ?)').run(new Date().toISOString());
      } catch { throw setupError(409, 'Owner is already configured or setup is in progress'); }
      // A crash after claiming deliberately fails closed; never automatically reopen signup.
      let user;
      try {
        user = await context.internalAdapter.createUser({ email, name: 'Owner', emailVerified: true }, { method: 'email-password' });
        await context.internalAdapter.linkAccount({ userId: user.id, providerId: 'credential', accountId: user.id, password: hash });
        database.prepare('UPDATE graph_auth_owner SET user_id=? WHERE singleton=1').run(user.id);
        return { userId: user.id, email: user.email };
      } catch {
        // Keep the latch on any partial failure. Recovery is an operator action.
        throw setupError(500, 'Owner setup failed; operator recovery is required');
      }
    }

    // Resource-side token verification reads only local SQLite state. It never
    // resolves client metadata (a CIMD client would trigger a remote fetch on
    // every request) and does not depend on the browser session that approved
    // the grant: access lasts until expiry or revocation at /auth/account.
    const findAccessToken = database.prepare(`SELECT clientId, userId, resources, scopes, expiresAt, revoked, confirmation
      FROM oauthAccessToken WHERE token=?`);
    const findClient = database.prepare('SELECT disabled FROM oauthClient WHERE clientId=?');
    const toMs = value => typeof value === 'number' ? value : /^\d+$/.test(String(value ?? '')) ? Number(value) : Date.parse(value ?? '');
    const list = value => {
      try {
        const parsed = JSON.parse(value ?? '[]');
        return Array.isArray(parsed) ? parsed.filter(item => typeof item === 'string') : [];
      } catch { return []; }
    };

    async function verify(request, { scopes = [] } = {}) {
      if (closed) return json({ error: 'auth_unavailable' }, 503);
      if (!Array.isArray(scopes) || scopes.some(scope => !RESOURCE_SCOPES.includes(scope))) throw new TypeError('Unknown required resource scope');
      try {
        const bearer = /^Bearer ([A-Za-z0-9._~+/-]+=*)$/i.exec(request.headers.get('authorization') ?? '');
        if (!bearer) return challenge(401, scopes);
        // Better Auth stores opaque tokens as unpadded base64url SHA-256.
        const token = findAccessToken.get(createHash('sha256').update(bearer[1]).digest('base64url'));
        const expiresAt = toMs(token?.expiresAt);
        const audience = list(token?.resources);
        const client = token?.clientId ? findClient.get(token.clientId) : undefined;
        if (!token || token.revoked || token.confirmation || !(expiresAt > Date.now()) || !token.userId || token.userId !== ownerId() ||
            !audience.includes(resource) || !client || client.disabled) return challenge(401, scopes, true);
        const granted = list(token.scopes);
        const consent = await consentFor(token.userId, token.clientId);
        if (!consent || granted.some(scope => !consent.scopes.includes(scope))) return challenge(401, scopes, true);
        if (scopes.some(scope => !granted.includes(scope))) return challenge(403, scopes);
        return { userId: token.userId, clientId: token.clientId, scopes: granted, claims: {
          iss: issuer, aud: audience, sub: token.userId, client_id: token.clientId, scope: granted.join(' '), exp: Math.floor(expiresAt / 1000),
        } };
      } catch {
        // No token values or provider errors escape into logs or responses.
        return challenge(401, scopes, true);
      }
    }

    async function consentDetails(request) {
      const url = new URL(request.url);
      if (url.origin !== origin) return json({ error: 'invalid_origin' }, 400);
      const oauthQuery = url.search.slice(1);
      if (!await verifyOAuthQueryParams(oauthQuery, context.secret)) return json({ error: 'invalid_oauth_query' }, 400);
      if (!await ownerSession(request)) return json({ error: 'unauthorized' }, 401);
      const params = new URLSearchParams(oauthQuery);
      const clientId = params.get('client_id');
      const scopes = (params.get('scope') ?? '').split(/\s+/).filter(Boolean);
      const client = clientId && await getOAuthProviderApi(endpointContext(request), providerOptions).getClient(clientId);
      if (!client || client.disabled || scopes.some(scope => !RESOURCE_SCOPES.includes(scope) || !client.scopes?.includes(scope)) ||
          params.get('resource') !== resource || params.getAll('resource').length !== 1 || params.has('claims')) return json({ error: 'invalid_oauth_query' }, 400);
      return { clientName: client.name || clientId, clientId, scopes, oauthQuery, resource };
    }

    async function handler(request) {
      if (closed) return json({ error: 'auth_unavailable' }, 503);
      const url = new URL(request.url);
      if (url.origin !== origin) return json({ error: 'invalid_origin' }, 400);
      // Protect both official consent-management routes, as well as approvals
      // that replace an existing consent with a narrower set of scopes.
      const management = ['/api/auth/oauth2/delete-consent', '/api/auth/oauth2/update-consent'].includes(url.pathname);
      const approval = url.pathname === '/api/auth/oauth2/consent';
      if ((management || approval) && request.method === 'POST') {
        if (request.headers.get('origin') !== origin) return json({ error: 'invalid_origin' }, 403);
        const session = await ownerSession(request);
        if (!session) return json({ error: 'unauthorized' }, 401);
        let body;
        try { body = await request.clone().json(); } catch { return json({ error: 'invalid_request' }, 400); }
        if (!body || typeof body !== 'object' || Array.isArray(body)) return json({ error: 'invalid_request' }, 400);
        let consent;
        let nextScopes;
        if (management) {
          consent = typeof body.id === 'string' && await context.adapter.findOne({ model: 'oauthConsent', where: [{ field: 'id', value: body.id }] });
          nextScopes = body.update?.scopes;
        } else if (body.accept === true && typeof body.oauth_query === 'string' &&
            await verifyOAuthQueryParams(body.oauth_query, context.secret)) {
          const query = new URLSearchParams(body.oauth_query);
          const requested = (query.get('scope') ?? '').split(/\s+/).filter(Boolean);
          nextScopes = typeof body.scope === 'string' ? body.scope.split(/\s+/).filter(Boolean) : requested;
          if (nextScopes.every(scope => requested.includes(scope))) {
            consent = await consentFor(session.user.id, query.get('client_id'));
          }
        }
        const narrowing = Array.isArray(nextScopes) && nextScopes.every(scope => typeof scope === 'string') &&
          consent?.scopes.some(scope => !nextScopes.includes(scope));
        if (consent?.userId === session.user.id &&
            (url.pathname === '/api/auth/oauth2/delete-consent' || narrowing)) {
          // Invalidation precedes consent mutation: a crash can only over-revoke,
          // never leave old credentials able to revive. New consent codes are
          // subsequently generated by the official provider, not by this layer.
          invalidateGrant(session.user.id, consent.clientId);
        }
      }
      return auth.handler(request);
    }

    const authorizationServerMetadata = {
      issuer,
      authorization_endpoint: `${issuer}/oauth2/authorize`,
      token_endpoint: `${issuer}/oauth2/token`,
      registration_endpoint: `${issuer}/oauth2/register`,
      scopes_supported: RESOURCE_SCOPES,
      response_types_supported: ['code'],
      response_modes_supported: ['query'],
      grant_types_supported: ['authorization_code'],
      token_endpoint_auth_methods_supported: ['none'],
      code_challenge_methods_supported: ['S256'],
      authorization_response_iss_parameter_supported: true,
      client_id_metadata_document_supported: true,
    };
    const protectedResourceMetadata = {
      resource,
      authorization_servers: [issuer],
      bearer_methods_supported: ['header'],
      scopes_supported: RESOURCE_SCOPES,
    };

    // HTTP entry point. Internal calls (owner revocation) use handler() directly.
    async function publicHandler(request) {
      if (closed) return json({ error: 'auth_unavailable' }, 503);
      const url = new URL(request.url);
      if (url.origin !== origin) return json({ error: 'invalid_origin' }, 400);
      if (request.method === 'GET' && url.pathname === AUTHORIZATION_SERVER_METADATA_PATH) return json(authorizationServerMetadata);
      if (request.method === 'GET' && PROTECTED_RESOURCE_METADATA_PATHS.includes(url.pathname)) return json(protectedResourceMetadata);
      if (!PUBLIC_ROUTES.has(`${request.method} ${url.pathname}`)) return json({ error: 'not_found' }, 404);
      // Bearer tokens only: no DPoP proofs or DPoP-bound authorization codes.
      if (request.headers.has('dpop') || url.searchParams.has('dpop_jkt')) return oauthError('invalid_request', 'DPoP is not supported');
      if (url.pathname === '/api/auth/oauth2/token') {
        // Public clients only: PKCE replaces client secrets.
        if (/^basic /i.test(request.headers.get('authorization') ?? '')) return oauthError('invalid_client', 'Only public clients (token_endpoint_auth_method "none") are supported', 401);
        let form;
        try { form = new URLSearchParams(await request.clone().text()); } catch { return oauthError('invalid_request', 'Invalid token request'); }
        if (form.get('grant_type') !== 'authorization_code') return oauthError('unsupported_grant_type', 'Only the authorization_code grant is supported');
        if (form.has('client_secret') || form.has('client_assertion')) return oauthError('invalid_client', 'Only public clients (token_endpoint_auth_method "none") are supported', 401);
      }
      if (url.pathname === '/api/auth/oauth2/register') {
        let body;
        try { body = await request.clone().json(); } catch { return oauthError('invalid_client_metadata', 'Registration body must be JSON'); }
        if (!body || typeof body !== 'object' || Array.isArray(body)) return oauthError('invalid_client_metadata', 'Registration body must be a JSON object');
        if (body.token_endpoint_auth_method !== undefined && body.token_endpoint_auth_method !== 'none') {
          return oauthError('invalid_client_metadata', 'Only public clients (token_endpoint_auth_method "none") are supported');
        }
        if (body.dpop_bound_access_tokens) return oauthError('invalid_client_metadata', 'DPoP is not supported');
        // RFC 7591 defaults to client_secret_basic when omitted; register a public client instead.
        const headers = new Headers(request.headers);
        headers.delete('content-length');
        request = new Request(request, { headers, body: JSON.stringify({ ...body, token_endpoint_auth_method: 'none' }) });
      }
      const response = await handler(request);
      if (url.pathname === '/api/auth/oauth2/token' && response.ok) {
        const issued = await response.clone().json().catch(() => null);
        if (typeof issued?.access_token === 'string') detachFromSession.run(createHash('sha256').update(issued.access_token).digest('base64url'));
      }
      return response;
    }

    async function listGrants(headers) {
      const request = new Request(`${origin}/auth/account`, { headers });
      const session = await ownerSession(request);
      if (!session) return json({ error: 'unauthorized' }, 401);
      const consents = await auth.api.getOAuthConsents({ headers: request.headers });
      return Promise.all(consents.map(async consent => {
        const client = await context.adapter.findOne({ model: 'oauthClient', where: [{ field: 'clientId', value: consent.clientId }] });
        return { clientId: consent.clientId, clientName: client?.name || consent.clientId, scopes: consent.scopes };
      }));
    }

    async function revokeGrant(clientId, headers) {
      const request = new Request(`${origin}/auth/account`, { headers });
      const session = await ownerSession(request);
      if (!session) return json({ error: 'unauthorized' }, 401);
      if (typeof clientId !== 'string' || !clientId) return json({ error: 'invalid_client' }, 400);
      const consents = await auth.api.getOAuthConsents({ headers: request.headers });
      for (const consent of consents.filter(consent => consent.clientId === clientId)) {
        const revokeHeaders = new Headers(request.headers);
        revokeHeaders.set('origin', origin);
        revokeHeaders.set('content-type', 'application/json');
        const response = await handler(new Request(`${issuer}/oauth2/delete-consent`, {
          method: 'POST', headers: revokeHeaders, body: JSON.stringify({ id: consent.id }),
        }));
        if (!response.ok) return response;
      }
      // Also remove orphaned grants if the consent was already removed.
      invalidateGrant(session.user.id, clientId);
      return { success: true };
    }

    return {
      auth,
      handler: request => serialized(() => publicHandler(request)),
      verify: (request, options) => serialized(() => verify(request, options)),
      revokeGrant: (clientId, headers) => serialized(() => revokeGrant(clientId, headers)),
      setupOwner, consentDetails, listGrants,
      getOwnerSession: headers => ownerSession(new Request(`${origin}/auth/session`, { headers })),
      publicUrl: origin, issuer, resource,
      getSetupStatus: () => ({ configured: Boolean(ownerId()) || database.prepare('SELECT count(*) AS n FROM user').get().n !== 0, setupClaimed: Boolean(database.prepare('SELECT 1 FROM graph_auth_owner WHERE singleton=1').get()) }),
      async close() {
        if (!closed) {
          closed = true;
          await operationTail;
          database.close();
        }
      },
    };
  } catch (error) {
    database.close();
    throw error;
  }
}

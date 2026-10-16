import { betterAuth } from 'better-auth';
import { jwt } from 'better-auth/plugins';
import { getMigrations } from 'better-auth/db/migration';
import { mcp } from '@better-auth/mcp';
import { cimd } from '@better-auth/cimd';
import { fetchClientMetadataResource } from '@better-auth/cimd/node';
import { getOAuthProviderApi, verifyOAuthQueryParams } from '@better-auth/oauth-provider';
import { createDpopReplayStore, enforceDpopBinding, parseAccessTokenAuthorization } from 'better-auth/oauth2';
import { DatabaseSync } from 'node:sqlite';
import { createHash, timingSafeEqual } from 'node:crypto';
import { chmod, lstat, mkdir, open } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

export const RESOURCE_SCOPES = Object.freeze(['graph:read', 'media:read']);
const OAUTH_SCOPES = [...RESOURCE_SCOPES, 'offline_access'];

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

function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const hash = value => createHash('sha256').update(value).digest();
  return timingSafeEqual(hash(a), hash(b));
}

function setupError(status, message) {
  const error = new Error(message);
  error.status = error.statusCode = status;
  return error;
}

/** Real Better Auth OAuth provider. The caller owns the Node HTTP/Fetch bridge and UI. */
export async function createAuthService({ publicUrl, databasePath, secret, bootstrapToken, ownerEmail } = {}) {
  const origin = canonicalOrigin(publicUrl);
  const issuer = `${origin}/api/auth`;
  const resource = `${origin}/mcp`;
  if (typeof secret !== 'string' || secret.length < 32) throw new Error('A persistent auth secret of at least 32 characters is required');
  if (typeof bootstrapToken !== 'string' || !bootstrapToken.length) throw new Error('A bootstrap token is required');
  if (typeof databasePath !== 'string' || !databasePath.length) throw new Error('A dedicated SQLite databasePath is required');
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
      scopes: OAUTH_SCOPES,
      // Keep offline_access in persisted grant scopes so refreshes keep rotating.
      // MCP protected-resource metadata filters this AS-only scope automatically.
      resources: [{ identifier: resource, allowedScopes: OAUTH_SCOPES }],
      grantTypes: ['authorization_code', 'refresh_token'],
      // Resource-bound JWTs in 1.7.10 cannot be revoked, even via introspection.
      // This official option provides hashed opaque tokens and live revocation.
      disableJwtPlugin: true,
      storeTokens: 'hashed',
      storeClientSecret: 'encrypted',
      accessTokenExpiresIn: 3600,
      refreshTokenExpiresIn: 60 * 60 * 24 * 30,
      refreshTokenReuseInterval: 0,
      clientRegistrationRequirePKCE: true,
      allowDynamicClientRegistration: true,
      allowUnauthenticatedClientRegistration: true,
      clientRegistrationDefaultApplicationType: 'infer',
      clientRegistrationDefaultScopes: OAUTH_SCOPES,
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
      plugins: [jwt({ jwt: { issuer } }), provider, cimd({ fetchClientMetadataResource })],
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
    const replayStore = createDpopReplayStore(context.internalAdapter);
    const endpointContext = request => ({ context, request, headers: request.headers });
    const ownerId = () => database.prepare('SELECT user_id FROM graph_auth_owner WHERE singleton=1').get()?.user_id;
    const ownerSession = async request => {
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

    async function setupOwner(input = {}) {
      if (closed) throw setupError(503, 'Auth service is closed');
      if (!safeEqual(input.bootstrapToken, bootstrapToken)) throw setupError(403, 'Owner setup denied');
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

    async function verify(request, { scopes = [] } = {}) {
      if (closed) return json({ error: 'auth_unavailable' }, 503);
      if (!Array.isArray(scopes) || scopes.some(scope => !RESOURCE_SCOPES.includes(scope))) throw new TypeError('Unknown required resource scope');
      let authorization;
      let claims;
      try {
        authorization = parseAccessTokenAuthorization(request.headers.get('authorization'));
        if (!authorization) return challenge(401, scopes);
        // Local official introspection, not JWT-only verification: reads current DB state.
        claims = await getOAuthProviderApi(endpointContext(request), providerOptions).requireActiveAccessToken(authorization.token);
        const audience = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
        if (claims.iss !== issuer || !audience.includes(resource) || !claims.sub || claims.sub !== ownerId() ||
            typeof claims.exp !== 'number' || claims.exp <= Math.floor(Date.now() / 1000)) return challenge(401, scopes, true);
        await enforceDpopBinding({ payload: claims, authorization, proofJwt: request.headers.get('dpop'), method: request.method, url: request.url, replayStore });
        const consent = await consentFor(claims.sub, claims.client_id);
        const granted = typeof claims.scope === 'string' ? claims.scope.split(/\s+/).filter(Boolean) : [];
        if (!consent || granted.some(scope => !consent.scopes.includes(scope))) return challenge(401, scopes, true);
        if (scopes.some(scope => !granted.includes(scope))) return challenge(403, scopes);
        return { userId: claims.sub, clientId: claims.client_id, scopes: granted, claims };
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
      if (!client || client.disabled || scopes.some(scope => !OAUTH_SCOPES.includes(scope) || !client.scopes?.includes(scope)) ||
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
      handler: request => serialized(() => handler(request)),
      verify: (request, options) => serialized(() => verify(request, options)),
      revokeGrant: (clientId, headers) => serialized(() => revokeGrant(clientId, headers)),
      setupOwner, consentDetails, listGrants,
      publicUrl: origin, issuer, resource,
      getSetupStatus: () => ({ configured: Boolean(ownerId()), setupClaimed: Boolean(database.prepare('SELECT 1 FROM graph_auth_owner WHERE singleton=1').get()) }),
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

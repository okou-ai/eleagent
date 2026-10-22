import { betterAuth, type BetterAuthPlugin } from 'better-auth';
import { APIError, createAuthEndpoint } from 'better-auth/api';
import { setSessionCookie } from 'better-auth/cookies';
import { cimd } from '@better-auth/cimd';
import { fetchClientMetadataResource } from '@better-auth/cimd/node';
import { mcp } from '@better-auth/mcp';
import { getOAuthProviderApi, verifyOAuthQueryParams } from '@better-auth/oauth-provider';
import * as z from 'zod';
import { OWNER_EMAIL, passwordMatches } from './owner.ts';

// Sign-in for the owner and the OAuth authorization server that lets the owner's agents (Okou and other MCP clients)
// read this deployment's memory at /mcp. Built on Better Auth; nobody can sign up.

export const RESOURCE_SCOPES = ['memory:read', 'media:read'] as const;
export type ResourceScope = (typeof RESOURCE_SCOPES)[number];
// offline_access asks for a refresh token, so a connected agent keeps access after the owner's browser session ends.
export const OAUTH_SCOPES: string[] = [...RESOURCE_SCOPES, 'offline_access'];
export const SCOPE_NAMES: Record<string, string> = {
  'memory:read': 'Read your recordings and what Eleagent remembers about them',
  'media:read': 'Download original video clips',
  offline_access: 'Keep access when you are not signed in',
};
export const SESSION_DAYS = 30;
const ACCESS_TOKEN_SECONDS = 3600;
const REFRESH_TOKEN_SECONDS = 90 * 86_400;

// The only Better Auth routes reachable over HTTP. Everything else (sign-up, user and client management, consent
// management, introspection, ...) is 404; this app's own routes call what they need on the server.
const PUBLIC_ROUTES = new Set([
  'GET /api/auth/oauth2/authorize',
  'POST /api/auth/oauth2/token',
  'POST /api/auth/oauth2/register',
  'POST /api/auth/oauth2/revoke',
]);

type AuthContext = Awaited<ReturnType<typeof betterAuth>['$context']>;

async function ownerUser(context: AuthContext) {
  const found = await context.internalAdapter.findUserByEmail(OWNER_EMAIL);
  if (found) return found.user;
  try {
    return await context.internalAdapter.createUser({ email: OWNER_EMAIL, name: 'Owner', emailVerified: true }, { method: 'email-password' });
  } catch (error) {
    // Two first sign-ins at once: the other one created the owner.
    const again = await context.internalAdapter.findUserByEmail(OWNER_EMAIL);
    if (again) return again.user;
    throw error;
  }
}

// Server-only (not in PUBLIC_ROUTES): the sign-in route checks origin and rate limits, then calls this. A signed
// oauth_query in the body makes the OAuth provider continue the authorization that sent the owner to sign in.
const ownerSignIn = () => ({
  id: 'owner-sign-in',
  endpoints: {
    signInOwner: createAuthEndpoint('/sign-in/owner', {
      method: 'POST',
      body: z.object({ password: z.string(), oauth_query: z.string().optional() }),
    }, async (ctx) => {
      if (!passwordMatches(ctx.body.password)) throw new APIError('UNAUTHORIZED', { message: 'Wrong password' });
      const user = await ownerUser(ctx.context);
      const session = await ctx.context.internalAdapter.createSession(user.id);
      await setSessionCookie(ctx, { session, user });
      return ctx.json({ signed_in: true });
    }),
  },
}) satisfies BetterAuthPlugin;

export interface AuthSetup {
  /** This deployment's canonical origin: the OAuth issuer is `${origin}/api/auth`, the MCP resource `${origin}/mcp`. */
  origin: string;
  secret: string;
  /** A node-postgres Pool (or anything Better Auth accepts as a database). */
  database: unknown;
}

export function createAuth({ origin, secret, database }: AuthSetup) {
  const resource = `${origin}/mcp`;
  const provider = mcp({
    resource,
    loginPage: '/login',
    consentPage: '/consent',
    scopes: OAUTH_SCOPES,
    // Opaque tokens, stored hashed: revoking access in /account takes effect on the next request.
    disableJwtPlugin: true,
    storeTokens: 'hashed',
    accessTokenExpiresIn: ACCESS_TOKEN_SECONDS,
    refreshTokenExpiresIn: REFRESH_TOKEN_SECONDS,
    // Clients either publish a Client ID Metadata Document (Okou does) or register themselves; both are public
    // clients with PKCE, and every grant still needs the owner's consent.
    allowDynamicClientRegistration: true,
    allowUnauthenticatedClientRegistration: true,
    clientRegistrationDefaultScopes: OAUTH_SCOPES,
    clientRegistrationAllowedScopes: OAUTH_SCOPES,
    clientRegistrationRequirePKCE: true,
    clientPrivileges: () => false,
    resourcePrivileges: () => false,
  });
  const auth = betterAuth({
    appName: 'Eleagent',
    baseURL: origin,
    basePath: '/api/auth',
    secret,
    database: database as never,
    // A deployment answers on several hosts (production domain, deployment URL); each may sign in for itself.
    trustedOrigins: (request) => [origin, ...(request ? [new URL(request.url).origin] : [])],
    user: { changeEmail: { enabled: false }, deleteUser: { enabled: false } },
    session: { expiresIn: SESSION_DAYS * 86_400, updateAge: 86_400, cookieCache: { enabled: false } },
    rateLimit: { enabled: true, storage: 'database' },
    advanced: { cookiePrefix: 'eleagent' },
    logger: { level: 'error' },
    plugins: [
      provider,
      cimd({ fetchClientMetadataResource, metadataProfile: 'mcp-2026-07-28', originBoundFields: ['post_logout_redirect_uris'] }),
      ownerSignIn(),
    ],
  });
  return Object.assign(auth, { origin, issuer: `${origin}/api/auth`, resource, provider });
}
export type Auth = ReturnType<typeof createAuth>;

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  Response.json(body, { status, headers: { 'Cache-Control': 'no-store', ...headers } });
const oauthError = (error: string, description: string, status = 400) => json({ error, error_description: description }, status);

// HTTP entry for /api/auth/*: public clients with PKCE only, bearer tokens only.
export async function handleAuthRequest(auth: Auth, request: Request): Promise<Response> {
  const url = new URL(request.url);
  if (!PUBLIC_ROUTES.has(`${request.method} ${url.pathname}`)) return json({ error: 'not_found' }, 404);
  if (request.headers.has('dpop') || url.searchParams.has('dpop_jkt')) return oauthError('invalid_request', 'DPoP is not supported');
  if (url.pathname === '/api/auth/oauth2/token') {
    if (/^basic /i.test(request.headers.get('authorization') ?? '')) {
      return oauthError('invalid_client', 'Only public clients (token_endpoint_auth_method "none") are supported', 401);
    }
    const form = new URLSearchParams(await request.clone().text().catch(() => ''));
    if (!['authorization_code', 'refresh_token'].includes(form.get('grant_type') ?? '')) {
      return oauthError('unsupported_grant_type', 'Use authorization_code or refresh_token');
    }
    if (form.has('client_secret') || form.has('client_assertion')) {
      return oauthError('invalid_client', 'Only public clients (token_endpoint_auth_method "none") are supported', 401);
    }
  }
  if (url.pathname === '/api/auth/oauth2/register') {
    let body: unknown;
    try { body = await request.clone().json(); } catch { return oauthError('invalid_client_metadata', 'Registration body must be JSON'); }
    if (!body || typeof body !== 'object' || Array.isArray(body)) return oauthError('invalid_client_metadata', 'Registration body must be a JSON object');
    const metadata = body as Record<string, unknown>;
    if (metadata.token_endpoint_auth_method !== undefined && metadata.token_endpoint_auth_method !== 'none') {
      return oauthError('invalid_client_metadata', 'Only public clients (token_endpoint_auth_method "none") are supported');
    }
    if (metadata.dpop_bound_access_tokens) return oauthError('invalid_client_metadata', 'DPoP is not supported');
    // RFC 7591 defaults to client_secret_basic when the method is omitted; register a public client instead.
    const headers = new Headers(request.headers);
    headers.delete('content-length');
    request = new Request(request.url, { method: 'POST', headers, body: JSON.stringify({ ...metadata, token_endpoint_auth_method: 'none' }) });
  }
  return auth.handler(request);
}

// RFC 8414 metadata, limited to what handleAuthRequest accepts.
export function authorizationServerMetadata(auth: Auth) {
  const { issuer } = auth;
  return {
    issuer,
    authorization_endpoint: `${issuer}/oauth2/authorize`,
    token_endpoint: `${issuer}/oauth2/token`,
    registration_endpoint: `${issuer}/oauth2/register`,
    revocation_endpoint: `${issuer}/oauth2/revoke`,
    scopes_supported: OAUTH_SCOPES,
    response_types_supported: ['code'],
    response_modes_supported: ['query'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    token_endpoint_auth_methods_supported: ['none'],
    revocation_endpoint_auth_methods_supported: ['none'],
    code_challenge_methods_supported: ['S256'],
    authorization_response_iss_parameter_supported: true,
    client_id_metadata_document_supported: true,
  };
}

// RFC 9728 metadata for /mcp.
export function protectedResourceMetadata(auth: Auth) {
  return {
    resource: auth.resource,
    resource_name: 'Eleagent',
    authorization_servers: [auth.issuer],
    bearer_methods_supported: ['header'],
    scopes_supported: OAUTH_SCOPES,
  };
}

export type Access = { ok: true; clientId: string; scopes: string[] } | { ok: false; response: Response };

// Checks a request's bearer token for the MCP resource. Failures carry the RFC 6750/9728 challenge that starts (or
// steps up) a client's authorization.
export async function verifyAccess(auth: Auth, request: Request, required: readonly ResourceScope[] = []): Promise<Access> {
  const challenge = (status: 401 | 403, error?: string): Access => ({
    ok: false,
    response: json({ error: error ?? 'unauthorized' }, status, {
      'WWW-Authenticate': `Bearer resource_metadata="${auth.origin}/.well-known/oauth-protected-resource/mcp"` +
        (error ? `, error="${error}"` : '') + (required.length ? `, scope="${required.join(' ')}"` : ''),
    }),
  });
  const bearer = /^Bearer ([A-Za-z0-9._~+/-]+=*)$/i.exec(request.headers.get('authorization') ?? '');
  if (!bearer) return challenge(401);
  try {
    const context = await auth.$context;
    const api = getOAuthProviderApi({ context, request, headers: request.headers } as never, auth.provider.options);
    const claims = await api.validateAccessToken(bearer[1]);
    const audience = ([] as unknown[]).concat(claims.aud ?? []);
    if (claims.active !== true || !audience.includes(auth.resource) || typeof claims.client_id !== 'string') {
      return challenge(401, 'invalid_token');
    }
    const scopes = String(claims.scope ?? '').split(' ').filter(Boolean);
    if (required.some((scope) => !scopes.includes(scope))) return challenge(403, 'insufficient_scope');
    return { ok: true, clientId: claims.client_id, scopes };
  } catch {
    // No token values or provider errors escape into responses.
    return challenge(401, 'invalid_token');
  }
}

export async function ownerSession(auth: Auth, headers: Headers) {
  const session = await auth.api.getSession({ headers });
  return session?.user.email === OWNER_EMAIL ? session : null;
}

export interface ConsentRequest { clientId: string; clientName: string; clientUri?: string; scopes: string[]; oauthQuery: string }

// What the consent page shows, or null when the signed authorization request is invalid or expired.
export async function consentRequest(auth: Auth, oauthQuery: string): Promise<ConsentRequest | null> {
  const context = await auth.$context;
  if (!(await verifyOAuthQueryParams(oauthQuery, context.secret))) return null;
  const params = new URLSearchParams(oauthQuery);
  const clientId = params.get('client_id');
  const scopes = (params.get('scope') ?? '').split(/\s+/).filter(Boolean);
  if (!clientId || scopes.some((scope) => !OAUTH_SCOPES.includes(scope))) return null;
  const api = getOAuthProviderApi({ context, headers: new Headers() } as never, auth.provider.options);
  const client = await api.getClient(clientId);
  if (!client || client.disabled) return null;
  return { clientId, clientName: client.name || clientId, clientUri: client.uri ?? undefined, scopes, oauthQuery };
}

export interface Grant { clientId: string; clientName: string; scopes: string[]; grantedAt: Date }

export async function listGrants(auth: Auth, userId: string): Promise<Grant[]> {
  const context = await auth.$context;
  const consents = await context.adapter.findMany<{ clientId: string; scopes: string[]; createdAt: Date }>({
    model: 'oauthConsent', where: [{ field: 'userId', value: userId }],
  });
  return Promise.all(consents.map(async (consent) => {
    const client = await context.adapter.findOne<{ name?: string | null }>({
      model: 'oauthClient', where: [{ field: 'clientId', value: consent.clientId }],
    });
    return { clientId: consent.clientId, clientName: client?.name || consent.clientId, scopes: consent.scopes, grantedAt: consent.createdAt };
  }));
}

// Ends a client's access completely: its consent, every access and refresh token, and any authorization code it has
// not exchanged yet. Deleting the consent alone would leave issued tokens working.
export async function revokeGrant(auth: Auth, userId: string, clientId: string): Promise<void> {
  const context = await auth.$context;
  const where = [{ field: 'userId', value: userId }, { field: 'clientId', value: clientId }];
  await context.adapter.deleteMany({ model: 'oauthConsent', where });
  await context.adapter.deleteMany({ model: 'oauthRefreshToken', where });
  await context.adapter.deleteMany({ model: 'oauthAccessToken', where });
  await context.adapter.deleteMany({
    model: 'verification',
    where: [
      { field: 'value', operator: 'contains', value: '"type":"authorization_code"' },
      { field: 'value', operator: 'contains', value: JSON.stringify({ client_id: clientId }).slice(1, -1) },
    ],
  });
}

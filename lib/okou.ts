import { createHash, randomBytes } from 'node:crypto';

// Eleagent as a client of Okou's MCP server (https://api.okou.ai/mcp), so that requests the owner speaks to Okou
// while recording reach it. Eleagent identifies itself with a Client ID Metadata Document it publishes at
// /okou/client.json (Okou's authorization server supports these and has dynamic registration switched off). The
// owner approves once in the browser (authorization code + PKCE, offline_access); tokens are kept by `store`.

export const OKOU_MCP = 'https://api.okou.ai/mcp';
const PENDING_MS = 10 * 60_000;
// Only what handing over requests needs: the owner's Okou organization (Okou's MCP accepts only tokens that name one,
// and the token names it only with user:org:read), read and send chat messages, and stay connected.
const WANTED_SCOPES = ['user:org:read', 'okou:chat:read', 'okou:chat:send', 'offline_access'];
const REFRESH_EARLY_MS = 2 * 60_000;

export interface OkouStore {
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown | null): Promise<void>;
}
interface Tokens { access_token: string; refresh_token: string | null; scope: string | null; expires_at: number }
interface Server { issuer: string; scopes: string[]; authorize: string; token: string }

const b64url = (buffer: Buffer) => buffer.toString('base64url');

export function clientMetadata(origin: string) {
  return {
    client_id: `${origin}/okou/client.json`, client_name: 'Eleagent', client_uri: `${origin}/`,
    redirect_uris: [`${origin}/api/okou/callback`], grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'], token_endpoint_auth_method: 'none',
  };
}

export function okouConnection({ origin, store, resource = OKOU_MCP, fetchImpl = fetch, now = Date.now }: {
  origin: string; store: OkouStore; resource?: string; fetchImpl?: typeof fetch; now?: () => number;
}) {
  const client = clientMetadata(origin);
  const callback = client.redirect_uris[0];

  async function json(url: string, init?: RequestInit) {
    const response = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(15_000) });
    const text = await response.text();
    let body: Record<string, unknown> = {};
    try { body = text ? JSON.parse(text) : {}; } catch { /* not JSON */ }
    if (!response.ok) {
      const reason = body.error_description ?? body.error ?? '';
      throw new Error(`${new URL(url).host}${new URL(url).pathname} HTTP ${response.status}${reason ? `: ${reason}` : ''}`);
    }
    return body;
  }

  // The MCP authorization spec: the resource's protected-resource metadata names the server, then its metadata.
  async function discover(): Promise<Server> {
    const prm = await json(new URL(`/.well-known/oauth-protected-resource${new URL(resource).pathname}`, resource).href);
    const issuer = (prm.authorization_servers as string[] | undefined)?.[0];
    if (!issuer) throw new Error('Okou names no authorization server');
    let as: Record<string, unknown>;
    try { as = await json(new URL('/.well-known/oauth-authorization-server', issuer).href); } catch {
      as = await json(new URL('/.well-known/openid-configuration', issuer).href);
    }
    if (as.client_id_metadata_document_supported !== true) throw new Error('Okou does not accept client ID metadata documents');
    return { issuer, scopes: (prm.scopes_supported ?? as.scopes_supported ?? []) as string[],
      authorize: String(as.authorization_endpoint), token: String(as.token_endpoint) };
  }

  const tokenRequest = (server: Server, params: Record<string, string>) => json(server.token, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams({ ...params, client_id: client.client_id, resource }),
  });
  const keep = (tokens: Record<string, unknown>, previous?: Tokens): Tokens => ({
    access_token: String(tokens.access_token), refresh_token: (tokens.refresh_token as string) ?? previous?.refresh_token ?? null,
    scope: (tokens.scope as string) ?? previous?.scope ?? null, expires_at: now() + 1000 * Number(tokens.expires_in ?? 3600),
  });

  return {
    // Where to send the owner to approve; the PKCE verifier (and where to return) waits in the store for the callback.
    async start(returnTo = '/account'): Promise<string> {
      const server = await discover();
      const state = b64url(randomBytes(24)), verifier = b64url(randomBytes(48));
      await store.set('okou_pending', { state, verifier, at: now(), returnTo });
      const url = new URL(server.authorize);
      url.search = new URLSearchParams({ response_type: 'code', client_id: client.client_id, redirect_uri: callback,
        scope: (server.scopes.some((scope) => WANTED_SCOPES.includes(scope)) ? server.scopes.filter((scope) => WANTED_SCOPES.includes(scope))
          : server.scopes).join(' '), state, code_challenge: b64url(createHash('sha256').update(verifier).digest()),
        code_challenge_method: 'S256', resource, prompt: 'consent' }).toString();
      return url.href;
    },
    // Completes the approval; returns the page the owner started from.
    async finish(params: URLSearchParams): Promise<string> {
      const pending = await store.get('okou_pending') as { state: string; verifier: string; at: number; returnTo?: string } | null;
      await store.set('okou_pending', null);
      if (!pending || pending.state !== params.get('state') || now() - pending.at > PENDING_MS) throw new Error('This approval expired; connect again');
      if (params.get('error')) throw new Error(`Okou did not approve: ${params.get('error')}`);
      const server = await discover();
      const tokens = await tokenRequest(server, { grant_type: 'authorization_code', code: params.get('code') ?? '',
        redirect_uri: callback, code_verifier: pending.verifier });
      await store.set('okou_tokens', keep(tokens));
      await store.set('okou_connected_at', new Date(now()).toISOString());
      return pending.returnTo ?? '/account';
    },
    // A current access token, refreshed shortly before it expires; null when not connected.
    async accessToken(): Promise<string | null> {
      const tokens = await store.get('okou_tokens') as Tokens | null;
      if (!tokens?.access_token) return null;
      if (tokens.expires_at - now() > REFRESH_EARLY_MS) return tokens.access_token;
      if (!tokens.refresh_token) return null;
      const server = await discover();
      const kept = keep(await tokenRequest(server, { grant_type: 'refresh_token', refresh_token: tokens.refresh_token }), tokens);
      await store.set('okou_tokens', kept);
      return kept.access_token;
    },
    async status() {
      const tokens = await store.get('okou_tokens') as Tokens | null;
      return { connected: Boolean(tokens?.access_token), since: (await store.get('okou_connected_at')) as string | null };
    },
    async disconnect() {
      for (const key of ['okou_tokens', 'okou_connected_at', 'okou_thread']) await store.set(key, null);
    },
  };
}
export type OkouConnection = ReturnType<typeof okouConnection>;

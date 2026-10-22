import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { applyMigrations } from '../db/apply.mjs';
import { considerHandoff, type HandoffDeps } from '../lib/handoff.ts';
import { okouConnection, type OkouStore } from '../lib/okou.ts';
import { startPostgres } from './postgres.ts';

// Handing spoken requests to Okou, with stand-ins for Okou (its OAuth endpoints and MCP tools) and for the model.
// Synthetic data only.

const ORIGIN = 'https://eleagent.example';
const CAPTURE = 'web-0b5f3a2e-8d1c-4e7a-9f20-3c4d5e6f7a8b-back';

function memoryStore(): OkouStore & { data: Map<string, unknown> } {
  const data = new Map<string, unknown>();
  return { data, get: async (key) => data.get(key) ?? null, set: async (key, value) => { if (value === null) data.delete(key); else data.set(key, value); } };
}

function fakeOkou() {
  const tokenRequests: URLSearchParams[] = [];
  let issued = 0;
  const fetchImpl = (async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const json = (body: object, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
    if (url.href === 'https://api.okou.ai/.well-known/oauth-protected-resource/mcp') {
      return json({ resource: 'https://api.okou.ai/mcp', authorization_servers: ['https://clerk.okou.example'], scopes_supported: ['openid', 'okou:chat:read', 'okou:chat:send', 'okou:chat:manage', 'offline_access'] });
    }
    if (url.href === 'https://clerk.okou.example/.well-known/oauth-authorization-server') {
      return json({ issuer: 'https://clerk.okou.example', authorization_endpoint: 'https://clerk.okou.example/oauth/authorize',
        token_endpoint: 'https://clerk.okou.example/oauth/token', client_id_metadata_document_supported: true });
    }
    if (url.href === 'https://clerk.okou.example/oauth/token') {
      const form = new URLSearchParams(String(init?.body));
      tokenRequests.push(form);
      issued += 1;
      return json({ access_token: `access-${issued}`, refresh_token: `refresh-${issued}`, expires_in: 3600, scope: 'okou:chat:send' });
    }
    return json({ error: 'not_found' }, 404);
  }) as typeof fetch;
  return { fetchImpl, tokenRequests };
}

test('connecting Okou: PKCE with a client ID metadata document, tokens kept, refreshed before they expire', async () => {
  const okou = fakeOkou(), store = memoryStore();
  let clock = Date.parse('2026-10-22T09:00:00Z');
  const connection = okouConnection({ origin: ORIGIN, store, fetchImpl: okou.fetchImpl, now: () => clock });
  const authorize = new URL(await connection.start());
  assert.equal(authorize.origin + authorize.pathname, 'https://clerk.okou.example/oauth/authorize');
  assert.equal(authorize.searchParams.get('client_id'), `${ORIGIN}/okou/client.json`);
  assert.equal(authorize.searchParams.get('redirect_uri'), `${ORIGIN}/api/okou/callback`);
  assert.equal(authorize.searchParams.get('resource'), 'https://api.okou.ai/mcp');
  assert.equal(authorize.searchParams.get('scope'), 'okou:chat:read okou:chat:send offline_access');
  assert.equal(authorize.searchParams.get('code_challenge_method'), 'S256');

  await assert.rejects(connection.finish(new URLSearchParams({ state: 'forged', code: 'c' })), /expired/);
  assert.equal(await connection.accessToken(), null, 'a forged callback connects nothing');

  const restarted = new URL(await connection.start());
  const { verifier } = store.data.get('okou_pending') as { verifier: string };
  assert.equal(restarted.searchParams.get('code_challenge'), createHash('sha256').update(verifier).digest('base64url'));
  await connection.finish(new URLSearchParams({ state: restarted.searchParams.get('state')!, code: 'code-1' }));
  const exchange = okou.tokenRequests[0];
  assert.deepEqual([exchange.get('grant_type'), exchange.get('code'), exchange.get('code_verifier'), exchange.get('client_id')],
    ['authorization_code', 'code-1', verifier, `${ORIGIN}/okou/client.json`]);
  assert.equal(await connection.accessToken(), 'access-1');
  assert.equal((await connection.status()).connected, true);

  clock += 59 * 60_000;
  assert.equal(await connection.accessToken(), 'access-2', 'refreshed two minutes before expiry');
  assert.deepEqual([okou.tokenRequests[1].get('grant_type'), okou.tokenRequests[1].get('refresh_token')], ['refresh_token', 'refresh-1']);
  await connection.disconnect();
  assert.equal(await connection.accessToken(), null);
});

let postgres: Awaited<ReturnType<typeof startPostgres>>;
const query = (text: string, params: unknown[]) => postgres.pool.query(text, params).then((result) => result.rows);
const calls: { tool: string; args: Record<string, unknown> }[] = [];
const prompts: string[] = [];
let verdict: Record<string, unknown> = {};
let token: string | null = 'okou-token';
let sendFails = false;
const deps: HandoffDeps = {
  query, timeZone: async () => 'Asia/Shanghai', okouToken: async () => token,
  complete: async (_system, user) => { prompts.push(user); return { cost: 0, json: verdict }; },
  callOkou: async (_token, tool, args) => {
    calls.push({ tool, args });
    if (tool === 'list_agents') return [{ id: 'agent-ops', name: 'Ops' }, { id: 'agent-okou', name: 'Okou' }];
    if (sendFails) throw new Error('Okou is unavailable');
    return { threadId: 'thread-1', eventId: `event-${calls.length}` };
  },
};

async function addMinute(minute: string, text: string) {
  await query(`INSERT INTO captures (id, camera, first_clip_at, last_clip_at) VALUES ($1, 'back', $2, $2) ON CONFLICT (id) DO NOTHING`, [CAPTURE, minute]);
  await query(`INSERT INTO observations (capture_id, minute, status, summary, transcript) VALUES ($1, $2::timestamptz, 'done', 'At a desk.', $3)`,
    [CAPTURE, minute, JSON.stringify(text ? [{ start: new Date(Date.parse(minute) + 3000).toISOString(), end: minute, speaker: 'speaker_0', text }] : [])]);
}

before(async () => {
  postgres = await startPostgres();
  const client = await postgres.pool.connect();
  try { await applyMigrations(client); } finally { client.release(); }
  await addMinute('2026-10-22T01:00:00Z', 'Okou，帮我查一下这个眼药水是什么牌子');
  await addMinute('2026-10-22T01:01:00Z', '欧扣，再提醒我明天下午买一瓶');
  await addMinute('2026-10-22T01:02:00Z', '你先弄个 PR 吧');
  await addMinute('2026-10-22T01:03:00Z', '');
});
after(async () => { await postgres?.stop(); });

test('a request spoken to Okou is handed over once, into one standing conversation', async () => {
  verdict = { for: 'Okou', confidence: 0.92, quote: '帮我查一下这个眼药水是什么牌子', message: '帮我查一下眼药水的牌子：瓶子是白色的。', screen: '已交给 Okou：查眼药水牌子' };
  assert.equal(await considerHandoff(deps, CAPTURE, '2026-10-22T01:00:00.000Z'), 'sent');
  assert.deepEqual(calls.map((call) => call.tool), ['list_agents', 'send_chat_message']);
  const sent = calls[1].args;
  assert.equal(sent.agentId, 'agent-okou');
  assert.equal(sent.threadId, undefined, 'the first request starts the conversation');
  assert.match(String(sent.prompt), /^帮我查一下眼药水的牌子：瓶子是白色的。\n\n— Eleagent heard this at 09:00 \(Asia\/Shanghai\) in recording web-/);
  assert.match(prompts[0], /## Newest minute \(09:00\)\n\[09:00\] speaker_0: Okou，帮我查一下这个眼药水是什么牌子/);
  const [row] = await query('SELECT status, okou_thread_id, screen FROM handoffs', []);
  assert.deepEqual(row, { status: 'sent', okou_thread_id: 'thread-1', screen: '已交给 Okou：查眼药水牌子' });

  assert.equal(await considerHandoff(deps, CAPTURE, '2026-10-22T01:00:00.000Z'), 'already_handled', 'reprocessing a minute never resends');
  calls.length = 0;
  verdict = { ...verdict, quote: '再提醒我明天下午买一瓶', message: '明天下午提醒我买一瓶眼药水。' };
  assert.equal(await considerHandoff(deps, CAPTURE, '2026-10-22T01:01:00.000Z'), 'sent');
  assert.deepEqual(calls.map((call) => call.tool), ['send_chat_message'], 'the agent and conversation are remembered');
  assert.equal(calls[0].args.threadId, 'thread-1');
  assert.match(prompts.at(-1)!, /Already handed to Okou during this recording:\n- 帮我查一下这个眼药水是什么牌子/);
});

test('talk that is not for Okou, silence, a missing connection and a failed send are handled quietly', async () => {
  calls.length = 0;
  verdict = { for: 'people present', confidence: 0.95, quote: null, message: null };
  assert.equal(await considerHandoff(deps, CAPTURE, '2026-10-22T01:02:00.000Z'), 'nothing_for_okou');
  verdict = { for: 'Okou', confidence: 0.5, quote: 'x', message: 'x' };
  assert.equal(await considerHandoff(deps, CAPTURE, '2026-10-22T01:02:00.000Z'), 'nothing_for_okou', 'not sure enough');
  const asked = prompts.length;
  assert.equal(await considerHandoff(deps, CAPTURE, '2026-10-22T01:03:00.000Z'), 'no_speech');
  assert.equal(prompts.length, asked, 'no model call without speech');
  token = null;
  assert.equal(await considerHandoff(deps, CAPTURE, '2026-10-22T01:02:00.000Z'), 'not_connected');
  token = 'okou-token';
  assert.deepEqual(calls, []);

  sendFails = true;
  verdict = { for: 'Okou', confidence: 0.9, quote: '你先弄个 PR 吧', message: '开一个 PR。' };
  assert.equal(await considerHandoff(deps, CAPTURE, '2026-10-22T01:02:00.000Z'), 'failed');
  const [row] = await query(`SELECT status, error FROM handoffs WHERE minute = '2026-10-22T01:02:00Z'`, []);
  assert.deepEqual(row, { status: 'failed', error: 'Okou is unavailable' });
  sendFails = false;
  assert.equal(await considerHandoff(deps, CAPTURE, '2026-10-22T01:02:00.000Z'), 'already_handled', 'a failed send is not retried blindly');
});

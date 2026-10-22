import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { appOrigin, authSecret } from './auth-server';
import { sql } from './db';
import { considerHandoff, type HandoffDeps } from './handoff';
import { OKOU_MCP, okouConnection, type OkouStore } from './okou';
import { completeJson } from './openrouter';
import { SLEEP_MODEL } from './sleep';
import { ownerTimeZone } from './sleep-server';

// Okou's tokens are kept in app_settings, encrypted with a key derived from the auth secret.
async function key() {
  return createHash('sha256').update(`eleagent okou\u0000${await authSecret()}`).digest();
}
const store: OkouStore = {
  async get(name) {
    const [row] = await sql()`SELECT value FROM app_settings WHERE key = ${name}`;
    if (!row) return null;
    const value = String(row.value);
    if (!value.startsWith('v1.')) return JSON.parse(value);
    const [, iv, tag, data] = value.split('.');
    const decipher = createDecipheriv('aes-256-gcm', await key(), Buffer.from(iv, 'base64url'));
    decipher.setAuthTag(Buffer.from(tag, 'base64url'));
    return JSON.parse(Buffer.concat([decipher.update(Buffer.from(data, 'base64url')), decipher.final()]).toString('utf8'));
  },
  async set(name, value) {
    if (value === null) {
      await sql()`DELETE FROM app_settings WHERE key = ${name}`;
      return;
    }
    let stored = JSON.stringify(value);
    if (name === 'okou_tokens' || name === 'okou_pending') {
      const iv = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', await key(), iv);
      const data = Buffer.concat([cipher.update(stored, 'utf8'), cipher.final()]);
      stored = ['v1', iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), data.toString('base64url')].join('.');
    }
    await sql()`INSERT INTO app_settings (key, value) VALUES (${name}, ${stored}) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`;
  },
};

export const okou = () => okouConnection({ origin: appOrigin(), store, resource: process.env.OKOU_MCP_URL || OKOU_MCP });

// One tool call on Okou's MCP server; returns its structured result (or its JSON text).
export async function callOkou(token: string, tool: string, args: Record<string, unknown>): Promise<unknown> {
  const client = new Client({ name: 'eleagent', version: '0.1.0' });
  const transport = new StreamableHTTPClientTransport(new URL(process.env.OKOU_MCP_URL || OKOU_MCP),
    { requestInit: { headers: { Authorization: `Bearer ${token}` } } });
  await client.connect(transport);
  try {
    const result = await client.callTool({ name: tool, arguments: args });
    const text = (result.content as { type: string; text?: string }[] | undefined)?.find((item) => item.type === 'text')?.text ?? '';
    if (result.isError) throw new Error(`Okou ${tool}: ${text.slice(0, 300)}`);
    if (result.structuredContent) return result.structuredContent;
    try { return JSON.parse(text); } catch { return text; }
  } finally {
    await client.close().catch(() => {});
  }
}

export function handoffDeps(): HandoffDeps {
  const connection = okou();
  return {
    query: sql().query, timeZone: ownerTimeZone, okouToken: () => connection.accessToken(), callOkou,
    complete: (system, user, maxTokens) => completeJson(SLEEP_MODEL, system, user, maxTokens),
    agentId: process.env.OKOU_AGENT_ID || undefined,
  };
}

export const handOffMinute = (captureId: string, minute: string) => considerHandoff(handoffDeps(), captureId, minute);

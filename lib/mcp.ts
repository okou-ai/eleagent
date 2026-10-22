import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { z } from 'zod/v3';
import type { ResourceScope } from './auth.ts';

// The MCP server agents use to read this deployment's memory. Today that is the recordings themselves; what Eleagent
// hears, sees and consolidates will be added as tools here as those parts land.

type Row = Record<string, unknown>;
export type Query = (text: string, params: unknown[]) => Promise<Row[]>;
export type SignDownload = (pathname: string) => Promise<{ url: string; expiresAt: Date }>;

const iso = (value: unknown) => (value == null ? null : new Date(value as string).toISOString());
const time = z.string().datetime({ offset: true });
const annotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };

export class ToolError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

// Reads over the capture tables; every query is parameterised and bounded.
export function memoryStore(query: Query, signDownload: SignDownload) {
  const clip = (row: Row) => ({
    media_id: row.media_id, capture_id: row.capture_id, clip_seq: row.clip_seq, captured_at: iso(row.captured_at),
    captured_end_at: iso(row.captured_end_at), content_type: row.content_type, size_bytes: row.size_bytes,
    locations: (row.meta as { locations?: unknown[] } | null)?.locations ?? [],
  });
  return {
    async listCaptures(args: { started_at?: string; ended_at?: string; limit: number }) {
      const rows = await query(`SELECT c.id, c.camera, c.first_clip_at, c.last_clip_at, count(k.media_id)::int AS clips
        FROM captures c LEFT JOIN clips k ON k.capture_id = c.id
        WHERE ($1::timestamptz IS NULL OR c.last_clip_at >= $1) AND ($2::timestamptz IS NULL OR c.first_clip_at <= $2)
        GROUP BY c.id ORDER BY c.first_clip_at DESC LIMIT $3`, [args.started_at ?? null, args.ended_at ?? null, args.limit]);
      return rows.map((row) => ({ capture_id: row.id, camera: row.camera, started_at: iso(row.first_clip_at),
        last_clip_at: iso(row.last_clip_at), clips: row.clips }));
    },
    async listClips(args: { capture_id?: string; started_at?: string; ended_at?: string; limit: number; offset: number }) {
      const rows = await query(`SELECT media_id, capture_id, clip_seq, captured_at, captured_end_at, content_type, size_bytes, meta
        FROM clips WHERE ($1::text IS NULL OR capture_id = $1)
          AND ($2::timestamptz IS NULL OR coalesce(captured_end_at, captured_at) >= $2) AND ($3::timestamptz IS NULL OR captured_at <= $3)
        ORDER BY captured_at, capture_id, clip_seq LIMIT $4 OFFSET $5`,
      [args.capture_id ?? null, args.started_at ?? null, args.ended_at ?? null, args.limit + 1, args.offset]);
      return { clips: rows.slice(0, args.limit).map(clip), more: rows.length > args.limit };
    },
    async getClip(mediaId: string) {
      const [row] = await query(`SELECT media_id, capture_id, clip_seq, captured_at, captured_end_at, content_type, size_bytes, meta, pathname
        FROM clips WHERE media_id = $1`, [mediaId]);
      if (!row) throw new ToolError('not_found', 'No clip has this media_id');
      const download = await signDownload(String(row.pathname));
      return { ...clip(row), download_url: download.url, download_expires_at: download.expiresAt.toISOString() };
    },
  };
}
export type MemoryStore = ReturnType<typeof memoryStore>;

function buildServer(store: MemoryStore, scopes: readonly string[]) {
  const server = new McpServer({ name: 'eleagent', version: '0.1.0' }, {
    instructions: 'Read-only access to the owner\'s Eleagent recordings: captures (continuous recordings from one phone ' +
      'camera) made of 5-second video clips with sound and location. Times are RFC 3339. Download URLs expire after ' +
      'a few minutes and need no credentials; never pass access tokens in URLs.',
  });
  const tools: [string, string, ResourceScope, z.ZodRawShape, (args: never) => Promise<unknown>][] = [
    ['list_captures', 'List recordings, newest first. Each capture is one continuous recording from the front or back camera. ' +
      'started_at/ended_at keep captures overlapping that window.', 'memory:read', {
      started_at: time.optional(), ended_at: time.optional(), limit: z.number().int().min(1).max(100).default(20),
    }, (args: Parameters<MemoryStore['listCaptures']>[0]) => store.listCaptures(args).then((captures) => ({ captures }))],
    ['list_clips', 'List 5-second clips in time order, by capture_id and/or a time window, with any location fixes. ' +
      'When `more` is true, call again with offset increased by limit.', 'memory:read', {
      capture_id: z.string().regex(/^web-[0-9a-f-]{36}-(front|back)$/).optional(), started_at: time.optional(),
      ended_at: time.optional(), limit: z.number().int().min(1).max(200).default(50), offset: z.number().int().min(0).max(100_000).default(0),
    }, (args: Parameters<MemoryStore['listClips']>[0]) => store.listClips(args)],
    ['get_clip', 'Get one clip by media_id, with a short-lived URL to download the original video.', 'media:read', {
      media_id: z.string().regex(/^media_[0-9a-f]{32}$/),
    }, ({ media_id }: { media_id: string }) => store.getClip(media_id)],
  ];
  for (const [name, description, scope, shape, run] of tools) {
    server.registerTool(name, { description, inputSchema: z.object(shape).strict(), annotations }, async (args) => {
      try {
        if (!scopes.includes(scope)) throw new ToolError('insufficient_scope', `This tool needs the ${scope} scope; reconnect and allow it`);
        const result = await run(args as never) as Row;
        return { content: [{ type: 'text' as const, text: JSON.stringify(result) }], structuredContent: result };
      } catch (error) {
        const result = { error: error instanceof ToolError ? { code: error.code, message: error.message }
          : { code: 'unavailable', message: 'The read could not be completed' } };
        return { isError: true, content: [{ type: 'text' as const, text: JSON.stringify(result) }], structuredContent: result };
      }
    });
  }
  return server;
}

// Stateless Streamable HTTP: a fresh server per request, JSON responses, no sessions or server-initiated streams.
export async function handleMcp(request: Request, store: MemoryStore, scopes: readonly string[]): Promise<Response> {
  if (request.method !== 'POST') {
    return Response.json({ jsonrpc: '2.0', id: null, error: { code: -32000, message: 'Use POST' } }, { status: 405, headers: { Allow: 'POST' } });
  }
  const server = buildServer(store, scopes);
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  await server.connect(transport);
  return transport.handleRequest(request);
}

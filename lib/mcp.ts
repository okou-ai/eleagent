import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { z } from 'zod/v3';
import type { ResourceScope } from './auth.ts';
import { MAX_FRAMES } from './frames.ts';

// The MCP server agents use to read this deployment's memory. Today that is the recordings themselves; what Eleagent
// hears, sees and consolidates will be added as tools here as those parts land. Tool names follow the self-hosted
// Eleagent's, so agents and workflows that used it keep working.

type Row = Record<string, unknown>;
export type Query = (text: string, params: unknown[]) => Promise<Row[]>;
export type SignDownload = (pathname: string) => Promise<{ url: string; expiresAt: Date }>;
export type ExtractFrames = (url: string, offsets: number[], size: number) => Promise<Buffer[]>;
// A tool result that is MCP content itself (images), not JSON to wrap.
const CONTENT = Symbol('mcp content');
// The video track can end a little before a clip's nominal end.
const END_MARGIN_SECONDS = 0.25;

const iso = (value: unknown) => (value == null ? null : new Date(value as string).toISOString());
const time = z.string().datetime({ offset: true });
const mediaId = z.string().regex(/^media_[0-9a-f]{32}$/);
const captureId = z.string().regex(/^web-[0-9a-f-]{36}-(front|back)$/);
const annotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };

export class ToolError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

function observation(row: Row) {
  const base = { capture_id: row.capture_id, minute: iso(row.minute), status: row.status };
  if (row.status === 'failed') return { ...base, note: 'Processing failed; it is retried automatically' };
  if (row.status !== 'done') return { ...base, note: 'Not processed yet; it is usually ready a minute or two after recording' };
  const perception = (row.perception ?? {}) as Row;
  return { ...base, started_at: iso(row.started_at), ended_at: iso(row.ended_at), summary: row.summary,
    place: perception.place, activity: perception.activity, location: row.location ?? null, perception, transcript: row.transcript ?? [] };
}

// Reads over the capture tables; every query is parameterised and bounded.
export function memoryStore(query: Query, signDownload: SignDownload, extractFrames: ExtractFrames) {
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
    // What was heard and seen, minute by minute (lib/perception.ts). Minutes not processed yet say so.
    async listObservations(args: { capture_id?: string; started_at?: string; ended_at?: string; limit: number }) {
      const rows = await query(`SELECT capture_id, minute, status, started_at, ended_at, summary, perception, transcript,
        (SELECT k.meta->'locations'->-1 FROM clips k WHERE k.capture_id = o.capture_id AND k.captured_at >= o.minute
          AND k.captured_at < o.minute + interval '1 minute' AND jsonb_array_length(k.meta->'locations') > 0
          ORDER BY k.captured_at DESC LIMIT 1) AS location
        FROM observations o WHERE ($1::text IS NULL OR capture_id = $1)
          AND ($2::timestamptz IS NULL OR minute + interval '1 minute' > $2) AND ($3::timestamptz IS NULL OR minute <= $3)
        ORDER BY minute, capture_id LIMIT $4`, [args.capture_id ?? null, args.started_at ?? null, args.ended_at ?? null, args.limit]);
      return { observations: rows.map(observation) };
    },
    async searchObservations(args: { query: string; started_at?: string; ended_at?: string; limit: number }) {
      const terms = args.query.split(/\s+/).filter(Boolean).slice(0, 8);
      if (!terms.length) throw new ToolError('invalid_request', 'Give at least one word to search for');
      const like = terms.map((_, index) => `search_text ILIKE $${index + 4}`).join(' AND ');
      const rows = await query(`SELECT capture_id, minute, status, started_at, ended_at, summary, perception, transcript,
        (SELECT k.meta->'locations'->-1 FROM clips k WHERE k.capture_id = o.capture_id AND k.captured_at >= o.minute
          AND k.captured_at < o.minute + interval '1 minute' AND jsonb_array_length(k.meta->'locations') > 0
          ORDER BY k.captured_at DESC LIMIT 1) AS location
        FROM observations o WHERE status = 'done' AND ${like}
          AND ($1::timestamptz IS NULL OR minute + interval '1 minute' > $1) AND ($2::timestamptz IS NULL OR minute <= $2)
        ORDER BY minute DESC LIMIT $3`,
      [args.started_at ?? null, args.ended_at ?? null, args.limit, ...terms.map((term) => `%${term.replace(/[\\%_]/g, '\\$&')}%`)]);
      const matches = (text: unknown) => terms.some((term) => String(text).toLowerCase().includes(term.toLowerCase()));
      return { observations: rows.map((row) => {
        const { transcript, ...rest } = observation(row) as Row & { transcript?: { text: string }[] };
        return { ...rest, perception: undefined, matching_speech: (transcript ?? []).filter((turn) => matches(turn.text)) };
      }) };
    },
    // Stills by media_id + offsets within that clip, or by capture_id + absolute times; each clip is fetched once.
    async frames(args: { media_id?: string; offsets?: number[]; capture_id?: string; at?: string[]; size: number }) {
      const byClip = args.media_id !== undefined && args.offsets !== undefined && args.capture_id === undefined && args.at === undefined;
      const byTime = args.capture_id !== undefined && args.at !== undefined && args.media_id === undefined && args.offsets === undefined;
      if (!byClip && !byTime) throw new ToolError('invalid_request', 'Give media_id with offsets, or capture_id with at');
      const columns = 'media_id, capture_id, captured_at, captured_end_at, pathname';
      const wanted: { row: Row; offset: number; at: string }[] = [];
      if (byClip) {
        const [row] = await query(`SELECT ${columns} FROM clips WHERE media_id = $1`, [args.media_id]);
        if (!row) throw new ToolError('not_found', 'No clip has this media_id');
        for (const offset of args.offsets!) {
          wanted.push({ row, offset, at: new Date(Date.parse(iso(row.captured_at)!) + offset * 1000).toISOString() });
        }
      } else {
        for (const at of args.at!) {
          const [row] = await query(`SELECT ${columns} FROM clips WHERE capture_id = $1 AND captured_at <= $2
            ORDER BY captured_at DESC LIMIT 1`, [args.capture_id, at]);
          const start = row ? Date.parse(iso(row.captured_at)!) : NaN;
          const end = row?.captured_end_at ? Date.parse(iso(row.captured_end_at)!) : start + 5000;
          if (!row || Date.parse(at) > end + 1000) throw new ToolError('not_found', `No clip of this capture covers ${at}`);
          wanted.push({ row, offset: (Date.parse(at) - start) / 1000, at: new Date(at).toISOString() });
        }
      }
      const frames: { media_id: unknown; capture_id: unknown; at: string; offset: number; jpeg: Buffer }[] = [];
      for (const mediaId of new Set(wanted.map((item) => item.row.media_id))) {
        const items = wanted.filter((item) => item.row.media_id === mediaId);
        const { row } = items[0];
        const length = row.captured_end_at ? (Date.parse(iso(row.captured_end_at)!) - Date.parse(iso(row.captured_at)!)) / 1000 : 5;
        const offsets = items.map((item) => Math.min(Math.max(0, item.offset), Math.max(0, length - END_MARGIN_SECONDS)));
        const { url } = await signDownload(String(row.pathname));
        const jpegs = await extractFrames(url, offsets, args.size).catch(() => {
          throw new ToolError('frames_unavailable', 'Frames could not be decoded from this clip');
        });
        items.forEach((item, index) => frames.push({ media_id: mediaId, capture_id: row.capture_id, at: item.at,
          offset: Number(offsets[index].toFixed(3)), jpeg: jpegs[index] }));
      }
      const listed = frames.map(({ jpeg, ...frame }) => frame); // eslint-disable-line @typescript-eslint/no-unused-vars
      return { [CONTENT]: {
        content: [{ type: 'text' as const, text: JSON.stringify({ frames: listed }) },
          ...frames.map((frame) => ({ type: 'image' as const, data: frame.jpeg.toString('base64'), mimeType: 'image/jpeg' }))],
        structuredContent: { frames: listed },
      } };
    },
  };
}
export type MemoryStore = ReturnType<typeof memoryStore>;

function buildServer(store: MemoryStore, scopes: readonly string[]) {
  const server = new McpServer({ name: 'eleagent', version: '0.1.0' }, {
    instructions: 'Read-only access to the owner\'s Eleagent recordings: captures (continuous recordings from one phone ' +
      'camera) made of 5-second video clips with sound and location, and observations of what was heard and seen in ' +
      'each minute. Observations are model interpretations: check important details against get_video_frames. Times ' +
      'are RFC 3339. Download URLs expire after a few minutes and need no credentials; never pass access tokens in URLs.',
  });
  const tools: [string, string, ResourceScope, z.ZodRawShape, (args: never) => Promise<unknown>][] = [
    ['list_captures', 'List recordings, newest first. Each capture is one continuous recording from the front or back camera. ' +
      'started_at/ended_at keep captures overlapping that window.', 'memory:read', {
      started_at: time.optional(), ended_at: time.optional(), limit: z.number().int().min(1).max(100).default(20),
    }, (args: Parameters<MemoryStore['listCaptures']>[0]) => store.listCaptures(args).then((captures) => ({ captures }))],
    ['list_observations', 'What Eleagent heard and saw, minute by minute, in time order: a summary, the place and activity, ' +
      'people, objects, visible text and sounds, the speech by speaker (labels are anonymous and only consistent ' +
      'within one minute), and the phone\'s last location fix (latitude, longitude, accuracy) in that minute. Filter by ' +
      'capture_id and/or a time window.', 'memory:read', {
      capture_id: captureId.optional(), started_at: time.optional(), ended_at: time.optional(),
      limit: z.number().int().min(1).max(60).default(30),
    }, (args: Parameters<MemoryStore['listObservations']>[0]) => store.listObservations(args)],
    ['search_observations', 'Find minutes whose speech or scene mention all the given words (case-insensitive), newest ' +
      'first, optionally within a time window. Speech and visible text keep the language they were in; descriptions ' +
      'are in one configured language (English unless set otherwise). Search with words as they would be said, ' +
      'written or described, and try other languages or synonyms when nothing matches. Use list_observations or ' +
      'get_video_frames for the details of a hit.', 'memory:read', {
      query: z.string().min(1).max(200), started_at: time.optional(), ended_at: time.optional(),
      limit: z.number().int().min(1).max(50).default(20),
    }, (args: Parameters<MemoryStore['searchObservations']>[0]) => store.searchObservations(args)],
    ['list_video_clips', 'List the original 5-second video clips in time order, by capture_id and/or a time window, ' +
      'with any location fixes. When `more` is true, call again with offset increased by limit.', 'memory:read', {
      capture_id: captureId.optional(), started_at: time.optional(),
      ended_at: time.optional(), limit: z.number().int().min(1).max(200).default(50), offset: z.number().int().min(0).max(100_000).default(0),
    }, (args: Parameters<MemoryStore['listClips']>[0]) => store.listClips(args)],
    ['get_video_clip', 'Get one clip by media_id, with a short-lived URL to download the original video.', 'media:read', {
      media_id: mediaId,
    }, ({ media_id }: { media_id: string }) => store.getClip(media_id)],
    ['get_video_frames', 'Still frames (JPEG images) of original clips: what the camera showed. Give media_id with offsets ' +
      'in seconds from that clip\'s start (list_video_clips returns media IDs and times), or capture_id with absolute ' +
      `times (RFC 3339 with offset). Up to ${MAX_FRAMES} frames per call; size is the longer side in pixels.`, 'media:read', {
      media_id: mediaId.optional(), offsets: z.array(z.number().min(0).max(60)).min(1).max(MAX_FRAMES).optional(),
      capture_id: captureId.optional(), at: z.array(time).min(1).max(MAX_FRAMES).optional(),
      size: z.number().int().min(160).max(1280).default(768),
    }, (args: Parameters<MemoryStore['frames']>[0]) => store.frames(args)],
  ];
  for (const [name, description, scope, shape, run] of tools) {
    server.registerTool(name, { description, inputSchema: z.object(shape).strict(), annotations }, async (args) => {
      try {
        if (!scopes.includes(scope)) throw new ToolError('insufficient_scope', `This tool needs the ${scope} scope; reconnect and allow it`);
        const result = await run(args as never) as Row & { [CONTENT]?: { content: never[]; structuredContent: Row } };
        if (result[CONTENT]) return result[CONTENT];
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

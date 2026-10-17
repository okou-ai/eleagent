// Experimental live-annotation page. The browser runs every model itself; the server only serves static
// files and a small pack of candidate identity features (/v1/live/context). Owner session required.
import { createReadStream } from 'node:fs';
import { realpath, stat } from 'node:fs/promises';
import { extname, join, sep } from 'node:path';
import { ApiError } from './graph.mjs';

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css',
  '.wasm': 'application/wasm', '.onnx': 'application/octet-stream', '.data': 'application/octet-stream', '.txt': 'text/plain',
};
// Cross-origin isolation enables WASM threads. 'unsafe-eval' is needed by onnxruntime-web's WebGPU glue (embind).
const HEADERS = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Content-Security-Policy': "default-src 'self'; script-src 'self' 'wasm-unsafe-eval' 'unsafe-eval'; worker-src 'self' blob:; "
    + "connect-src 'self'; img-src 'self' data: blob:; media-src 'self' blob: mediastream:; style-src 'self'; "
    + "object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
  'Permissions-Policy': 'camera=(self), microphone=(self)',
  'X-Content-Type-Options': 'nosniff',
};
const SAFE_PATH = /^[a-zA-Z0-9_-]+(?:\.[a-zA-Z0-9]+)?(?:\/[a-zA-Z0-9_-]+(?:[.-][a-zA-Z0-9_]+)*)*$/;
const CONTEXT_QUERY = `
  OPTIONAL MATCH (s:SleepState {id: 'sleep'})
  WITH coalesce(s.cluster_map, '{}') AS clusterMap
  MATCH (e:Entity) WHERE e.layer = 'memory' AND e.kind = 'person'
  RETURN e.id AS id, e.name AS name, e.face_vec AS face, e.voice_vec AS voice, clusterMap`;

const vectorList = (value, size) => Array.isArray(value) && value.length === size && value.every(Number.isFinite) ? [value] : [];

export function createLiveHandler({ store, rootDir }) {
  async function context() {
    const rows = await store.read(tx => tx.run(CONTEXT_QUERY));
    return {
      generated_at: new Date().toISOString(),
      thresholds: { face: { threshold: 0.55, margin: 0.08 }, voice: { threshold: 0.55, margin: 0.05 } },
      people: rows.records.map(row => ({
        id: row.get('id'), name: row.get('name') ?? null,
        face: vectorList(row.get('face'), 128), voice: vectorList(row.get('voice'), 192),
      })),
    };
  }

  async function file(res, relative, head) {
    if (!SAFE_PATH.test(relative) || relative.split('/').some(part => part.startsWith('.'))) throw new ApiError(404, 'not_found', 'Not found');
    const root = await realpath(rootDir);
    let path;
    try { path = await realpath(join(root, relative)); } catch { throw new ApiError(404, 'not_found', 'Not found'); }
    const info = await stat(path);
    if (!path.startsWith(root + sep) || !info.isFile()) throw new ApiError(404, 'not_found', 'Not found');
    const large = relative.startsWith('assets/');
    res.writeHead(200, { ...HEADERS, 'Content-Type': TYPES[extname(path)] ?? 'application/octet-stream', 'Content-Length': info.size,
      // Models and runtimes are large and versioned by deployment; app files always revalidate.
      'Cache-Control': large ? 'private, max-age=3600' : 'no-cache' });
    if (head) return res.end();
    return new Promise((resolve, reject) => createReadStream(path).on('error', reject).on('end', resolve).pipe(res));
  }

  return {
    matches: pathname => pathname === '/live' || pathname.startsWith('/live/') || pathname === '/v1/live/context',
    async handle(req, res, url) {
      if (!['GET', 'HEAD'].includes(req.method)) throw new ApiError(405, 'method_not_allowed', 'Use GET');
      if (url.search && url.pathname !== '/live') throw new ApiError(400, 'invalid_request', 'Query parameters are not supported');
      if (url.pathname === '/v1/live/context') {
        const body = JSON.stringify(await context());
        res.writeHead(200, { ...HEADERS, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
        return res.end(req.method === 'HEAD' ? undefined : body);
      }
      if (url.pathname === '/live' || url.pathname === '/live/') return file(res, 'index.html', req.method === 'HEAD');
      return file(res, url.pathname.slice('/live/'.length), req.method === 'HEAD');
    },
  };
}

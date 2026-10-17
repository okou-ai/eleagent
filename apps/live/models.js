// Model downloads for the live worker: streamed with progress and kept in Cache Storage, so a phone downloads each
// model once instead of on every visit (the HTTP cache drops files this large). Keys carry the file's sha256 prefix;
// update VERSIONS whenever a model file is replaced on the server. Load one model at a time: each download holds
// a single copy of the file in memory, and the caller drops it once its session exists.
const VERSIONS = {
  'yunet.onnx': 'ebafce4e3c11', 'sface.onnx': 'ae6a6ac44d2b', 'campplus.onnx': '4b0087069cc0',
  'yoloe-fp16w.onnx': '69a3e1b3b5fc', 'yoloe-s.onnx': '096b70c8b0b1', 'dinov2-fp16w.onnx': '8a63e9ca4a9a',
  'yoloe-names.json': '1acea450ede9',
};
const CACHE = 'live-models';

async function openCache() {
  try { return await caches.open(CACHE); } catch { return null; } // No Cache Storage: download every time.
}

// Aggregates progress over a worker's files and posts it at most four times a second.
export function downloadProgress(post) {
  const files = new Map();
  let lastPost = 0;
  const report = (name, loaded, total, cached) => {
    files.set(name, { loaded, total, cached });
    if (performance.now() - lastPost < 250 && loaded !== total) return;
    lastPost = performance.now();
    const sum = key => [...files.values()].reduce((a, file) => a + file[key], 0);
    post({ type: 'progress', stage: 'downloading', loaded: sum('loaded'), total: sum('total') });
  };
  report.cached = () => [...files.values()].every(file => file.cached);
  return report;
}

// onProgress(name, loadedBytes, totalBytes, cached) is called while the file streams in.
export async function loadModel(name, onProgress = () => {}) {
  const url = `/live/assets/models/${name}`, key = `${url}?sha=${VERSIONS[name] ?? 'unversioned'}`;
  const cache = await openCache();
  const hit = await cache?.match(key);
  if (hit) {
    const bytes = new Uint8Array(await hit.arrayBuffer());
    onProgress(name, bytes.length, bytes.length, true);
    return bytes;
  }
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${name}: HTTP ${response.status}`);
  const total = Number(response.headers.get('content-length')) || 0;
  let body = response.body, stored = null;
  if (cache && VERSIONS[name]) {
    // The cache copy streams to disk alongside the read below, so the page never holds a second copy.
    for (const old of await cache.keys()) if (new URL(old.url).pathname === url) await cache.delete(old);
    const [forCache, forPage] = body.tee();
    stored = cache.put(key, new Response(forCache)).catch(() => {});
    body = forPage;
  }
  // Read straight into one buffer when the size is known; otherwise (e.g. a compressed response) collect chunks.
  const reader = body.getReader(), chunks = [];
  let bytes = total ? new Uint8Array(total) : null, loaded = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (bytes && loaded + value.length > total) { chunks.push(bytes.subarray(0, loaded)); bytes = null; }
    if (bytes) bytes.set(value, loaded); else chunks.push(value);
    loaded += value.length;
    onProgress(name, loaded, total, false);
  }
  if (!bytes) {
    bytes = new Uint8Array(loaded);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  }
  await stored;
  return bytes.subarray(0, loaded);
}

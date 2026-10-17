// Every on-device model in one module worker with one onnxruntime-web instance: face detection (YuNet) and identity
// (SFace), speaker identity (CAM++), object proposals (YOLOE-26 prompt-free) and appearance (DINOv2-S). One instance
// means one WebAssembly heap; a phone runs out of memory with one per model family. Frames arrive as ImageBitmaps and
// utterances as 16 kHz PCM; nothing leaves the device.
import { alignmentMatrix, decodeYunet, l2normalize, matchIdentity, prepareSfaceInput, prepareYunetInput, warpAffineBilinear } from '/live/face.js';
import { downloadProgress, loadModel } from '/live/models.js';
import { DINO_SIZE, decodeYoloe, dinoEmbedding, objectQuality, prepareDinoInput, prepareYoloeInput } from '/live/objects.js';
import { ASSIGN_SIM, MATCH_MARGIN, MATCH_SIM, MIN_SPEECH_SECONDS, RECENT_MS, VOICE_SAMPLE_RATE, fbank, prepareCamppInput, speakerEmbedding, speechOnly } from '/live/voice.js';

const MIN_EMBED_FACE = 64; // Server rule: faces shorter than 64 px are not embedded.
const CROP_MARGIN = 0.5;   // Identity crops extend each side by half the face size.
const MIN_VOICE_SECONDS = 0.8; // Below this CAM++ embeddings are too noisy to assign even to a recent speaker.
let ort, options, yunet, sface, campplus, yoloe, dino, objectNames = [];
let candidates = [], thresholds = { threshold: 0.55, margin: 0.08 };
let voices = [], voiceThresholds = { threshold: MATCH_SIM, margin: MATCH_MARGIN };
let objects = [], objectThresholds = { threshold: 0.65, margin: 0.1 };
const recent = new Map(); // person id -> { name, heard, at }: speakers matched in the last 15 minutes
const contexts = new Map();

function canvas(width, height) {
  const key = `${width}x${height}`;
  if (!contexts.has(key)) {
    if (contexts.size > 8) contexts.clear(); // Identity crops vary in size; keep the cache small.
    contexts.set(key, new OffscreenCanvas(width, height).getContext('2d', { willReadFrequently: true }));
  }
  return contexts.get(key);
}

// Draws bitmap region (sx, sy, sw, sh) into a width x height canvas and returns its RGBA pixels.
function pixels(bitmap, [sx, sy, sw, sh], width, height) {
  const context = canvas(width, height);
  context.clearRect(0, 0, width, height);
  context.drawImage(bitmap, sx, sy, sw, sh, 0, 0, width, height);
  return context.getImageData(0, 0, width, height).data;
}

async function detect(rgba, width, height) {
  const input = prepareYunetInput(rgba, width, height);
  const outputs = await yunet.run({ input: new ort.Tensor('float32', input.data, input.dims) });
  return decodeYunet(Object.fromEntries(Object.entries(outputs).map(([name, tensor]) => [name, { data: tensor.data, dims: tensor.dims }])), width, height);
}

function iou(a, b) {
  const x1 = Math.max(a.x, b.x), y1 = Math.max(a.y, b.y);
  const x2 = Math.min(a.x + a.w, b.x + b.w), y2 = Math.min(a.y + a.h, b.y + b.h);
  const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  return inter / (a.w * a.h + b.w * b.h - inter || 1);
}

// Models load strictly one after another and each file's bytes are dropped once its session exists, so the heap only
// ever holds one model in transit.
function loader(scope) {
  const progress = downloadProgress(message => self.postMessage({ ...message, scope }));
  const totals = { downloadMs: 0, sessionMs: 0 };
  const session = async (name, sessionOptions = options) => {
    let started = performance.now();
    const bytes = await loadModel(name, progress);
    totals.downloadMs += performance.now() - started;
    self.postMessage({ type: 'progress', scope, stage: `creating ${name}` });
    started = performance.now();
    const created = await ort.InferenceSession.create(bytes, sessionOptions);
    totals.sessionMs += performance.now() - started;
    return created;
  };
  return { session, progress, totals };
}

async function init({ webgpu, threads, identity = true, voice = true, voiceWebgpu = false }) {
  // The pure WASM build is half the size of the WebGPU build and is all a phone without WebGPU needs.
  ort = await import(webgpu ? '/live/assets/ort/ort.webgpu.min.mjs' : '/live/assets/ort/ort.wasm.min.mjs');
  ort.env.wasm.wasmPaths = '/live/assets/ort/';
  ort.env.wasm.numThreads = threads;
  // A growing CPU arena never returns memory to the page; phones run out of it.
  options = { executionProviders: webgpu ? ['webgpu', 'wasm'] : ['wasm'], enableCpuMemArena: false, enableMemPattern: false };
  const { session, progress, totals } = loader('face');
  yunet = await session('yunet.onnx');
  sface = identity ? await session('sface.onnx') : null;
  // CAM++ sees a new input length with every sentence; on the CPU that costs nothing extra, so WebGPU is opt-in.
  campplus = voice ? await session('campplus.onnx', { ...options, executionProviders: webgpu && voiceWebgpu ? ['webgpu', 'wasm'] : ['wasm'] }) : null;
  return { backend: webgpu ? 'webgpu' : 'wasm', voiceBackend: campplus ? (webgpu && voiceWebgpu ? 'webgpu' : 'wasm') : 'off',
    threads, cached: progress.cached(), ...totals };
}

// Loaded after the face models so faces and captions come up first. fp16 weights halve the download; detections
// match fp32 (IoU >= 0.997), as on the server's fp16 CUDA path. small selects the S detector.
async function initObjects({ small }) {
  const { session, progress, totals } = loader('objects');
  objectNames = JSON.parse(new TextDecoder().decode(await loadModel('yoloe-names.json', progress)));
  yoloe = await session(small ? 'yoloe-s.onnx' : 'yoloe-fp16w.onnx');
  dino = await session('dinov2-fp16w.onnx');
  return { model: small ? 'S' : 'L', cached: progress.cached(), ...totals };
}

// The server detects and aligns at full resolution. Instead of a full-frame pass, re-detect each face on a
// full-resolution crop around it: landmarks keep full-resolution precision at a fraction of the memory.
async function identify(bitmap, width, height, face) {
  const size = Math.max(face.w, face.h), margin = size * CROP_MARGIN;
  const x0 = Math.max(0, Math.floor(face.x - margin)), y0 = Math.max(0, Math.floor(face.y - margin));
  const x1 = Math.min(width, Math.ceil(face.x + face.w + margin)), y1 = Math.min(height, Math.ceil(face.y + face.h + margin));
  const cropW = x1 - x0, cropH = y1 - y0;
  const crop = pixels(bitmap, [x0, y0, cropW, cropH], cropW, cropH);
  const expected = { x: face.x - x0, y: face.y - y0, w: face.w, h: face.h };
  const found = (await detect(crop, cropW, cropH)).sort((a, b) => iou(b, expected) - iou(a, expected))[0];
  if (!found || iou(found, expected) < 0.3) return { id: null, reason: 'lost' };
  if (Math.min(found.w, found.h) < MIN_EMBED_FACE) return { id: null, reason: 'small' };
  if (!sface) return { id: null, reason: 'off' };
  const aligned = warpAffineBilinear(crop, cropW, cropH, alignmentMatrix(found.landmarks));
  const input = prepareSfaceInput(aligned);
  const output = await sface.run({ data: new ort.Tensor('float32', input.data, input.dims) });
  const embedding = l2normalize(output.fc1.data);
  return embedding ? matchIdentity(embedding, candidates, thresholds) : { id: null };
}

async function frame({ bitmap, width, height, detectWidth, embed }) {
  const timings = {};
  let started = performance.now();
  const scale = detectWidth && detectWidth < width ? detectWidth / width : 1;
  const detW = Math.round(width * scale), detH = Math.round(height * scale);
  const small = pixels(bitmap, [0, 0, width, height], detW, detH);
  timings.readMs = performance.now() - started;
  started = performance.now();
  const faces = (await detect(small, detW, detH)).map(face => ({
    x: face.x / scale, y: face.y / scale, w: face.w / scale, h: face.h / scale, score: face.score }));
  timings.detectMs = performance.now() - started;
  if (embed) {
    started = performance.now();
    for (const face of faces.slice(0, 4)) {
      face.identity = Math.min(face.w, face.h) < MIN_EMBED_FACE ? { id: null, reason: 'small' } : await identify(bitmap, width, height, face);
    }
    timings.embedMs = performance.now() - started;
  }
  bitmap.close();
  return { faces, timings, embed };
}

// objects.py extract(): detect, gate each box on size and blur, embed accepted crops in one batch, then match the
// crop against every memory object (YOLOE labels drift for one item, so matching is not class-scoped).
async function objectFrame({ bitmap, width, height }) {
  const timings = {};
  let started = performance.now();
  const rgba = pixels(bitmap, [0, 0, width, height], width, height);
  bitmap.close();
  const input = prepareYoloeInput(rgba, width, height);
  timings.prepMs = performance.now() - started;
  started = performance.now();
  const outputs = await yoloe.run({ images: new ort.Tensor('float32', input.data, input.dims) });
  const { objects: found, truncated } = decodeYoloe(outputs, input.letterbox, width, height, objectNames);
  timings.detectMs = performance.now() - started;
  started = performance.now();
  for (const object of found) object.quality = objectQuality(rgba, width, height, object);
  const accepted = found.filter(object => object.quality.accepted);
  if (accepted.length) {
    const size = 3 * DINO_SIZE * DINO_SIZE, batch = new Float32Array(accepted.length * size);
    accepted.forEach((object, i) => batch.set(prepareDinoInput(rgba, width, height, object), i * size));
    const { embedding } = await dino.run({ pixel_values: new ort.Tensor('float32', batch, [accepted.length, 3, DINO_SIZE, DINO_SIZE]) });
    accepted.forEach((object, i) => {
      const vector = dinoEmbedding(embedding.data, i);
      object.identity = vector ? matchIdentity(vector, objects, objectThresholds) : { id: null };
    });
  }
  timings.embedMs = performance.now() - started;
  return { objects: found.map(({ x1, y1, x2, y2, score, label, quality, identity }) =>
    ({ x: x1, y: y1, w: x2 - x1, h: y2 - y1, score, label, reason: quality.reason, identity: identity ?? null })), truncated, timings };
}

// Server rule (speech.py): turns of at least 2.5 s are matched to persistent voices; shorter turns go to the nearest
// speaker heard recently, above ASSIGN_SIM. Captions are display-only, so a short turn with no recent speaker may
// still be matched to the stored voiceprints with the full MATCH_SIM/MATCH_MARGIN rule ('short' kind).
async function voice({ id, pcm }) {
  const started = performance.now();
  const speech = speechOnly(pcm), seconds = speech.length / VOICE_SAMPLE_RATE;
  if (!campplus) return { id, seconds, speaker: { id: null, reason: 'off' } };
  if (seconds < MIN_VOICE_SECONDS) return { id, seconds, speaker: { id: null, reason: 'short' } };
  const input = prepareCamppInput(fbank(speech));
  const output = await campplus.run({ feats: new ort.Tensor('float32', input.data, input.dims) });
  const embedding = speakerEmbedding(output.embedding.data);
  const voiceMs = performance.now() - started;
  if (!embedding) return { id, seconds, voiceMs, speaker: { id: null, reason: 'error' } };
  const now = Date.now();
  for (const [key, entry] of recent) if (now - entry.at > RECENT_MS) recent.delete(key);
  if (seconds >= MIN_SPEECH_SECONDS) {
    const match = matchIdentity(embedding, voices, voiceThresholds);
    if (match.id) recent.set(match.id, { name: match.name, heard: [...(recent.get(match.id)?.heard ?? []).slice(-4), embedding], at: now });
    return { id, seconds, voiceMs, speaker: { ...match, kind: 'match' } };
  }
  // Like the server, a recent speaker is represented by its persistent prototypes plus what was just heard.
  const active = [...recent].map(([person, { name, heard }]) =>
    ({ id: person, name, vectors: [...(voices.find(known => known.id === person)?.vectors ?? []), ...heard] }));
  const assigned = matchIdentity(embedding, active, { threshold: ASSIGN_SIM, margin: 0 });
  if (assigned.id) {
    recent.get(assigned.id).at = now;
    return { id, seconds, voiceMs, speaker: { ...assigned, kind: 'assign' } };
  }
  return { id, seconds, voiceMs, speaker: { ...matchIdentity(embedding, voices, voiceThresholds), kind: 'short' } };
}

// Graph prototypes are running means of unit vectors; renormalize before dot-product matching.
const prototypes = (items, key) => items.filter(item => item[key]?.length).map(item => ({ id: item.id, name: item.name,
  vectors: item[key].map(vector => l2normalize(Float32Array.from(vector))).filter(Boolean) }));

async function handle(data) {
  try {
    if (data.type === 'init') self.postMessage({ type: 'ready', ...(await init(data)) });
    else if (data.type === 'objects-init') self.postMessage({ type: 'objects-ready', ...(await initObjects(data)) });
    else if (data.type === 'context') {
      candidates = prototypes(data.people, 'face');
      voices = prototypes(data.people, 'voice');
      objects = prototypes(data.objects ?? [], 'object');
      if (data.thresholds?.face) thresholds = data.thresholds.face;
      if (data.thresholds?.voice) voiceThresholds = data.thresholds.voice;
      if (data.thresholds?.object) objectThresholds = data.thresholds.object;
    } else if (data.type === 'frame') self.postMessage({ type: 'result', ...(await frame(data)) });
    else if (data.type === 'objects') self.postMessage({ type: 'objects-result', ...(await objectFrame(data)) });
    else if (data.type === 'voice') self.postMessage({ type: 'voice', ...(await voice(data)) });
  } catch (error) {
    data.bitmap?.close?.();
    self.postMessage({ type: 'error', message: String(error?.message ?? error), stage: data.type });
  }
}

// One job at a time: frames, object passes and utterances share the onnxruntime instance.
let queue = Promise.resolve();
self.onmessage = ({ data }) => { queue = queue.then(() => handle(data)); };

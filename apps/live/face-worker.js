// Face detection (YuNet) and identity embedding (SFace) in a module worker with onnxruntime-web.
// Frames arrive as ImageBitmaps; nothing leaves the device.
import * as ort from '/live/assets/ort/ort.webgpu.min.mjs';
import { alignmentMatrix, decodeYunet, l2normalize, matchIdentity, prepareSfaceInput, prepareYunetInput, warpAffineBilinear } from '/live/face.js';

const MIN_EMBED_FACE = 64; // Server rule: faces shorter than 64 px are not embedded.
let yunet, sface, backend, candidates = [], thresholds = { threshold: 0.55, margin: 0.08 };
const canvases = new Map();

function pixels(bitmap, width, height) {
  const key = `${width}x${height}`;
  if (!canvases.has(key)) canvases.set(key, new OffscreenCanvas(width, height).getContext('2d', { willReadFrequently: true }));
  const context = canvases.get(key);
  context.drawImage(bitmap, 0, 0, width, height);
  return context.getImageData(0, 0, width, height).data;
}

async function detect(rgba, width, height) {
  const input = prepareYunetInput(rgba, width, height);
  const outputs = await yunet.run({ input: new ort.Tensor('float32', input.data, input.dims) });
  return decodeYunet(Object.fromEntries(Object.entries(outputs).map(([name, tensor]) => [name, { data: tensor.data, dims: tensor.dims }])), width, height);
}

async function init({ webgpu, threads }) {
  ort.env.wasm.wasmPaths = '/live/assets/ort/';
  ort.env.wasm.numThreads = threads;
  const providers = webgpu ? ['webgpu', 'wasm'] : ['wasm'];
  const started = performance.now();
  const [yunetBytes, sfaceBytes] = await Promise.all(['yunet.onnx', 'sface.onnx'].map(async name =>
    new Uint8Array(await (await fetch(`/live/assets/models/${name}`)).arrayBuffer())));
  const loaded = performance.now();
  yunet = await ort.InferenceSession.create(yunetBytes, { executionProviders: providers });
  sface = await ort.InferenceSession.create(sfaceBytes, { executionProviders: providers });
  backend = webgpu ? 'webgpu' : 'wasm';
  return { backend, threads, downloadMs: loaded - started, sessionMs: performance.now() - loaded };
}

async function frame({ bitmap, width, height, detectWidth, embed }) {
  const timings = {};
  let started = performance.now();
  const scale = detectWidth && detectWidth < width ? detectWidth / width : 1;
  const detW = Math.round(width * scale), detH = Math.round(height * scale);
  // Embedding passes detect at full resolution: the server aligns on full-resolution landmarks.
  const full = embed || scale === 1 ? pixels(bitmap, width, height) : null;
  const small = scale === 1 ? full : pixels(bitmap, detW, detH);
  timings.readMs = performance.now() - started;
  started = performance.now();
  let faces = await detect(embed ? full : small, embed ? width : detW, embed ? height : detH);
  const factor = embed ? 1 : 1 / scale;
  faces = faces.map(face => ({ ...face, x: face.x * factor, y: face.y * factor, w: face.w * factor, h: face.h * factor,
    landmarks: face.landmarks.map(([x, y]) => [x * factor, y * factor]) }));
  timings.detectMs = performance.now() - started;
  if (embed) {
    started = performance.now();
    for (const face of faces.slice(0, 4)) {
      if (Math.min(face.w, face.h) < MIN_EMBED_FACE) { face.identity = { id: null, reason: 'small' }; continue; }
      const aligned = warpAffineBilinear(full, width, height, alignmentMatrix(face.landmarks));
      const input = prepareSfaceInput(aligned);
      const output = await sface.run({ data: new ort.Tensor('float32', input.data, input.dims) });
      const embedding = l2normalize(output.fc1.data);
      face.identity = embedding ? matchIdentity(embedding, candidates, thresholds) : { id: null };
    }
    timings.embedMs = performance.now() - started;
  }
  bitmap.close();
  return { faces: faces.map(({ x, y, w, h, score, identity }) => ({ x, y, w, h, score, identity })), timings, embed };
}

self.onmessage = async ({ data }) => {
  try {
    if (data.type === 'init') self.postMessage({ type: 'ready', ...(await init(data)) });
    else if (data.type === 'context') {
      candidates = data.people.filter(person => person.face?.length)
        .map(person => ({ id: person.id, name: person.name,
          // Graph prototypes are running means of unit vectors; renormalize before dot-product matching.
          vectors: person.face.map(vector => l2normalize(Float32Array.from(vector))).filter(Boolean) }));
      if (data.thresholds?.face) thresholds = data.thresholds.face;
    } else if (data.type === 'frame') self.postMessage({ type: 'result', ...(await frame(data)) });
  } catch (error) {
    data.bitmap?.close?.();
    self.postMessage({ type: 'error', message: String(error?.message ?? error), stage: data.type });
  }
};

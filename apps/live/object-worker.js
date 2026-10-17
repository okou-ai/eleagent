// Object proposals (YOLOE-26 prompt-free) and appearance vectors (DINOv2-S) in their own module worker, so the slower
// object pass never delays face tracking. Frames arrive as ImageBitmaps; nothing leaves the device.
import { l2normalize, matchIdentity } from '/live/face.js';
import { DINO_SIZE, decodeYoloe, dinoEmbedding, objectQuality, prepareDinoInput, prepareYoloeInput } from '/live/objects.js';

let ort, yoloe, dino, names = [], candidates = [], thresholds = { threshold: 0.65, margin: 0.1 }, context2d;

async function init({ webgpu, threads, small }) {
  ort = await import(webgpu ? '/live/assets/ort/ort.webgpu.min.mjs' : '/live/assets/ort/ort.wasm.min.mjs');
  ort.env.wasm.wasmPaths = '/live/assets/ort/';
  ort.env.wasm.numThreads = threads;
  const options = { executionProviders: webgpu ? ['webgpu', 'wasm'] : ['wasm'], enableCpuMemArena: false, enableMemPattern: false };
  const started = performance.now();
  const files = [small ? 'yoloe-s.onnx' : 'yoloe.onnx', 'dinov2-fp16w.onnx'];
  const [yoloeBytes, dinoBytes] = await Promise.all(files.map(async name =>
    new Uint8Array(await (await fetch(`/live/assets/models/${name}`)).arrayBuffer())));
  names = await (await fetch('/live/assets/models/yoloe-names.json')).json();
  const loaded = performance.now();
  yoloe = await ort.InferenceSession.create(yoloeBytes, options);
  dino = await ort.InferenceSession.create(dinoBytes, options);
  return { backend: webgpu ? 'webgpu' : 'wasm', model: small ? 'S' : 'L', downloadMs: loaded - started, sessionMs: performance.now() - loaded };
}

function pixels(bitmap, width, height) {
  if (context2d?.canvas.width !== width || context2d?.canvas.height !== height) {
    context2d = new OffscreenCanvas(width, height).getContext('2d', { willReadFrequently: true });
  }
  context2d.drawImage(bitmap, 0, 0);
  return context2d.getImageData(0, 0, width, height).data;
}

// objects.py extract(): detect, gate each box on size and blur, embed accepted crops in one batch, then match the
// crop against every memory object (YOLOE labels drift for one item, so matching is not class-scoped).
async function frame({ bitmap, width, height }) {
  const timings = {};
  let started = performance.now();
  const rgba = pixels(bitmap, width, height);
  bitmap.close();
  const input = prepareYoloeInput(rgba, width, height);
  timings.prepMs = performance.now() - started;
  started = performance.now();
  const outputs = await yoloe.run({ images: new ort.Tensor('float32', input.data, input.dims) });
  const { objects, truncated } = decodeYoloe(outputs, input.letterbox, width, height, names);
  timings.detectMs = performance.now() - started;
  started = performance.now();
  for (const object of objects) object.quality = objectQuality(rgba, width, height, object);
  const accepted = objects.filter(object => object.quality.accepted);
  if (accepted.length) {
    const size = 3 * DINO_SIZE * DINO_SIZE, batch = new Float32Array(accepted.length * size);
    accepted.forEach((object, i) => batch.set(prepareDinoInput(rgba, width, height, object), i * size));
    const { embedding } = await dino.run({ pixel_values: new ort.Tensor('float32', batch, [accepted.length, 3, DINO_SIZE, DINO_SIZE]) });
    accepted.forEach((object, i) => {
      const vector = dinoEmbedding(embedding.data, i);
      object.identity = vector ? matchIdentity(vector, candidates, thresholds) : { id: null };
    });
  }
  timings.embedMs = performance.now() - started;
  return { objects: objects.map(({ x1, y1, x2, y2, score, label, quality, identity }) =>
    ({ x: x1, y: y1, w: x2 - x1, h: y2 - y1, score, label, reason: quality.reason, identity: identity ?? null })), truncated, timings };
}

self.onmessage = async ({ data }) => {
  try {
    if (data.type === 'init') self.postMessage({ type: 'ready', ...(await init(data)) });
    else if (data.type === 'context') {
      // Memory prototypes are running means; renormalize before dot-product matching.
      candidates = (data.objects ?? []).map(item => ({ id: item.id, name: item.name,
        vectors: item.object.map(vector => l2normalize(Float32Array.from(vector))).filter(Boolean) }));
      if (data.thresholds?.object) thresholds = data.thresholds.object;
    } else if (data.type === 'frame') self.postMessage({ type: 'result', ...(await frame(data)) });
  } catch (error) {
    data.bitmap?.close?.();
    self.postMessage({ type: 'error', message: String(error?.message ?? error), stage: data.type });
  }
};

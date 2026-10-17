// Parity test: apps/live/face.js + onnxruntime-node versus OpenCV (opencv_reference.py). See README.md.
// usage: node parity.mjs [--ref /tmp/live-face-images/out] [--models /tmp/live-models]
// Dependencies (onnxruntime-node, pngjs) live outside the repo: LIVE_FACE_DEPS (default /tmp/live-node).
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { alignmentMatrix, decodeYunet, l2normalize, matchIdentity, prepareSfaceInput, prepareYunetInput,
  sfaceModelForOrt, warpAffineBilinear, yunetModelForOrt } from '../../face.js';

const require = createRequire(join(process.env.LIVE_FACE_DEPS || '/tmp/live-node', 'package.json'));
const ort = require('onnxruntime-node');
const { PNG } = require('pngjs');
const { values: args } = parseArgs({ options: {
  ref: { type: 'string', default: '/tmp/live-face-images/out' }, models: { type: 'string', default: '/tmp/live-models' } } });

// Pinned in services/recognition/download_models.py.
const MODELS = {
  yunet: ['face_detection_yunet_2023mar.onnx', '8f2383e4dd3cfbb4553ea8718107fc0423210dc964f9f4280604804ed2552fa4'],
  sface: ['face_recognition_sface_2021dec.onnx', '0ba9fbfa01b5270c96627c4ef784da859931e02f04419c829e83484087c34e79'],
};
const LIMITS = { iou: 0.95, landmark: 1.5, cosine: 0.995 };

const modelBytes = key => {
  const bytes = readFileSync(join(args.models, MODELS[key][0]));
  if (createHash('sha256').update(bytes).digest('hex') !== MODELS[key][1]) throw new Error(`checksum mismatch: ${key}`);
  return bytes;
};
const yunet = await ort.InferenceSession.create(yunetModelForOrt(modelBytes('yunet')));
const sface = await ort.InferenceSession.create(sfaceModelForOrt(modelBytes('sface')));
const reference = JSON.parse(readFileSync(join(args.ref, 'reference.json'), 'utf8'));

async function detect(rgba, width, height) {
  const input = prepareYunetInput(rgba, width, height);
  const outputs = await yunet.run({ input: new ort.Tensor('float32', input.data, input.dims) });
  return decodeYunet(outputs, input.inputWidth, input.inputHeight);
}
async function embed(alignedRgba) {
  const input = prepareSfaceInput(alignedRgba);
  const { fc1 } = await sface.run({ data: new ort.Tensor('float32', input.data, input.dims) });
  return l2normalize(fc1.data);
}
const dot = (a, b) => a.reduce((sum, value, i) => sum + value * b[i], 0);
const iou = ([ax, ay, aw, ah], [bx, by, bw, bh]) => {
  const iw = Math.max(0, Math.min(ax + aw, bx + bw) - Math.max(ax, bx)), ih = Math.max(0, Math.min(ay + ah, by + bh) - Math.max(ay, by));
  return iw * ih / (aw * ah + bw * bh - iw * ih);
};
const boxOf = face => [face.x, face.y, face.w, face.h];

const rows = [];
let failed = false;
for (const ref of reference.cases) {
  const png = PNG.sync.read(readFileSync(join(args.ref, ref.png)));
  if (png.width !== ref.width || png.height !== ref.height) throw new Error(`size mismatch: ${ref.name}`);
  const rgba = new Uint8ClampedArray(png.data.buffer, png.data.byteOffset, png.data.length);

  // 1. decode + NMS on OpenCV's own raw network outputs must reproduce FaceDetectorYN.detect bit-for-bit.
  const raw = Object.fromEntries(Object.entries(ref.raw_outputs).map(([name, { dims, file }]) => {
    const buffer = readFileSync(join(args.ref, file));
    return [name, { dims, data: new Float32Array(buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.length)) }];
  }));
  const decoded = decodeYunet(raw, ref.width, ref.height);
  const decodeExact = decoded.length === ref.faces.length && decoded.every((face, i) => {
    const want = ref.faces[i];
    return [...boxOf(face), face.score, ...face.landmarks.flat()].every((value, k) =>
      value === Math.fround([...want.box, want.score, ...want.landmarks.flat()][k]));
  });

  // 2. Full browser pipeline: onnxruntime YuNet -> decode -> align -> warp -> onnxruntime SFace.
  const faces = await detect(rgba, ref.width, ref.height);
  const used = new Set();
  let iouMin = 1, landmarkMax = 0, cosineMin = 1, runtimeCosineMin = 1, warpMax = 0, warpDiffering = 0, matched = 0;
  const candidates = ref.faces.map((face, i) => ({ id: `${ref.name}#${i}`, name: `face${i}`, vectors: [face.embedding] }));
  for (const [i, want] of ref.faces.entries()) {
    // Pair with the JS detection of highest IoU (near-equal scores may swap order between runtimes).
    const pick = faces.map((face, j) => [used.has(j) ? -1 : iou(boxOf(face), want.box), j]).sort((a, b) => b[0] - a[0])[0];
    if (!pick || pick[0] < 0) { iouMin = 0; break; }
    used.add(pick[1]);
    const got = faces[pick[1]];
    iouMin = Math.min(iouMin, pick[0]);
    got.landmarks.forEach(([x, y], k) => { landmarkMax = Math.max(landmarkMax, Math.hypot(x - want.landmarks[k][0], y - want.landmarks[k][1])); });
    const embedding = await embed(warpAffineBilinear(rgba, ref.width, ref.height, alignmentMatrix(got.landmarks)));
    cosineMin = Math.min(cosineMin, dot(embedding, want.embedding));
    if (matchIdentity(embedding, candidates).id === `${ref.name}#${i}`) matched++;

    // 3. Isolated checks: alignment + warp from OpenCV's landmarks vs alignCrop; SFace on OpenCV's own crop.
    const aligned = PNG.sync.read(readFileSync(join(args.ref, want.aligned_png))).data;
    const ours = warpAffineBilinear(rgba, ref.width, ref.height, alignmentMatrix(want.landmarks));
    for (let p = 0; p < ours.length; p++) {
      if (p % 4 === 3) continue;
      const diff = Math.abs(ours[p] - aligned[p]);
      warpMax = Math.max(warpMax, diff);
      if (diff) warpDiffering++;
    }
    runtimeCosineMin = Math.min(runtimeCosineMin, dot(await embed(new Uint8ClampedArray(aligned)), want.embedding));
  }
  const ok = faces.length === ref.faces.length && decodeExact && iouMin >= LIMITS.iou && landmarkMax <= LIMITS.landmark
    && cosineMin >= LIMITS.cosine && matched === ref.faces.length;
  failed ||= !ok;
  const n = ref.faces.length;
  rows.push({ case: ref.name, size: `${ref.width}x${ref.height}`, 'faces cv/js': `${n}/${faces.length}`,
    'iou min': n ? iouMin.toFixed(5) : '-', 'lmk max px': n ? landmarkMax.toExponential(1) : '-',
    'cos min': n ? cosineMin.toPrecision(8) : '-', 'cos ort-only': n ? runtimeCosineMin.toPrecision(8) : '-', 'warp max|diff ch': n ? `${warpMax}|${warpDiffering}/${n * 112 * 112 * 3}` : '-',
    'decode exact': decodeExact, match: `${matched}/${n}`, ok });
}
console.table(rows);

// Rough CPU timing (median of 30 runs after warm-up) for the 320x240 frame and one SFace call.
const median = values => values.sort((a, b) => a - b)[values.length >> 1];
const time = async (fn, runs = 30) => { await fn(); const out = []; for (let i = 0; i < runs; i++) { const t = performance.now(); await fn(); out.push(performance.now() - t); } return median(out); };
const bench = reference.cases.find(c => c.width === 320 && c.height === 240) ?? reference.cases[0];
const benchPng = PNG.sync.read(readFileSync(join(args.ref, bench.png)));
const yunetInput = prepareYunetInput(benchPng.data, bench.width, bench.height);
const yunetMs = await time(() => yunet.run({ input: new ort.Tensor('float32', yunetInput.data, yunetInput.dims) }));
const sfaceInput = prepareSfaceInput(new Uint8ClampedArray(112 * 112 * 4));
const sfaceMs = await time(() => sface.run({ data: new ort.Tensor('float32', sfaceInput.data, sfaceInput.dims) }));
console.log(`onnxruntime-node ${ort.env.versions?.common ?? ''} CPU: YuNet ${bench.width}x${bench.height} (padded ${yunetInput.dims.slice(2).join('x')}) ` +
  `${yunetMs.toFixed(2)} ms, SFace 112x112 ${sfaceMs.toFixed(2)} ms (median)`);
console.log(failed ? 'PARITY FAILED' : `PARITY OK (iou >= ${LIMITS.iou}, landmarks <= ${LIMITS.landmark}px, cosine >= ${LIMITS.cosine})`);
process.exit(failed ? 1 : 0);

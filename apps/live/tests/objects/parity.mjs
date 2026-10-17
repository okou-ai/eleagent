// Object parity: apps/live/objects.js + yoloe.onnx + dinov2.onnx (onnxruntime-node CPU, or onnxruntime-web wasm with
// LIVE_OBJECTS_ORT_WEB) against the server's own object path (objects_reference.py output). Per image:
//   letterbox  prepareYoloeInput vs the predictor's letterboxed tensor (bit-exact),
//   decode     decodeYoloe on the server's raw head rows vs its detections (bit-exact: NMS, scale_boxes, filtering, order),
//   detect     full JS + ONNX path: every detection with score >= 0.3 on either side pairs 1:1 with the same class and
//              IoU >= 0.95 (the 0.25-0.3 band may flip on float noise), plus the top-8 records and truncated flag,
//   quality    objectQuality blur/reason on the server boxes (exact) and on the JS boxes,
//   dino       prepareDinoInput vs the server pixel_values (max |error|), ONNX on the server pixels (model-only cosine)
//              and end-to-end cosine vs the server feature from the JS box (target >= 0.999).
// Unit cases (synthetic frames) pin the letterbox, blur and DINOv2 preprocessing over many sizes. Exits 1 on failure.
//
// Setup (everything outside the repo; R is a scratch root, default <repo>/../.scratch/live-objects or LIVE_OBJECTS_DIR):
//   python3.12 -m venv $R/venv && $R/venv/bin/pip install --index-url https://download.pytorch.org/whl/cpu torch==2.13.0 torchvision==0.28.0
//   $R/venv/bin/pip install transformers==4.51.0 ultralytics==8.4.175 pillow==10.4.0 opencv-python==5.0.0.93 numpy==2.2.6 \
//     accelerate==1.12.0 onnx onnxruntime onnxslim   # transformers 4.51.0 from_pretrained needs accelerate (init_empty_weights)
//   ENTITY_WEIGHTS_DIR=$R/dl/weights $R/venv/bin/python -I services/recognition/object_download_models.py   # pinned sha256
//   $R/dl/yoloe-s/yoloe-26s-seg-pf.pt from https://github.com/ultralytics/assets/releases/download/v8.4.0/ (speed only)
//   $R/images: ultralytics/assets bus.jpg, zidane.jpg + COCO val2017 000000000139 040471 172595 189475 190236 338905 387098
//     435208 480122 529568 572678 (http://images.cocodataset.org/val2017/<id>.jpg, saved as coco_<id>.jpg)
//   mkdir -p $R/node && (cd $R/node && npm init -y && npm install onnxruntime-node@1.30.0 onnxruntime-web@1.30.0)
// Run (from the repo root):
//   $R/venv/bin/python -I apps/live/tests/objects/objects_reference.py --weights $R/dl/weights --images $R/images --out $R/ref
//   $R/venv/bin/python -I apps/live/tests/objects/export_yoloe.py --weights $R/dl/weights/yoloe-26l-seg-pf.pt \
//     --out $R/models/yoloe.onnx --names $R/models/yoloe-names.json --ref $R/ref [--fp16-weights $R/models/yoloe-fp16w.onnx]
//   $R/venv/bin/python -I apps/live/tests/objects/export_yoloe.py --weights $R/dl/yoloe-s/yoloe-26s-seg-pf.pt \
//     --sha256 01605da3f2e0e5325df45d5f5eef8e40b5b5c7d085399be3c33ac638258b150a --out $R/models/yoloe-s.onnx
//   $R/venv/bin/python -I apps/live/tests/objects/export_dinov2.py --weights $R/dl/weights --out $R/models/dinov2.onnx --ref $R/ref
//   node apps/live/tests/objects/parity.mjs [--yoloe yoloe.onnx] [--dino dinov2.onnx] [--bench]
//   LIVE_OBJECTS_ORT_WEB=$R/node/node_modules/onnxruntime-web/dist/ort.wasm.min.mjs node apps/live/tests/objects/parity.mjs
//     runs the models with onnxruntime-web's wasm backend (1 thread) instead of onnxruntime-node (1 thread; --threads n).
// --bench adds timings (median after warm-up) for yoloe.onnx / yoloe-s.onnx at 640x384 and 640x640, dinov2 batch 1 and 8,
// and the JS pre/post-processing, plus model sizes and sha256.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { DINO_SIZE, MAX_OBJECTS, decodeYoloe, dinoEmbedding, objectQuality, prepareDinoInput, prepareYoloeInput } from '../../objects.js';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const root = process.env.LIVE_OBJECTS_DIR ?? path.join(repo, '..', '.scratch', 'live-objects');
const { values: args } = parseArgs({ options: {
  ref: { type: 'string', default: path.join(root, 'ref') }, models: { type: 'string', default: path.join(root, 'models') },
  yoloe: { type: 'string', default: 'yoloe.onnx' }, dino: { type: 'string', default: 'dinov2.onnx' },
  threads: { type: 'string', default: '1' }, bench: { type: 'boolean', default: false } } });
const web = process.env.LIVE_OBJECTS_ORT_WEB;
const ort = web ? await import(web) : createRequire(path.join(process.env.LIVE_OBJECTS_DEPS ?? path.join(root, 'node'), 'x.js'))('onnxruntime-node');
if (web) Object.assign(ort.env.wasm, { numThreads: 1, wasmPaths: path.dirname(web) + '/' });
const LIMITS = { score: 0.3, iou: 0.95, cosine: 0.999, dino: 1e-6 };

const modelPath = name => path.join(args.models, name);
const session = name => (web ? ort.InferenceSession.create(readFileSync(modelPath(name)), { executionProviders: ['wasm'] })
  : ort.InferenceSession.create(modelPath(name), { intraOpNumThreads: Number(args.threads) }));
const bytes = file => readFileSync(path.join(args.ref, file));
const floats = file => { const b = bytes(file); return new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.length)); };
const rgba = (rgb, count) => {
  const out = new Uint8ClampedArray(count * 4);
  for (let i = 0; i < count; i++) { out[4 * i] = rgb[3 * i]; out[4 * i + 1] = rgb[3 * i + 1]; out[4 * i + 2] = rgb[3 * i + 2]; out[4 * i + 3] = 255; }
  return out;
};
const boxOf = d => ({ x1: d.bbox[0], y1: d.bbox[1], x2: d.bbox[2], y2: d.bbox[3] });
const iou = (a, b) => {
  const w = Math.max(0, Math.min(a.x2, b.x2) - Math.max(a.x1, b.x1)), h = Math.max(0, Math.min(a.y2, b.y2) - Math.max(a.y1, b.y1));
  return w * h / ((a.x2 - a.x1) * (a.y2 - a.y1) + (b.x2 - b.x1) * (b.y2 - b.y1) - w * h);
};
const dot = (a, b) => a.reduce((sum, x, i) => sum + x * b[i], 0);
// Letterboxed uint8 RGB HWC vs prepareYoloeInput's CHW float: count differing values.
const letterboxDiff = (input, expected, [h, w]) => {
  if (input.dims[2] !== h || input.dims[3] !== w) return Infinity;
  let differing = 0;
  const plane = h * w;
  for (let i = 0; i < plane; i++) for (let c = 0; c < 3; c++) if (input.data[c * plane + i] !== Math.fround(expected[3 * i + c] / 255)) differing++;
  return differing;
};
// Greedy one-to-one pairing of same-class detections by IoU.
function pair(server, ours) {
  const pairs = [];
  server.forEach((s, i) => ours.forEach((o, j) => { if (o.classId === s.class_id) pairs.push([iou(boxOf(s), o), i, j]); }));
  pairs.sort((a, b) => b[0] - a[0]);
  const bySrv = new Map(), byOurs = new Map();
  for (const [value, i, j] of pairs) if (value > 0 && !bySrv.has(i) && !byOurs.has(j)) { bySrv.set(i, [j, value]); byOurs.set(j, [i, value]); }
  return { bySrv, byOurs };
}

const yoloe = await session(args.yoloe), dino = await session(args.dino);
const ref = JSON.parse(readFileSync(path.join(args.ref, 'reference.json'), 'utf8'));
const names = JSON.parse(readFileSync(modelPath('yoloe-names.json'), 'utf8'));
const runDino = async (pixels, count) => (await dino.run({ pixel_values: new ort.Tensor('float32', pixels, [count, 3, DINO_SIZE, DINO_SIZE]) })).embedding.data;
console.log(`reference: ${JSON.stringify(ref.meta)}`);
console.log(`models: ${args.yoloe} + ${args.dino}, ${web ? 'onnxruntime-web wasm (1 thread)' : `onnxruntime-node (${args.threads} thread)`} ${ort.env.versions?.web ?? ort.env.versions?.node ?? ''}`);

let failed = false;
const rows = [];
for (const c of ref.cases) {
  const { width, height } = c, frame = rgba(bytes(c.frame), width * height);
  const input = prepareYoloeInput(frame, width, height);
  const letterboxDiffering = letterboxDiff(input, bytes(c.letterbox.file), c.letterbox.shape);
  // Decode on the server's raw rows must reproduce its detections exactly (float32 values, labels, order).
  const raw = floats(c.raw.file);
  const replay = decodeYoloe({ detections: { data: raw, dims: [1, raw.length / 6, 6] } }, input.letterbox, width, height, names, { maxObjects: Infinity }).objects;
  const decodeExact = replay.length === c.detected.length && replay.every((o, i) => {
    const d = c.detected[i];
    return [o.x1, o.y1, o.x2, o.y2, o.score].every((v, k) => v === Math.fround([...d.bbox, d.confidence][k])) && o.classId === d.class_id && o.label === d.label;
  });
  // Full browser path.
  const started = performance.now();
  const output = (await yoloe.run({ images: new ort.Tensor('float32', input.data, input.dims) })).detections;
  const yoloeMs = performance.now() - started;
  const decoded = decodeYoloe({ detections: output }, input.letterbox, width, height, names, { maxObjects: Infinity });
  const ours = decoded.objects;
  const { bySrv, byOurs } = pair(c.detected, ours);
  let strong = 0, unmatched = 0, iouMin = 1, scoreDiff = 0;
  c.detected.forEach((d, i) => {
    const hit = bySrv.get(i);
    if (hit) scoreDiff = Math.max(scoreDiff, Math.abs(ours[hit[0]].score - d.confidence));
    if (d.confidence < LIMITS.score) return;
    strong++;
    if (!hit || hit[1] < LIMITS.iou) unmatched++; else iouMin = Math.min(iouMin, hit[1]);
  });
  ours.forEach((o, j) => { if (o.score >= LIMITS.score && (!byOurs.has(j) || byOurs.get(j)[1] < LIMITS.iou)) unmatched++; });
  // Top-8 records: same objects (class + IoU) in the JS top-8, and the same truncated flag.
  const top = ours.slice(0, MAX_OBJECTS), topPairs = pair(c.records, top);
  const topSame = c.records.length === top.length && c.records.every((_, i) => (topPairs.bySrv.get(i)?.[1] ?? 0) >= LIMITS.iou);
  const truncatedSame = c.records.every(r => r.truncated_objects === decoded.total > MAX_OBJECTS);
  // Quality and DINOv2.
  let blurExact = true, reasonSame = true, jsReasonSame = true, dinoErr = 0;
  const serverPixels = c.dino ? floats(c.dino.file) : new Float32Array(0), jsPixels = [], jsSlots = [];
  c.records.forEach((record, i) => {
    const quality = objectQuality(frame, width, height, boxOf(record));
    blurExact &&= quality.blur === record.quality.blur_laplacian_variance;
    reasonSame &&= quality.reason === record.quality.unknown_reason;
    const k = c.dino?.records.indexOf(i) ?? -1;
    if (k >= 0) {
      const ours1 = prepareDinoInput(frame, width, height, boxOf(record)), size = 3 * DINO_SIZE * DINO_SIZE;
      for (let p = 0; p < size; p++) dinoErr = Math.max(dinoErr, Math.abs(ours1[p] - serverPixels[k * size + p]));
    }
    const mine = topPairs.bySrv.get(i);
    if (!mine) { jsReasonSame = false; return; }
    const object = top[mine[0]], jsQuality = objectQuality(frame, width, height, object);
    jsReasonSame &&= jsQuality.reason === record.quality.unknown_reason;
    if (jsQuality.accepted && record.feature) { jsPixels.push(prepareDinoInput(frame, width, height, object)); jsSlots.push(i); }
  });
  let modelCos = 1, endCos = 1, dinoMs = 0;
  if (c.dino) {
    const count = c.dino.records.length, embedded = await runDino(serverPixels, count);
    c.dino.records.forEach((i, k) => { modelCos = Math.min(modelCos, dot(dinoEmbedding(embedded, k), c.records[i].feature)); });
  }
  if (jsPixels.length) {
    const batch = new Float32Array(jsPixels.length * jsPixels[0].length);
    jsPixels.forEach((p, k) => batch.set(p, k * p.length));
    const t = performance.now(), embedded = await runDino(batch, jsPixels.length);
    dinoMs = performance.now() - t;
    jsSlots.forEach((i, k) => { endCos = Math.min(endCos, dot(dinoEmbedding(embedded, k), c.records[i].feature)); });
  }
  const embeddedCount = c.records.filter(r => r.feature).length;
  const ok = letterboxDiffering === 0 && decodeExact && unmatched === 0 && topSame && truncatedSame && blurExact && reasonSame
    && jsReasonSame && dinoErr <= LIMITS.dino && modelCos >= LIMITS.cosine && endCos >= LIMITS.cosine && jsSlots.length === embeddedCount;
  failed ||= !ok;
  rows.push({ case: c.name, frame: `${width}x${height}`, input: input.dims.slice(2).reverse().join('x'), 'lb diff': letterboxDiffering,
    'decode exact': decodeExact, 'srv>=.3': strong, unmatched, '1-iou max': strong ? (1 - iouMin).toExponential(1) : '-', 'score max|d|': scoreDiff.toExponential(1),
    'top8/trunc': `${topSame ? 'same' : 'DIFF'}/${truncatedSame ? 'same' : 'DIFF'}`, 'blur/reason': `${blurExact ? 'exact' : 'DIFF'}/${reasonSame && jsReasonSame ? 'same' : 'DIFF'}`,
    'dino max|err|': dinoErr.toExponential(1), 'cos model': modelCos.toFixed(7), 'cos e2e': `${endCos.toFixed(7)} (${jsSlots.length}/${embeddedCount})`,
    'ms yoloe+dino': `${yoloeMs.toFixed(0)}+${dinoMs.toFixed(0)}`, ok });
}
console.table(rows);
const worst = key => rows.map(r => parseFloat(String(r[key]))).filter(Number.isFinite);
console.log(`summary: unmatched ${worst('unmatched').reduce((a, b) => a + b, 0)}, max 1-IoU ${Math.max(...worst('1-iou max')).toExponential(1)}, ` +
  `max |score diff| ${Math.max(...worst('score max|d|')).toExponential(1)}, min cosine model-only ${Math.min(...worst('cos model')).toFixed(7)} / end-to-end ${Math.min(...worst('cos e2e')).toFixed(7)}`);

// Unit cases on synthetic frames: letterbox for many sizes, blur on many boxes, DINOv2 pixels on the same boxes.
const units = ref.units;
let unitLetterbox = 0, unitBlur = 0, unitBlurMax = 0, unitDino = 0, unitDinoMax = 0;
for (const u of units.letterbox) {
  const input = prepareYoloeInput(rgba(bytes(u.in), u.width * u.height), u.width, u.height);
  const differing = letterboxDiff(input, bytes(u.out), u.shape);
  if (differing) { unitLetterbox++; console.log(`letterbox unit ${u.width}x${u.height}: ${differing} values differ`); }
}
const crop = rgba(bytes('unit_crop_frame.bin'), 1280 * 720), unitPixels = floats(units.dino.file), size = 3 * DINO_SIZE * DINO_SIZE;
units.quality.forEach((u, k) => {
  const [x1, y1, x2, y2] = u.box, box = { x1, y1, x2, y2 };
  const blur = objectQuality(crop, 1280, 720, box).blur;
  if (blur !== u.blur) { unitBlur++; unitBlurMax = Math.max(unitBlurMax, Math.abs(blur - u.blur) / Math.max(1, u.blur)); }
  const pixels = prepareDinoInput(crop, 1280, 720, box);
  let err = 0;
  for (let p = 0; p < size; p++) err = Math.max(err, Math.abs(pixels[p] - unitPixels[k * size + p]));
  if (err) unitDino++;
  unitDinoMax = Math.max(unitDinoMax, err);
});
const unitsOk = unitLetterbox === 0 && unitBlur === 0 && unitDinoMax <= LIMITS.dino;
failed ||= !unitsOk;
console.log(`units: letterbox ${units.letterbox.length - unitLetterbox}/${units.letterbox.length} exact, blur ${units.quality.length - unitBlur}/${units.quality.length} exact` +
  `${unitBlur ? ` (max rel ${unitBlurMax.toExponential(1)})` : ''}, dino pixels ${units.quality.length - unitDino}/${units.quality.length} exact (max |err| ${unitDinoMax.toExponential(1)})`);

if (args.bench) {
  const median = values => values.sort((a, b) => a - b)[values.length >> 1];
  const time = async (fn, runs) => { await fn(); const out = []; for (let i = 0; i < runs; i++) { const t = performance.now(); await fn(); out.push(performance.now() - t); } return median(out); };
  const describe = name => { const b = readFileSync(modelPath(name)); return `${(b.length / 1e6).toFixed(1)} MB sha256 ${createHash('sha256').update(b).digest('hex')}`; };
  const backend = web ? 'wasm 1 thread' : `node ${args.threads} thread`;
  for (const name of ['yoloe.onnx', 'yoloe-s.onnx'].filter(n => existsSync(modelPath(n)))) {
    const s = name === args.yoloe ? yoloe : await session(name);
    for (const [h, w] of [[384, 640], [640, 640]]) {
      const data = new Float32Array(3 * h * w).fill(0.5);
      const ms = await time(() => s.run({ images: new ort.Tensor('float32', data, [1, 3, h, w]) }), name === 'yoloe.onnx' ? 3 : 5);
      console.log(`bench ${backend}: ${name} ${w}x${h} ${ms.toFixed(0)} ms (${describe(name)})`);
    }
  }
  for (const n of [1, 8]) {
    const pixels = new Float32Array(n * 3 * DINO_SIZE * DINO_SIZE).fill(0.1);
    console.log(`bench ${backend}: ${args.dino} batch ${n} ${(await time(() => runDino(pixels, n), 5)).toFixed(0)} ms (${describe(args.dino)})`);
  }
  for (const name of ['zidane', 'coco_000000172595_1920x1080']) {
    const c = ref.cases.find(x => x.name === name);
    if (!c) continue;
    const frame = rgba(bytes(c.frame), c.width * c.height);
    const prep = await time(() => prepareYoloeInput(frame, c.width, c.height), 9);
    const input = prepareYoloeInput(frame, c.width, c.height);
    const output = (await yoloe.run({ images: new ort.Tensor('float32', input.data, input.dims) })).detections;
    const decode = await time(() => decodeYoloe({ detections: output }, input.letterbox, c.width, c.height, names), 9);
    const objects = decodeYoloe({ detections: output }, input.letterbox, c.width, c.height, names).objects;
    const post = await time(() => objects.forEach(o => { objectQuality(frame, c.width, c.height, o); prepareDinoInput(frame, c.width, c.height, o); }), 5);
    console.log(`bench js: ${name} ${c.width}x${c.height} prepareYoloeInput ${prep.toFixed(1)} ms, decodeYoloe ${decode.toFixed(1)} ms, ` +
      `objectQuality+prepareDinoInput for ${objects.length} objects ${post.toFixed(1)} ms`);
  }
}
console.log(failed ? 'FAIL' : `PASS (letterbox/decode/blur exact, score >= ${LIMITS.score} 1:1 IoU >= ${LIMITS.iou} same class, dino pixels <= ${LIMITS.dino}, cosine >= ${LIMITS.cosine})`);
process.exit(failed ? 1 : 0);

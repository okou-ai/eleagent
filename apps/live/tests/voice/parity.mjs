// Voice parity: apps/live/voice.js + campplus.onnx (onnxruntime-node, CPU) against the server's own CAM++ path
// (campplus_reference.py output). Per clip: fbank max |error| vs funasr/torchaudio fbank, embedding cosine vs
// speech.py Models.embed (target >= 0.999), plus model-only cosine (ONNX on the server's fbank). Exits 1 on failure.
//
// Setup (everything outside the repo):
//   python3 -m venv /tmp/live-voice/venv && /tmp/live-voice/venv/bin/pip install --index-url https://download.pytorch.org/whl/cpu \
//     torch==2.13.0 torchaudio==2.11.0 && /tmp/live-voice/venv/bin/pip install funasr==1.4.16 numpy==2.2.6 onnx onnxruntime
//   funasr/campplus @ e4b6ede7ce16997aff4ae69fbca1f0175e2afede (config.yaml, configuration.json, campplus_cn_common.bin)
//     -> /tmp/live-voice/dl/campplus
//   mkdir -p /tmp/live-node && (cd /tmp/live-node && npm init -y && npm install onnxruntime-node)
// Run (from the repo root; W = sherpa-onnx-streaming-zipformer-small-bilingual-zh-en-2023-02-16/test_wavs):
//   /tmp/live-voice/venv/bin/python apps/live/tests/voice/campplus_reference.py --wavs $W --campplus /tmp/live-voice/dl/campplus --out /tmp/live-voice/ref-local
//   /tmp/live-voice/venv/bin/python apps/live/tests/voice/export_campplus.py --campplus /tmp/live-voice/dl/campplus \
//     --out /tmp/live-models/campplus.onnx --ref /tmp/live-voice/ref-local
//   node apps/live/tests/voice/parity.mjs [reference dir] [model]
//   LIVE_VOICE_ORT_WEB=/tmp/live-assets/ort/package/dist/ort.wasm.min.mjs node apps/live/tests/voice/parity.mjs ...
//     runs the model with onnxruntime-web's wasm backend (1 thread) instead of onnxruntime-node.
// The reference can also be produced inside the production image (docker exec eleagent-speech, CUDA_VISIBLE_DEVICES=,
// --campplus /models/campplus --recognition-src /app) and its output directory passed as the first argument.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fbank, prepareCamppInput, speakerEmbedding } from '../../voice.js';

const refDir = process.argv[2] ?? '/tmp/live-voice/ref-local';
const modelPath = process.argv[3] ?? '/tmp/live-models/campplus.onnx';
const web = process.env.LIVE_VOICE_ORT_WEB;
const ort = web ? await import(web) : createRequire(path.join(process.env.LIVE_VOICE_DEPS ?? '/tmp/live-node', 'x.js'))('onnxruntime-node');
if (web) Object.assign(ort.env.wasm, { numThreads: 1, wasmPaths: path.dirname(web) + '/' });
const MIN_COSINE = 0.999, MAX_FBANK_ERROR = 2e-3;

const f32file = file => { const b = readFileSync(path.join(refDir, file)); return new Float32Array(b.buffer, b.byteOffset, b.length / 4); };
const dot = (a, b) => a.reduce((sum, x, i) => sum + x * b[i], 0);
const ref = JSON.parse(readFileSync(path.join(refDir, 'reference.json'), 'utf8'));
const session = web ? await ort.InferenceSession.create(readFileSync(modelPath), { executionProviders: ['wasm'] })
  : await ort.InferenceSession.create(modelPath, { intraOpNumThreads: 1 });
const embed = async input => speakerEmbedding((await session.run({ feats: new ort.Tensor('float32', input.data, input.dims) })).embedding.data);

console.log(`reference: ${JSON.stringify(ref.meta)}\nmodel: ${modelPath}, ${web ? 'onnxruntime-web wasm' : 'onnxruntime-node'} ${ort.env.versions?.web ?? ort.env.versions?.node ?? ''}`);
console.log('clip       seconds frames  fbank max|err|  mean|err|   1-cosine   model-only 1-cos   ms(fbank+ort)');
let failed = false;
const emb = {};
for (const clip of ref.clips) {
  const pcm = f32file(`clip_${clip.name}.f32`), want = f32file(`fbank_${clip.name}.f32`);
  let started = performance.now();
  const features = fbank(pcm);
  const fbankMs = performance.now() - started;
  let maxErr = 0, sumErr = 0;
  for (let i = 0; i < want.length; i++) { const e = Math.abs(features.data[i] - want[i]); maxErr = Math.max(maxErr, e); sumErr += e; }
  const input = prepareCamppInput(features);
  started = performance.now();
  emb[clip.name] = await embed(input);
  const ortMs = performance.now() - started;
  const cosine = dot(emb[clip.name], clip.embedding);
  const modelOnly = dot(await embed(prepareCamppInput({ data: want, frames: clip.frames, bins: 80 })), clip.embedding);
  const ok = features.frames === clip.frames && maxErr <= MAX_FBANK_ERROR && cosine >= MIN_COSINE && modelOnly >= MIN_COSINE;
  failed ||= !ok;
  console.log(`${clip.name.padEnd(10)} ${(clip.samples / 16000).toFixed(2).padStart(6)} ${String(features.frames).padStart(6)}  ${maxErr.toExponential(2).padStart(13)}  ${(sumErr / want.length).toExponential(2)}  ${(1 - cosine).toExponential(1).padStart(8)}   ${(1 - modelOnly).toExponential(1).padStart(8)}         ${fbankMs.toFixed(0)}+${ortMs.toFixed(0)}${ok ? '' : '  FAIL'}`);
}

// Inference time (single thread, after warm-up), median of 5.
for (const name of ['4_3s', '4_8s']) {
  const clip = ref.clips.find(c => c.name === name), pcm = f32file(`clip_${name}.f32`), times = [];
  for (let i = 0; i < 5; i++) {
    const started = performance.now();
    const input = prepareCamppInput(fbank(pcm));
    const t1 = performance.now();
    await embed(input);
    times.push([t1 - started, performance.now() - t1]);
  }
  times.sort((a, b) => a[0] + a[1] - b[0] - b[1]);
  console.log(`timing ${(clip.samples / 16000).toFixed(1)} s: fbank ${times[2][0].toFixed(1)} ms + onnx ${times[2][1].toFixed(1)} ms`);
}

// Sanity (not gated): slices of one recording vs slices of the other recording (0.wav and 4.wav are different
// speakers), and the whole-file similarity matrix. Compare with MATCH_SIM 0.55.
const slices = Object.keys(emb).filter(name => name.includes('_') && ['0', '4'].includes(name.split('_')[0]));
const pairs = { same: [], different: [] };
for (const [i, a] of slices.entries()) {
  for (const b of slices.slice(i + 1)) pairs[a[0] === b[0] ? 'same' : 'different'].push(`${a}~${b} ${dot(emb[a], emb[b]).toFixed(3)}`);
}
console.log(`same speaker, different slices: ${pairs.same.join(', ')}\ndifferent speakers: ${pairs.different.join(', ')}`);
const files = Object.keys(emb).filter(name => !name.includes('_'));
console.log(`whole files\n      ${files.map(n => n.padStart(7)).join('')}`);
for (const a of files) console.log(`${a.padStart(6)}${files.map(b => dot(emb[a], emb[b]).toFixed(3).padStart(7)).join('')}`);
console.log(failed ? 'FAIL' : `PASS (cosine >= ${MIN_COSINE}, fbank max|err| <= ${MAX_FBANK_ERROR})`);
process.exit(failed ? 1 : 0);

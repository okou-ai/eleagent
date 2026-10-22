// Eleagent's on-device voice: a wake word (keyword spotting) and the owner's voiceprint (speaker embeddings), both
// running in the page with sherpa-onnx compiled to WebAssembly (public/voice/eleagent-voice.*, see README.md).
// The keyword-spotter config layout below is adapted from sherpa-onnx's wasm/kws/sherpa-onnx-kws.js (Apache-2.0).
// Nothing here sends audio anywhere.

const CACHE = 'eleagent-voice-v1';
export const SAMPLE_RATE = 16000;

const MODELS = {
  '/models/kws/encoder.onnx': '/voice/models/kws/encoder.int8.onnx',
  '/models/kws/decoder.onnx': '/voice/models/kws/decoder.onnx',
  '/models/kws/joiner.onnx': '/voice/models/kws/joiner.int8.onnx',
  '/models/kws/tokens.txt': '/voice/models/kws/tokens.txt',
  '/models/speaker.onnx': '/voice/models/speaker.onnx',
};

// Model files are downloaded once and kept in the Cache Storage.
async function fetchCached(url, onProgress) {
  const cache = await caches.open(CACHE).catch(() => null);
  const hit = await cache?.match(url);
  if (hit) return new Uint8Array(await hit.arrayBuffer());
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  const total = Number(response.headers.get('content-length')) || 0;
  const reader = response.body.getReader();
  const chunks = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.length;
    onProgress?.(received, total);
  }
  const bytes = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  await cache?.put(url, new Response(bytes, { headers: { 'Content-Type': 'application/octet-stream' } })).catch(() => {});
  return bytes;
}

// Writes strings into the module's heap and returns { pointers, free }.
function strings(Module, values) {
  const sizes = values.map((value) => Module.lengthBytesUTF8(value) + 1);
  const buffer = Module._malloc(sizes.reduce((a, b) => a + b, 0));
  const pointers = [];
  let offset = 0;
  values.forEach((value, i) => { Module.stringToUTF8(value, buffer + offset, sizes[i]); pointers.push(buffer + offset); offset += sizes[i]; });
  return { pointers, free: () => Module._free(buffer) };
}

class KeywordSpotter {
  constructor(Module, { keywords, threshold = 0.25, score = 1.0 }) {
    this.Module = Module;
    const s = strings(Module, ['/models/kws/encoder.onnx', '/models/kws/decoder.onnx', '/models/kws/joiner.onnx',
      '/models/kws/tokens.txt', 'cpu', '', '', '', '', keywords]);
    const [encoder, decoder, joiner, tokens, provider, modelType, modelingUnit, bpeVocab, tokensBuf, keywordsBuf] = s.pointers;
    // SherpaOnnxKeywordSpotterConfig: feature config (2 ints), online model config, then 7 words.
    const transducer = 3 * 4, otherModels = 2 * 4 + 1 * 4, modelTail = 9 * 4 + 1 * 4 + 1 * 4;
    const modelLength = transducer + otherModels + modelTail;
    const length = 2 * 4 + modelLength + 7 * 4;
    const ptr = Module._malloc(length);
    Module.HEAPU8.fill(0, ptr, ptr + length);
    let o = ptr;
    Module.setValue(o, SAMPLE_RATE, 'i32'); Module.setValue(o + 4, 80, 'i32'); o += 8;
    Module.setValue(o, encoder, 'i8*'); Module.setValue(o + 4, decoder, 'i8*'); Module.setValue(o + 8, joiner, 'i8*');
    o += transducer + otherModels;
    Module.setValue(o, tokens, 'i8*'); Module.setValue(o + 4, 1, 'i32'); Module.setValue(o + 8, provider, 'i8*');
    Module.setValue(o + 12, 0, 'i32'); Module.setValue(o + 16, modelType, 'i8*'); Module.setValue(o + 20, modelingUnit, 'i8*');
    Module.setValue(o + 24, bpeVocab, 'i8*'); Module.setValue(o + 28, tokensBuf, 'i8*'); Module.setValue(o + 32, 0, 'i32');
    o = ptr + 8 + modelLength;
    Module.setValue(o, 4, 'i32');                 // max_active_paths
    Module.setValue(o + 4, 1, 'i32');             // num_trailing_blanks
    Module.setValue(o + 8, score, 'float');       // keywords_score
    Module.setValue(o + 12, threshold, 'float');  // keywords_threshold
    Module.setValue(o + 16, modelType, 'i8*');    // keywords_file: none
    Module.setValue(o + 20, keywordsBuf, 'i8*');  // keywords_buf
    Module.setValue(o + 24, Module.lengthBytesUTF8(keywords), 'i32');
    this.handle = Module._SherpaOnnxCreateKeywordSpotter(ptr);
    Module._free(ptr);
    s.free();
    if (!this.handle) throw new Error('The keyword spotter rejected these keywords (check the tokens)');
    this.stream = Module._SherpaOnnxCreateKeywordStream(this.handle);
    this.buffer = 0;
    this.capacity = 0;
  }

  // Feeds 16 kHz samples; returns the keywords spotted in them.
  accept(samples) {
    const { Module } = this;
    if (this.capacity < samples.length) {
      Module._free(this.buffer);
      this.buffer = Module._malloc(samples.length * 4);
      this.capacity = samples.length;
    }
    Module.HEAPF32.set(samples, this.buffer / 4);
    Module._SherpaOnnxOnlineStreamAcceptWaveform(this.stream, SAMPLE_RATE, this.buffer, samples.length);
    const found = [];
    while (Module._SherpaOnnxIsKeywordStreamReady(this.handle, this.stream) === 1) {
      Module._SherpaOnnxDecodeKeywordStream(this.handle, this.stream);
      const result = Module._SherpaOnnxGetKeywordResult(this.handle, this.stream);
      const json = JSON.parse(Module.UTF8ToString(Module.getValue(result + 24, 'i8*')));
      Module._SherpaOnnxDestroyKeywordResult(result);
      if (json.keyword) {
        found.push(json.keyword);
        Module._SherpaOnnxResetKeywordStream(this.handle, this.stream);
      }
    }
    return found;
  }

  free() {
    this.Module._SherpaOnnxDestroyOnlineStream(this.stream);
    this.Module._SherpaOnnxDestroyKeywordSpotter(this.handle);
    this.Module._free(this.buffer);
  }
}

class Voiceprint {
  constructor(Module) {
    this.Module = Module;
    const s = strings(Module, ['/models/speaker.onnx', 'cpu']);
    const config = Module._malloc(16);
    Module.setValue(config, s.pointers[0], 'i8*');
    Module.setValue(config + 4, 1, 'i32');
    Module.setValue(config + 8, 0, 'i32');
    Module.setValue(config + 12, s.pointers[1], 'i8*');
    this.handle = Module._SherpaOnnxCreateSpeakerEmbeddingExtractor(config);
    Module._free(config);
    s.free();
    if (!this.handle) throw new Error('The speaker model could not be loaded');
    this.dim = Module._SherpaOnnxSpeakerEmbeddingExtractorDim(this.handle);
  }

  // A unit-length embedding of 16 kHz speech, or null when it is too short.
  embed(samples) {
    const { Module } = this;
    const stream = Module._SherpaOnnxSpeakerEmbeddingExtractorCreateStream(this.handle);
    const buffer = Module._malloc(samples.length * 4);
    Module.HEAPF32.set(samples, buffer / 4);
    Module._SherpaOnnxOnlineStreamAcceptWaveform(stream, SAMPLE_RATE, buffer, samples.length);
    Module._SherpaOnnxOnlineStreamInputFinished(stream);
    let vector = null;
    if (Module._SherpaOnnxSpeakerEmbeddingExtractorIsReady(this.handle, stream) === 1) {
      const pointer = Module._SherpaOnnxSpeakerEmbeddingExtractorComputeEmbedding(this.handle, stream);
      vector = Float32Array.from(Module.HEAPF32.subarray(pointer / 4, pointer / 4 + this.dim));
      Module._SherpaOnnxSpeakerEmbeddingExtractorDestroyEmbedding(pointer);
      const norm = Math.hypot(...vector) || 1;
      for (let i = 0; i < vector.length; i++) vector[i] /= norm;
    }
    Module._SherpaOnnxDestroyOnlineStream(stream);
    Module._free(buffer);
    return vector;
  }
}

export const similarity = (a, b) => a.reduce((sum, value, i) => sum + value * b[i], 0);

export function average(vectors) {
  const mean = new Float32Array(vectors[0].length);
  for (const vector of vectors) for (let i = 0; i < mean.length; i++) mean[i] += vector[i] / vectors.length;
  const norm = Math.hypot(...mean) || 1;
  return mean.map((value) => value / norm);
}

// Loads the module and the models (reporting progress), and returns factories for the two engines.
export async function loadVoice({ onProgress } = {}) {
  const timings = {};
  let start = performance.now();
  // eleagent-voice.js (a classic script) defines createEleagentVoice.
  const Module = await globalThis.createEleagentVoice({ locateFile: (file) => `/voice/${file}` });
  timings.runtime = performance.now() - start;
  start = performance.now();
  Module.FS.mkdirTree('/models/kws');
  let done = 0;
  for (const [path, url] of Object.entries(MODELS)) {
    Module.FS.writeFile(path, await fetchCached(url, (received, total) => onProgress?.(url, received, total)));
    onProgress?.(url, 1, 1, ++done, Object.keys(MODELS).length);
  }
  timings.models = performance.now() - start;
  return {
    Module, timings,
    keywordSpotter: (options) => new KeywordSpotter(Module, options),
    voiceprint: () => new Voiceprint(Module),
  };
}

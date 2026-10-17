// Browser-side CAM++ speaker embeddings that reproduce the server's voiceprints
// (services/recognition/entity_worker/speech.py: Models.embed -> FunASR 1.4.16 CAMPPlus.inference ->
// funasr/models/campplus/utils.py extract_feature -> torchaudio 2.11 compliance.kaldi.fbank, all on CPU float32).
// No DOM and no onnxruntime dependency: the caller runs campplus.onnx (feats [1, frames, 80] -> embedding [1, 192]).
// Math.fround marks float32 arithmetic that torch performs in float32. Verified by apps/live/tests/voice.

const f32 = Math.fround;
const SR = 16000;
const FRAME = 400, SHIFT = 160, FFT = 512, BINS = 80; // 25 ms / 10 ms at 16 kHz, padded to the next power of two
const PREEMPH = f32(0.97);
const EPS = f32(1.1920928955078125e-7); // torch.finfo(float32).eps: floor before log

// speech.py:20-21. Only VAD regions >= 2.5 s (ANCHOR_SECONDS) are matched to persistent voice entities with
// MATCH_SIM/MATCH_MARGIN, each embedded in one pass like speakerEmbedding below; shorter turns never are.
export const MIN_SPEECH_SECONDS = 2.5;
export const MATCH_SIM = 0.55, MATCH_MARGIN = 0.05;
// speech.py:22 and the 15-minute "recently active" window: shorter turns go to the nearest recent speaker.
export const ASSIGN_SIM = 0.35, RECENT_MS = 15 * 60_000;
export const VOICE_SAMPLE_RATE = SR;

let tables;
function init() {
  // povey window: torch.hann_window(400, periodic=False, float32).pow(0.85)
  const window = new Float32Array(FRAME), step = f32(2 * Math.PI / (FRAME - 1));
  for (let i = 0; i < FRAME; i++) window[i] = f32(Math.pow(f32(f32(-0.5 * f32(Math.cos(f32(i * step)))) + 0.5), 0.85));
  // kaldi.get_mel_banks(80, 512, 16000, low_freq=20, high_freq=0 -> nyquist), float32 like torch; bin 256 stays 0
  const melLow = 1127 * Math.log(1 + 20 / 700), melHigh = 1127 * Math.log(1 + 8000 / 700);
  const delta = f32((melHigh - melLow) / (BINS + 1)), low = f32(melLow);
  const mel = Float32Array.from({ length: FFT / 2 }, (_, k) => f32(1127 * f32(Math.log(f32(1 + f32(f32(31.25 * k) / 700))))));
  const banks = [];
  for (let m = 0; m < BINS; m++) {
    const left = f32(low + f32(m * delta)), center = f32(low + f32((m + 1) * delta)), right = f32(low + f32((m + 2) * delta));
    const weights = new Float64Array(FFT / 2);
    for (let k = 0; k < FFT / 2; k++) {
      const up = f32(f32(mel[k] - left) / f32(center - left)), down = f32(f32(right - mel[k]) / f32(right - center));
      weights[k] = Math.max(0, Math.min(up, down));
    }
    banks.push(weights);
  }
  const cos = new Float64Array(FFT / 2), sin = new Float64Array(FFT / 2), rev = new Uint16Array(FFT);
  for (let i = 0; i < FFT / 2; i++) { cos[i] = Math.cos(2 * Math.PI * i / FFT); sin[i] = -Math.sin(2 * Math.PI * i / FFT); }
  for (let i = 0, j = 0; i < FFT; i++) {
    rev[i] = j;
    let bit = FFT >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j |= bit;
  }
  tables = { window, banks, cos, sin, rev };
}

// In-place radix-2 FFT (float64; torch uses float32 pocketfft, the difference is rounding noise).
function fft(re, im, { cos, sin, rev }) {
  for (let i = 0; i < FFT; i++) {
    const j = rev[i];
    if (j > i) { const t = re[i]; re[i] = re[j]; re[j] = t; }
  }
  for (let size = 2; size <= FFT; size <<= 1) {
    const half = size >> 1, stride = FFT / size;
    for (let start = 0; start < FFT; start += size) {
      for (let k = 0; k < half; k++) {
        const a = start + k, b = a + half, wr = cos[k * stride], wi = sin[k * stride];
        const tr = re[b] * wr - im[b] * wi, ti = re[b] * wi + im[b] * wr;
        re[b] = re[a] - tr; im[b] = im[a] - ti; re[a] += tr; im[a] += ti;
      }
    }
  }
}

// kaldi.fbank(wave[None], num_mel_bins=80) with torchaudio defaults: dither 0, remove_dc_offset, preemphasis 0.97
// (first sample replicated), povey window, snip_edges (only whole frames), power spectrum, log mel energies, no
// energy term, no mean subtraction. Input is float PCM in [-1, 1] and is NOT scaled to int16: the server feeds the
// ffmpeg f32le samples straight through (funasr/utils/load_utils.py, np.ndarray branch: torch.from_numpy only).
export function fbank(pcm16k) {
  if (!tables) init();
  const { window, banks } = tables;
  const frames = pcm16k.length < FRAME ? 0 : 1 + Math.floor((pcm16k.length - FRAME) / SHIFT);
  const data = new Float32Array(frames * BINS);
  const frame = new Float32Array(FRAME), re = new Float64Array(FFT), im = new Float64Array(FFT), power = new Float64Array(FFT / 2);
  for (let t = 0; t < frames; t++) {
    let sum = 0;
    for (let i = 0; i < FRAME; i++) sum += (frame[i] = pcm16k[t * SHIFT + i]);
    const mean = f32(sum / FRAME);
    for (let i = 0; i < FRAME; i++) frame[i] = f32(frame[i] - mean); // remove_dc_offset
    for (let i = 0; i < FRAME; i++) re[i] = f32(f32(frame[i] - f32(PREEMPH * frame[i ? i - 1 : 0])) * window[i]);
    re.fill(0, FRAME); im.fill(0);
    fft(re, im, tables);
    for (let k = 0; k < FFT / 2; k++) power[k] = f32(re[k] * re[k] + im[k] * im[k]);
    for (let m = 0; m < BINS; m++) {
      const weights = banks[m];
      let energy = 0;
      for (let k = 0; k < FFT / 2; k++) energy += power[k] * weights[k];
      data[t * BINS + m] = f32(Math.log(Math.max(f32(energy), EPS)));
    }
  }
  return { data, frames, bins: BINS };
}

// extract_feature: per-utterance mean normalisation over time (no variance), then CAMPPlus.forward on [1, T, 80].
// Returns null below 3 frames: after the stride-2 TDNN the unbiased std pooling needs >= 2 time steps.
export function prepareCamppInput({ data: feats, frames, bins }) {
  if (frames < 3) return null;
  const data = new Float32Array(frames * bins);
  for (let m = 0; m < bins; m++) {
    let sum = 0;
    for (let t = 0; t < frames; t++) sum += feats[t * bins + m];
    const mean = f32(sum / frames);
    for (let t = 0; t < frames; t++) data[t * bins + m] = f32(feats[t * bins + m] - mean);
  }
  return { data, dims: [1, frames, bins] };
}

// Energy gate standing in for the server's Silero VAD (speech.py VAD: min speech 250 ms, min silence 300 ms, pad
// 100 ms). Keeps 10 ms frames well above the utterance's noise floor and concatenates them into one region.
export function speechOnly(pcm16k) {
  const size = SR / 100, frames = Math.floor(pcm16k.length / size);
  if (!frames) return new Float32Array(0);
  const rms = new Float32Array(frames);
  for (let t = 0; t < frames; t++) {
    let sum = 0;
    for (let i = t * size; i < (t + 1) * size; i++) sum += pcm16k[i] * pcm16k[i];
    rms[t] = Math.sqrt(sum / size);
  }
  const sorted = Float32Array.from(rms).sort();
  const floor = sorted[Math.floor(frames * 0.2)], loud = sorted[Math.floor(frames * 0.95)];
  const threshold = Math.max(floor * 3, loud * 0.08, 1e-4);
  const voiced = Array.from(rms, value => value > threshold);
  const runs = [];
  for (let t = 0; t < frames;) {
    if (!voiced[t]) { t++; continue; }
    let end = t;
    while (end < frames && voiced[end]) end++;
    if (runs.length && t - runs.at(-1)[1] < 30) runs.at(-1)[1] = end; else runs.push([t, end]);
    t = end;
  }
  const kept = runs.filter(([a, b]) => b - a >= 25).map(([a, b]) => [Math.max(0, a - 10) * size, Math.min(frames, b + 10) * size]);
  const out = new Float32Array(kept.reduce((sum, [a, b]) => sum + b - a, 0));
  let offset = 0;
  for (const [a, b] of kept) { out.set(pcm16k.subarray(a, b), offset); offset += b - a; }
  return out;
}

// Models.embed: value / ||value|| (server in float64; prototypes are compared by dot product).
export function speakerEmbedding(outputData) {
  if (!outputData || outputData.length < 192) return null;
  let norm = 0;
  for (let i = 0; i < 192; i++) norm += outputData[i] * outputData[i];
  norm = Math.sqrt(norm);
  if (!(norm > 0) || !Number.isFinite(norm)) return null;
  return Float32Array.from(outputData.subarray(0, 192), x => x / norm);
}


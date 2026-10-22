// Talking to Okou from the capture page, like "Hey Siri": say "Hey Okou" while recording (or tap the Okou mark) and
// the screen's edge lights up, the mark moves to the middle and the record button steps aside while you say what you
// want. When you stop speaking, the request goes to Okou (/api/okou/ask). The wake word and the check that it was the
// owner's voice run on the phone (/voice/engine.js); the first use records the owner's voiceprint.

export const SAMPLE_RATE = 16000;
const PRINT_KEY = 'eleagent.voice.samples';
const KEYWORDS = ['HH EY1 OW1 K UW1 L @hey_okou', 'HH EY1 OW1 K UW1 @hey_okou', 'h ēi ōu k òu @嘿欧扣'].join('\n');
const RING_SECONDS = 30, PREROLL_SECONDS = 1.5, CHECK_SECONDS = 8, SETUP_SAMPLES = 3, SETUP_SECONDS = 4, VOICE_MATCH = 0.5;

// --- pure helpers (tests/okou.test.mjs) ---

export function levelDb(chunk) {
  let sum = 0;
  for (let i = 0; i < chunk.length; i++) sum += chunk[i] * chunk[i];
  return 10 * Math.log10(sum / Math.max(1, chunk.length) + 1e-12);
}

// When has the speaker finished? Fed ~100 ms chunks; speech is anything well above the room's noise floor. In a loud
// room the bar stops rising at -35 dB, so the owner speaking close to the phone is still heard (the request then ends
// at the time limit, or with a tap on the mark).
export class SpeechEnd {
  constructor({ floorDb = -60, minSpeechMs = 500, silenceMs = 1400, noSpeechMs = 6000, maxMs = 15000 } = {}) {
    Object.assign(this, { threshold: Math.min(-35, Math.max(-52, floorDb + 12)), minSpeechMs, silenceMs, noSpeechMs, maxMs });
    this.elapsed = 0; this.speech = 0; this.quiet = 0;
  }
  push(chunk) {
    const ms = (chunk.length / SAMPLE_RATE) * 1000;
    this.elapsed += ms;
    if (levelDb(chunk) > this.threshold) { this.speech += ms; this.quiet = 0; } else this.quiet += ms;
    if (this.elapsed >= this.maxMs) return 'max';
    if (this.speech >= this.minSpeechMs && this.quiet >= this.silenceMs) return 'done';
    if (this.speech < this.minSpeechMs && this.elapsed >= this.noSpeechMs) return 'nothing';
    return 'continue';
  }
}

// 16-bit mono PCM WAV.
export function encodeWav(samples, rate = SAMPLE_RATE) {
  const bytes = new Uint8Array(44 + samples.length * 2);
  const view = new DataView(bytes.buffer);
  const text = (offset, value) => { for (let i = 0; i < value.length; i++) bytes[offset + i] = value.charCodeAt(i); };
  text(0, 'RIFF'); view.setUint32(4, 36 + samples.length * 2, true); text(8, 'WAVEfmt ');
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, rate, true); view.setUint32(28, rate * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
  text(36, 'data'); view.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) view.setInt16(44 + i * 2, Math.max(-1, Math.min(1, samples[i])) * 0x7fff, true);
  return bytes;
}

export function resample(input, rate) {
  if (rate === SAMPLE_RATE) return input;
  const ratio = rate / SAMPLE_RATE, output = new Float32Array(Math.floor(input.length / ratio));
  for (let i = 0; i < output.length; i++) {
    const start = Math.floor(i * ratio), end = Math.min(input.length, Math.floor((i + 1) * ratio));
    let sum = 0;
    for (let j = start; j < end; j++) sum += input[j];
    output[i] = sum / Math.max(1, end - start);
  }
  return output;
}

// --- the page side ---

const unit = (vector) => { const norm = Math.hypot(...vector) || 1; return vector.map((value) => value / norm); };
const dot = (a, b) => a.reduce((sum, value, i) => sum + value * b[i], 0);
function storedPrint() {
  try {
    const samples = JSON.parse(localStorage.getItem(PRINT_KEY) ?? '[]');
    if (!samples.length) return null;
    const mean = new Float32Array(samples[0].length);
    for (const sample of samples) for (let i = 0; i < mean.length; i++) mean[i] += sample[i] / samples.length;
    return unit(mean);
  } catch { return null; }
}

// env: { $, connected(), recordingStream(), captureId(), onModeChange(active) }
export function setupOkou(env) {
  const { $ } = env;
  const ring = new Float32Array(RING_SECONDS * SAMPLE_RATE);
  let written = 0, audio = null, ownStream = null, voice = null, loading = null, spotter = null, voiceprint = null;
  let print = storedPrint(), mode = null, closeTimer = null;

  const slice = (from, to = written) => {
    const start = Math.max(from, written - ring.length, 0), out = new Float32Array(Math.max(0, to - start));
    for (let i = 0; i < out.length; i++) out[i] = ring[(start + i) % ring.length];
    return out;
  };
  // The quieter part of the last five seconds, as the room's noise floor.
  const noiseFloor = () => {
    const levels = [];
    for (let at = Math.max(0, written - 5 * SAMPLE_RATE); at < written; at += SAMPLE_RATE / 10) levels.push(levelDb(slice(at, at + SAMPLE_RATE / 10)));
    levels.sort((a, b) => a - b);
    return levels[Math.floor(levels.length * 0.1)] ?? -60;
  };

  function show(state, text = '') {
    if (state && !document.body.dataset.okou) {
      // The mark travels from its corner to just above the middle of the screen. Its resting place is measured from
      // its container, which never moves, so a mark still on its way back does not throw the measurement off.
      const mark = $('okou'), lead = mark.parentElement.getBoundingClientRect();
      mark.style.setProperty('--to-x', `${innerWidth / 2 - (lead.left + mark.offsetWidth / 2)}px`);
      mark.style.setProperty('--to-y', `${innerHeight / 2 - (lead.top + lead.height / 2) - 40}px`);
    }
    document.body.dataset.okou = state ?? '';
    $('okou-text').textContent = text;
    env.onModeChange?.(Boolean(state));
  }

  async function loadVoice(progress) {
    loading ??= (async () => {
      if (!globalThis.createEleagentVoice) {
        await new Promise((resolve, reject) => {
          const script = Object.assign(document.createElement('script'), { src: '/voice/eleagent-voice.js', onload: resolve, onerror: reject });
          document.head.append(script);
        });
      }
      const engine = await import('/voice/engine.js');
      voice = await engine.loadVoice({ onProgress: progress });
      voiceprint = voice.voiceprint();
      spotter = voice.keywordSpotter({ keywords: KEYWORDS, threshold: 0.25, score: 1.5 });
    })().catch((error) => { loading = null; throw error; });
    return loading;
  }

  function onAudio(chunk) {
    for (let i = 0; i < chunk.length; i++) ring[(written + i) % ring.length] = chunk[i];
    written += chunk.length;
    if (mode) { mode.push(chunk); return; }
    // "Hey Okou" is listened for only once Okou is connected and the owner's voiceprint exists.
    if (spotter && print && env.connected() && spotter.accept(chunk).length) void open('wake');
  }

  async function attach(stream) {
    if (audio?.stream === stream) return;
    detach();
    const context = new AudioContext();
    await context.audioWorklet.addModule('/voice/worklet.js');
    const source = context.createMediaStreamSource(stream);
    const node = new AudioWorkletNode(context, 'eleagent-tap');
    node.port.onmessage = ({ data }) => onAudio(resample(data, context.sampleRate));
    source.connect(node);
    audio = { stream, context, source, node };
    void context.resume().catch(() => {});
    if (print && env.connected()) void loadVoice().catch(() => {});
  }
  function detach() {
    if (!audio) return;
    audio.source.disconnect();
    audio.node.port.onmessage = null;
    void audio.context.close().catch(() => {});
    audio = null;
  }

  function close(text) {
    clearTimeout(closeTimer);
    const finish = () => {
      mode = null;
      show(null);
      if (ownStream) {
        ownStream.getTracks().forEach((track) => track.stop());
        ownStream = null;
        detach();
        const recording = env.recordingStream();
        if (recording) void attach(recording);
      }
    };
    if (!text) { finish(); return; }
    mode = { push() {} };
    show('done', text);
    closeTimer = setTimeout(finish, 2200);
  }

  async function microphone() {
    const recording = env.recordingStream();
    if (recording) { await attach(recording); return; }
    ownStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    await attach(ownStream);
  }

  async function send(samples) {
    show('sending', 'Sending to Okou…');
    const query = new URLSearchParams({ at: new Date().toISOString(), ...(env.captureId() ? { capture_id: env.captureId() } : {}) });
    try {
      const response = await fetch(`/api/okou/ask?${query}`, { method: 'POST', headers: { 'Content-Type': 'audio/wav' }, body: encodeWav(samples) });
      const result = await response.json().catch(() => ({}));
      close(response.ok ? result.screen || 'Handed to Okou' : result.error?.message || 'Okou could not take that');
    } catch {
      close('Could not reach Okou');
    }
  }

  async function request(trigger) {
    const startAt = trigger === 'wake' ? written - PREROLL_SECONDS * SAMPLE_RATE : written;
    const ender = new SpeechEnd({ floorDb: noiseFloor() });
    const done = async () => {
      if (mode?.kind !== 'request') return;
      mode = { kind: 'sending', push() {} };
      const samples = slice(startAt);
      if (trigger === 'wake') {
        show('checking', 'Checking your voice…');
        const vector = voiceprint.embed(samples.slice(0, CHECK_SECONDS * SAMPLE_RATE));
        if (!vector || dot(unit(vector), print) < VOICE_MATCH) { close('That did not sound like you'); return; }
      }
      await send(samples);
    };
    mode = { kind: 'request', finish: done, push(chunk) {
      const verdict = ender.push(chunk);
      if (verdict === 'done' || verdict === 'max') void done();
      else if (verdict === 'nothing') close('Did not hear anything');
    } };
    show('listening', 'Listening…');
  }

  // First use: three short samples of the owner's voice.
  async function setup() {
    mode = { kind: 'setup', push() {} };
    show('setup', 'Getting ready…');
    try {
      await loadVoice((url, received, total, done, count) => {
        $('okou-text').textContent = done ? `Getting ready ${done}/${count}…` : `Downloading the voice model ${total ? `${Math.round(100 * received / total)}%` : ''}`;
      });
    } catch { close('Could not load the voice model'); return; }
    const samples = [];
    for (let n = 1; n <= SETUP_SAMPLES; n++) {
      show('setup', `Say “Hey Okou” and a short sentence · ${n} of ${SETUP_SAMPLES}`);
      const from = written;
      await new Promise((resolve) => setTimeout(resolve, SETUP_SECONDS * 1000));
      if (mode?.kind !== 'setup') return;
      const vector = voiceprint.embed(slice(from));
      if (vector) samples.push(Array.from(unit(vector)));
    }
    if (samples.length < 2) { close('Could not hear enough; try again'); return; }
    try { localStorage.setItem(PRINT_KEY, JSON.stringify(samples)); } catch { /* still works for this visit */ }
    print = storedPrint() ?? unit(Float32Array.from(samples[0]));
    close('Hey Okou is ready');
  }

  async function open(trigger) {
    if (mode || !env.connected()) return;
    mode = { kind: 'opening', push() {} };
    try { await microphone(); } catch { close('The microphone is not available'); return; }
    if (!print) { await setup(); return; }
    await request(trigger);
  }

  return {
    attach, detach, open,
    // Recording stopped (paused, page hidden): a request that was using its microphone is dropped.
    recordingStopped() {
      if (!audio || audio.stream === ownStream) return;
      if (mode) close();
      detach();
    },
    active: () => Boolean(mode),
    // Tapping the mark while listening sends at once; the cancel button drops the request.
    tap() { if (mode?.kind === 'request') void mode.finish(); else if (!mode) void open('tap'); },
    cancel: () => close(),
  };
}

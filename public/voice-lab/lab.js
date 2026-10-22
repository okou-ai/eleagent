// The voice lab: try the on-device wake word and voiceprint (public/voice/engine.js) on a phone. Samples and the
// voiceprint stay in this browser (localStorage); nothing is uploaded.
import { SAMPLE_RATE, average, loadVoice, similarity } from '/voice/engine.js';

const $ = (id) => document.getElementById(id);
const PRINT_KEY = 'eleagent.voice.samples';
const RING_SECONDS = 12, SAMPLE_SECONDS = 4, BEFORE_SECONDS = 1.5, AFTER_SECONDS = 2.5;
const DEFAULT_KEYWORDS = [
  'HH EY1 OW1 K UW1 L @hey_okou',
  'HH EY1 OW1 K UW1 @hey_okou',
  'h ēi ōu k òu @嘿欧扣',
  'ōu k òu @欧扣',
].join('\n');

let voice, voiceprint, spotter;
let context, ring = new Float32Array(RING_SECONDS * SAMPLE_RATE), written = 0;
let listening = false, cpuMs = 0, audioMs = 0, lastMeter = 0;

$('keywords').value = localStorage.getItem('eleagent.voice.keywords') ?? DEFAULT_KEYWORDS;

// --- voiceprint samples (localStorage) ---
const samples = () => JSON.parse(localStorage.getItem(PRINT_KEY) ?? '[]').map((values) => Float32Array.from(values));
const saveSamples = (list) => localStorage.setItem(PRINT_KEY, JSON.stringify(list.map((vector) => Array.from(vector))));
function showPrint() {
  const list = samples();
  if (!list.length) { $('print').textContent = 'No voiceprint yet.'; return; }
  const pairs = [];
  for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) pairs.push(similarity(list[i], list[j]));
  $('print').textContent = `${list.length} sample${list.length > 1 ? 's' : ''}` +
    (pairs.length ? ` · samples agree ${Math.min(...pairs).toFixed(2)}–${Math.max(...pairs).toFixed(2)}` : '') +
    (list.length < 3 ? ' · record more for a steadier voiceprint' : '');
}
const ownerPrint = () => { const list = samples(); return list.length ? average(list) : null; };

// --- audio: microphone → 16 kHz ring buffer (and the wake word, while listening) ---
function resample(input, rate) {
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
function remember(chunk) {
  for (let i = 0; i < chunk.length; i++) ring[(written + i) % ring.length] = chunk[i];
  written += chunk.length;
}
// The last `seconds` of audio, ending now.
function recent(seconds) {
  const n = Math.min(written, Math.round(seconds * SAMPLE_RATE)), out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = ring[(written - n + i) % ring.length];
  return out;
}
const wait = (seconds) => new Promise((resolve) => setTimeout(resolve, seconds * 1000));

async function microphone() {
  if (context) return;
  const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } });
  context = new AudioContext();
  await context.audioWorklet.addModule('/voice/worklet.js');
  const source = context.createMediaStreamSource(stream);
  const tap = new AudioWorkletNode(context, 'eleagent-tap');
  tap.port.onmessage = ({ data }) => onAudio(resample(data, context.sampleRate));
  source.connect(tap);
  await context.resume();
}

function onAudio(chunk) {
  remember(chunk);
  if (!listening || !spotter) return;
  const start = performance.now();
  const found = spotter.accept(chunk);
  cpuMs += performance.now() - start;
  audioMs += (chunk.length / SAMPLE_RATE) * 1000;
  for (const keyword of found) void heard(keyword, new Date());
  if (performance.now() - lastMeter > 1000) {
    lastMeter = performance.now();
    $('meter').textContent = `Listening · wake word uses ${(100 * cpuMs / Math.max(1, audioMs)).toFixed(1)}% of real time ` +
      `(${(audioMs / 1000).toFixed(0)} s of audio)`;
  }
}

// A wake word: wait for the words after it, then check the voice against the owner's voiceprint.
async function heard(keyword, at) {
  const item = document.createElement('li');
  item.textContent = `${at.toLocaleTimeString()} · ${keyword} · checking the voice…`;
  $('log').prepend(item);
  await wait(AFTER_SECONDS);
  const print = ownerPrint();
  if (!print) { item.textContent = `${at.toLocaleTimeString()} · ${keyword} · no voiceprint to compare with`; return; }
  const start = performance.now();
  const vector = voiceprint.embed(recent(BEFORE_SECONDS + AFTER_SECONDS));
  const ms = performance.now() - start;
  const score = vector ? similarity(vector, print) : NaN;
  const you = score >= Number($('match').value);
  item.innerHTML = '';
  item.append(`${at.toLocaleTimeString()} · ${keyword} · `);
  const verdict = document.createElement('span');
  verdict.className = you ? 'yes' : 'no';
  verdict.textContent = Number.isNaN(score) ? 'too short to tell' : `${you ? 'you' : 'not you'} (${score.toFixed(2)})`;
  item.append(verdict, ` · voice check ${ms.toFixed(0)} ms`);
}

// --- controls ---
$('enroll').addEventListener('click', async () => {
  $('enroll').disabled = true;
  try {
    await microphone();
    for (let left = SAMPLE_SECONDS; left > 0; left--) { $('print').textContent = `Speak now… ${left}`; await wait(1); }
    const vector = voiceprint.embed(recent(SAMPLE_SECONDS));
    if (!vector) throw new Error('too short');
    saveSamples([...samples(), vector].slice(-5));
  } catch (error) {
    $('print').textContent = `Could not record: ${error.message}`;
    $('enroll').disabled = false;
    return;
  }
  showPrint();
  $('enroll').disabled = false;
});
$('forget').addEventListener('click', () => { localStorage.removeItem(PRINT_KEY); showPrint(); });

$('listen').addEventListener('click', async () => {
  if (listening) {
    listening = false;
    $('listen').textContent = 'Start listening';
    $('meter').textContent = '';
    return;
  }
  try {
    localStorage.setItem('eleagent.voice.keywords', $('keywords').value);
    spotter?.free();
    spotter = voice.keywordSpotter({ keywords: $('keywords').value.trim(), threshold: Number($('threshold').value), score: Number($('boost').value) });
    await microphone();
    cpuMs = 0; audioMs = 0;
    listening = true;
    $('listen').textContent = 'Stop listening';
  } catch (error) {
    $('meter').textContent = `Could not start: ${error.message}`;
  }
});

// --- start ---
showPrint();
try {
  voice = await loadVoice({ onProgress: (url, received, total, done, count) => {
    $('load').textContent = done ? `Loading models ${done}/${count}…` :
      `Downloading ${url.split('/').pop()} ${total ? `${Math.round(100 * received / total)}%` : `${(received / 1e6).toFixed(1)} MB`}`;
  } });
  const start = performance.now();
  voiceprint = voice.voiceprint();
  $('load').textContent = `Ready · runtime ${voice.timings.runtime.toFixed(0)} ms · models ${voice.timings.models.toFixed(0)} ms · ` +
    `voiceprint model ${(performance.now() - start).toFixed(0)} ms`;
  $('load').className = 'hint';
  for (const id of ['enroll', 'forget', 'listen']) $(id).disabled = false;
} catch (error) {
  $('load').textContent = `Could not load: ${error.message}`;
}

// Live annotation spike: on-device face and object boxes with names, and streaming captions labelled with the speaker.
// The only server call is the candidate feature pack (/v1/live/context); frames and audio stay on the device.
const $ = id => document.getElementById(id);
const CONTEXT_MS = 15_000;
const EMBED_MS = 1_000;
const OBJECT_MS = 1_000; // Minimum gap between object passes; a pass itself may take longer.
const video = $('video'), overlay = $('overlay'), ctx = overlay.getContext('2d');
const params = new URLSearchParams(location.search);
const BUILD = 'objects-4';
const stats = { frames: 0, since: performance.now(), detect: [], embed: [], read: [], voice: [], objectDetect: [], objectEmbed: [] };
const voiceCounts = { finals: 0, sent: 0, skipped: 0, results: 0 };
let worker, workerBusy = false, workerInfo = null, workerError = null, workerProgress = null, camera = 'user', stream, lastEmbed = 0, lastVoice = null;
let objectsRequested = false, objectBusy = false, objectInfo = null, objectError = null, objectProgress = null, lastObject = 0;
let tracks = [], objectTracks = [], nextTrackId = 1, context = { people: [], objects: [], thresholds: null, at: 0, error: null };

const loading = progress => !progress ? 'loading models' : progress.stage !== 'downloading' ? progress.stage
  : `downloading ${(progress.loaded / 1e6).toFixed(0)}/${progress.total ? (progress.total / 1e6).toFixed(0) : '?'} MB`
    + (progress.total ? ` (${Math.round(progress.loaded / progress.total * 100)}%)` : '');
const loaded = info => `load=${Math.round(info.downloadMs)}+${Math.round(info.sessionMs)}ms${info.cached ? ' (cached)' : ''}`;
const average = values => values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0;
const push = (list, value) => { list.push(value); if (list.length > 30) list.shift(); };

function iou(a, b) {
  const x1 = Math.max(a.x, b.x), y1 = Math.max(a.y, b.y);
  const x2 = Math.min(a.x + a.w, b.x + b.w), y2 = Math.min(a.y + a.h, b.y + b.h);
  const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  return inter / (a.w * a.h + b.w * b.h - inter || 1);
}

// Greedy IoU tracking keeps a name on a face or object between identity passes.
function follow(previous, boxes, voting) {
  const next = [];
  for (const box of boxes) {
    let best = null, bestIou = 0.3;
    for (const candidate of previous) {
      const overlap = iou(box, candidate.box);
      if (overlap > bestIou && !next.includes(candidate)) { best = candidate; bestIou = overlap; }
    }
    const current = best ?? { id: nextTrackId++, votes: [] };
    current.box = box;
    if (voting && box.identity) {
      current.votes = [...current.votes, box.identity].slice(-3);
      current.score = box.identity.score;
    }
    next.push(current);
  }
  return next;
}

// A name is shown once it wins at least two of the last three identity passes.
function winner(votes) {
  const counts = new Map();
  for (const vote of votes) if (vote.id) counts.set(vote.id, { name: vote.name, n: (counts.get(vote.id)?.n ?? 0) + 1 });
  const best = [...counts.values()].sort((a, b) => b.n - a.n)[0];
  return best && best.n >= Math.min(2, votes.length) ? best.name : null;
}

function label(trackItem) {
  const name = winner(trackItem.votes);
  if (name) return name;
  const last = trackItem.votes.at(-1);
  if (last?.reason === 'small') return 'too small';
  return trackItem.votes.length ? `unknown ${trackItem.score?.toFixed(2) ?? ''}` : '…';
}

const STYLES = {
  face: { stroke: '#30d158', fill: 'rgba(48,209,88,.85)', font: '600 14px' },
  object: { stroke: '#ff9f0a', fill: 'rgba(255,159,10,.9)', font: '600 13px' },
  unknown: { stroke: 'rgba(255,255,255,.8)', fill: 'rgba(28,28,30,.7)', font: '600 14px' },
  proposal: { stroke: 'rgba(255,255,255,.35)', fill: 'rgba(28,28,30,.55)', font: '500 12px' },
};

function draw() {
  const width = overlay.clientWidth, height = overlay.clientHeight, ratio = devicePixelRatio || 1;
  if (overlay.width !== width * ratio || overlay.height !== height * ratio) { overlay.width = width * ratio; overlay.height = height * ratio; }
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  ctx.clearRect(0, 0, width, height);
  const vw = video.videoWidth, vh = video.videoHeight;
  if (!vw) return;
  // object-fit: cover mapping, mirrored for the front camera to match the preview.
  const scale = Math.max(width / vw, height / vh), dx = (width - vw * scale) / 2, dy = (height - vh * scale) / 2;
  const box = ({ x, y, w, h }, text, style) => {
    let left = dx + x * scale;
    if (camera === 'user') left = width - left - w * scale;
    const top = dy + y * scale;
    ctx.lineWidth = 2;
    ctx.strokeStyle = style.stroke;
    ctx.strokeRect(left, top, w * scale, h * scale);
    ctx.font = `${style.font} -apple-system, system-ui, sans-serif`;
    const textWidth = ctx.measureText(text).width + 12;
    ctx.fillStyle = style.fill;
    // Keep the name tag inside the view even when the box touches an edge.
    const tagX = Math.min(Math.max(left, 0), width - textWidth), tagY = Math.max(top - 22, 0);
    ctx.fillRect(tagX, tagY, textWidth, 20);
    ctx.fillStyle = '#fff';
    ctx.fillText(text, tagX + 6, tagY + 15);
  };
  // Objects first so faces stay on top. Unrecognized objects keep their detector label and best memory score.
  for (const item of objectTracks) {
    const name = winner(item.votes), score = item.box.identity?.score;
    box(item.box, name ?? `${item.box.label}${score == null ? '' : ` ${score.toFixed(2)}`}`, name ? STYLES.object : STYLES.proposal);
  }
  for (const item of tracks) {
    const text = label(item);
    box(item.box, text, /^(unknown|…|too small)/.test(text) ? STYLES.unknown : STYLES.face);
  }
}

function hud() {
  const asr = window.liveAsr;
  const seconds = (performance.now() - stats.since) / 1000;
  const lines = [
    `face: ${workerError ? `error ${workerError}` : workerInfo ? `${workerInfo.backend} threads=${workerInfo.threads} ${loaded(workerInfo)}` : loading(workerProgress)}`,
    `isolated=${crossOriginIsolated} webgpu=${'gpu' in navigator} cores=${navigator.hardwareConcurrency ?? '?'} video=${video.videoWidth}x${video.videoHeight}`,
    `detect ${average(stats.detect).toFixed(0)}ms read ${average(stats.read).toFixed(0)}ms · ${(stats.frames / seconds || 0).toFixed(1)} fps · embed ${average(stats.embed).toFixed(0)}ms`,
    `context: ${context.error ? `error ${context.error}` : `${context.people.filter(p => p.face?.length).length}/${context.people.length} people with faces, ${context.at ? Math.round((Date.now() - context.at) / 1000) + 's ago' : 'pending'}`}`,
    `asr: ${asr?.state.status ?? 'missing'} rtf=${asr ? asr.rtf().toFixed(2) : '-'}`,
    `voice: ${workerInfo?.voiceBackend ?? '-'} ${context.people.filter(p => p.voice?.length).length} voiceprints · ${voiceSummary()}`,
    `objects: ${objectSummary()}`,
    `build ${BUILD} · voice finals ${voiceCounts.finals} sent ${voiceCounts.sent} skipped ${voiceCounts.skipped} results ${voiceCounts.results}${asr?.state.utteranceError ? ` · error ${asr.state.utteranceError}` : ''}`,
  ];
  $('hud').textContent = lines.join('\n');
  if (seconds > 5) { stats.frames = 0; stats.since = performance.now(); }
}

function objectSummary() {
  if (params.has('noobjects')) return 'off';
  if (objectError) return `error ${objectError}`;
  if (!objectInfo) return workerInfo ? loading(objectProgress) : 'waiting for faces';
  const known = objectTracks.filter(item => winner(item.votes)).length;
  return `${workerInfo.backend} ${objectInfo.model} ${loaded(objectInfo)} · ${context.objects.length} memories · `
    + `detect ${average(stats.objectDetect).toFixed(0)}ms embed ${average(stats.objectEmbed).toFixed(0)}ms · ${objectTracks.length} boxes, ${known} known`;
}

function voiceSummary() {
  if (!lastVoice) return 'waiting for a sentence';
  const { seconds, voiceMs, speaker } = lastVoice;
  const who = speaker.reason ?? `${speaker.name ?? 'unknown'} ${speaker.score?.toFixed(2) ?? ''}${speaker.second == null ? '' : `/${speaker.second.toFixed(2)}`} ${speaker.kind}`;
  return `last ${seconds.toFixed(1)}s speech → ${who}${voiceMs ? ` · ${Math.round(voiceMs)}ms (avg ${Math.round(average(stats.voice))})` : ''}`;
}

// Long turns are matched against stored voiceprints (solid tag); short ones prefer speakers heard recently (dim tag).
// Every sentence carries a tag so the voice state is visible: pending, too short, unknown with its best score, or a name.
function speakerTag(speaker) {
  if (!speaker) return { text: '…', className: 'speaker' };
  if (speaker.reason) return { text: speaker.reason === 'short' ? 'short' : `voice ${speaker.reason}`, className: 'speaker' };
  if (speaker.id) return { text: speaker.name ?? '?', className: speaker.kind === 'match' ? 'speaker known' : 'speaker recent' };
  return { text: `unknown ${speaker.score?.toFixed(2) ?? ''}`.trim(), className: 'speaker' };
}

function renderCaption(finals, partial) {
  $('final').replaceChildren(...finals.map(final => {
    const line = document.createElement('span');
    line.className = 'line';
    const { text, className } = speakerTag(final.speaker), name = document.createElement('b');
    name.className = className;
    name.textContent = text;
    line.append(name, final.text);
    return line;
  }));
  $('partial').textContent = partial;
}

async function refreshContext() {
  try {
    const response = await fetch('/v1/live/context', { cache: 'no-store', credentials: 'same-origin' });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const body = await response.json();
    context = { people: body.people ?? [], objects: body.objects ?? [], thresholds: body.thresholds, at: Date.now(), error: null };
    worker?.postMessage({ type: 'context', people: context.people, objects: context.objects, thresholds: body.thresholds });
  } catch (error) { context.error = error.message; }
}

async function pumpObjects() {
  if (!objectInfo || objectBusy || performance.now() - lastObject < OBJECT_MS) return;
  objectBusy = true;
  lastObject = performance.now();
  try {
    const bitmap = await createImageBitmap(video);
    worker.postMessage({ type: 'objects', bitmap, width: video.videoWidth, height: video.videoHeight }, [bitmap]);
  } catch { objectBusy = false; }
}

async function pump() {
  requestAnimationFrame(pump);
  draw();
  if (video.readyState < 2 || window.livePaused) return;
  pumpObjects();
  if (!worker || workerBusy || !workerInfo) return;
  workerBusy = true;
  const embed = performance.now() - lastEmbed > EMBED_MS;
  if (embed) lastEmbed = performance.now();
  try {
    const bitmap = await createImageBitmap(video);
    worker.postMessage({ type: 'frame', bitmap, width: video.videoWidth, height: video.videoHeight,
      detectWidth: Number($('detect-size').value), embed }, [bitmap]);
  } catch { workerBusy = false; }
}

const VIDEO = () => ({ facingMode: camera, width: { ideal: 960 }, height: { ideal: 720 } });

async function openCamera(media) {
  stream?.getVideoTracks().forEach(t => t.stop());
  media ??= await navigator.mediaDevices.getUserMedia({ video: VIDEO() });
  video.srcObject = new MediaStream([...media.getVideoTracks()]);
  video.classList.toggle('mirrored', camera === 'user');
  stream = media;
  tracks = [];
  objectTracks = [];
  await video.play().catch(() => {});
}

// Started inside the tap so iOS allows the AudioContext; audio is ignored until the recognizer is ready.
async function startAudio(media) {
  const audio = new AudioContext({ sampleRate: 16000 });
  await audio.resume();
  const source = audio.createMediaStreamSource(media);
  // ScriptProcessor keeps the spike simple; an AudioWorklet would move this off the main thread.
  const processor = audio.createScriptProcessor(4096, 1, 1);
  processor.onaudioprocess = event => window.liveAsr.feed(Float32Array.from(event.inputBuffer.getChannelData(0)), audio.sampleRate);
  source.connect(processor);
  processor.connect(audio.destination);
  window.liveAsr.state.onText = renderCaption;
  // Each finished sentence goes to the worker for an on-device speaker embedding.
  window.liveAsr.state.onUtterance = (final, pcm) => {
    voiceCounts.finals++;
    if (!workerInfo) { voiceCounts.skipped++; final.speaker = { id: null, reason: 'not ready' }; return; }
    worker.postMessage({ type: 'voice', id: final.id, pcm }, [pcm.buffer]);
    voiceCounts.sent++;
  };
}

const threadCount = () => {
  const requested = Number(params.get('threads'));
  return !crossOriginIsolated ? 1 : requested > 0 ? Math.min(requested, 8) : Math.min(4, navigator.hardwareConcurrency || 2);
};

// One worker runs every model (one onnxruntime instance and heap). Object models load after the face models, so faces
// and captions come up first. ?objects=s uses the small detector; ?noobjects skips objects.
function startWorker() {
  worker = new Worker('/live/live-worker.js', { type: 'module' });
  worker.onmessage = ({ data }) => {
    if (data.type === 'ready') {
      workerInfo = data;
      refreshContext();
      if (!params.has('noobjects') && !objectsRequested) {
        objectsRequested = true;
        worker.postMessage({ type: 'objects-init', small: params.get('objects') === 's' });
      }
    } else if (data.type === 'objects-ready') objectInfo = data;
    else if (data.type === 'objects-result') {
      objectBusy = false;
      push(stats.objectDetect, data.timings.detectMs);
      push(stats.objectEmbed, data.timings.embedMs);
      objectTracks = follow(objectTracks, data.objects, true);
    } else if (data.type === 'result') {
      workerBusy = false;
      stats.frames++;
      push(stats.detect, data.timings.detectMs);
      push(stats.read, data.timings.readMs);
      if (data.embed && data.faces.length) push(stats.embed, data.timings.embedMs / Math.min(4, data.faces.length));
      tracks = follow(tracks, data.faces, data.embed);
    } else if (data.type === 'voice') {
      voiceCounts.results++;
      lastVoice = data;
      if (data.voiceMs) push(stats.voice, data.voiceMs);
      window.liveAsr.setSpeaker(data.id, data.speaker);
    } else if (data.type === 'progress') {
      if (data.scope === 'objects') objectProgress = data; else workerProgress = data;
    } else if (data.type === 'error') {
      if (data.stage.startsWith('objects')) { objectBusy = false; objectError = `${data.stage}: ${data.message}`; return; }
      if (data.stage === 'frame') workerBusy = false;
      workerError = `${data.stage}: ${data.message}`;
    }
  };
  // A worker that fails to load (module error, out of memory) never answers; surface it instead of loading forever.
  worker.onerror = event => { workerError = `worker: ${event.message || 'failed to load'}`; };
  worker.postMessage({ type: 'init', webgpu: 'gpu' in navigator && !params.has('wasm'), threads: threadCount(), identity: !params.has('noid'),
    voice: !params.has('novoice'), voiceWebgpu: params.has('voicegpu') });
}

$('start').addEventListener('click', async () => {
  $('start').disabled = true;
  try {
    const media = await navigator.mediaDevices.getUserMedia({ video: VIDEO(), audio: { echoCancellation: true, noiseSuppression: true } });
    await startAudio(new MediaStream(media.getAudioTracks()));
    await openCamera(new MediaStream(media.getVideoTracks()));
    startWorker();
    $('start').hidden = true;
    $('flip').disabled = false;
  } catch (error) {
    $('start').disabled = false;
    $('hud').textContent = `start failed: ${error.message}`;
  }
});
$('flip').addEventListener('click', () => { camera = camera === 'user' ? 'environment' : 'user'; openCamera(); });
// Read-only snapshot for automated checks and remote debugging.
window.liveDebug = () => ({ worker: workerInfo, error: workerError, context: { people: context.people.length, objects: context.objects.length, error: context.error },
  objectInfo, objectError,
  objects: objectTracks.map(item => ({ box: { x: Math.round(item.box.x), y: Math.round(item.box.y), w: Math.round(item.box.w), h: Math.round(item.box.h) },
    label: item.box.label, reason: item.box.reason, name: winner(item.votes), score: item.score })),
  tracks: tracks.map(item => ({ box: item.box && { x: Math.round(item.box.x), y: Math.round(item.box.y), w: Math.round(item.box.w), h: Math.round(item.box.h) }, label: label(item), score: item.score })),
  caption: { finals: window.liveAsr?.state.finals, partial: window.liveAsr?.state.partial, status: window.liveAsr?.state.status, rtf: window.liveAsr?.rtf() },
  voice: lastVoice && { seconds: lastVoice.seconds, voiceMs: lastVoice.voiceMs, speaker: lastVoice.speaker },
  timings: { detect: average(stats.detect), embed: average(stats.embed), read: average(stats.read), voice: average(stats.voice),
    objectDetect: average(stats.objectDetect), objectEmbed: average(stats.objectEmbed) } });
setInterval(refreshContext, CONTEXT_MS);
setInterval(hud, 500);
requestAnimationFrame(pump);

// Live annotation spike: on-device face boxes with names and streaming captions.
// The only server call is the candidate feature pack (/v1/live/context); frames and audio stay on the device.
const $ = id => document.getElementById(id);
const CONTEXT_MS = 15_000;
const EMBED_MS = 1_000;
const video = $('video'), overlay = $('overlay'), ctx = overlay.getContext('2d');
const stats = { frames: 0, since: performance.now(), detect: [], embed: [], read: [] };
let worker, workerBusy = false, workerInfo = null, workerError = null, camera = 'user', stream, lastEmbed = 0;
let tracks = [], nextTrackId = 1, context = { people: [], at: 0, error: null };

const average = values => values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0;
const push = (list, value) => { list.push(value); if (list.length > 30) list.shift(); };

function iou(a, b) {
  const x1 = Math.max(a.x, b.x), y1 = Math.max(a.y, b.y);
  const x2 = Math.min(a.x + a.w, b.x + b.w), y2 = Math.min(a.y + a.h, b.y + b.h);
  const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  return inter / (a.w * a.h + b.w * b.h - inter || 1);
}

// Greedy IoU tracking keeps a name on a face between the once-a-second identity passes.
function track(faces, embed) {
  const next = [];
  for (const face of faces) {
    let best = null, bestIou = 0.3;
    for (const candidate of tracks) {
      const overlap = iou(face, candidate.box);
      if (overlap > bestIou && !next.includes(candidate)) { best = candidate; bestIou = overlap; }
    }
    const current = best ?? { id: nextTrackId++, votes: [] };
    current.box = face;
    if (embed && face.identity) {
      current.votes = [...current.votes, face.identity].slice(-3);
      current.score = face.identity.score;
    }
    next.push(current);
  }
  tracks = next;
}

// A name is shown once it wins at least two of the last three identity passes.
function label(trackItem) {
  const counts = new Map();
  for (const vote of trackItem.votes) if (vote.id) counts.set(vote.id, { name: vote.name, n: (counts.get(vote.id)?.n ?? 0) + 1 });
  const winner = [...counts.values()].sort((a, b) => b.n - a.n)[0];
  if (winner && winner.n >= Math.min(2, trackItem.votes.length)) return winner.name;
  const last = trackItem.votes.at(-1);
  if (last?.reason === 'small') return 'too small';
  return trackItem.votes.length ? `unknown ${trackItem.score?.toFixed(2) ?? ''}` : '…';
}

function draw() {
  const width = overlay.clientWidth, height = overlay.clientHeight, ratio = devicePixelRatio || 1;
  if (overlay.width !== width * ratio || overlay.height !== height * ratio) { overlay.width = width * ratio; overlay.height = height * ratio; }
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  ctx.clearRect(0, 0, width, height);
  const vw = video.videoWidth, vh = video.videoHeight;
  if (!vw) return;
  // object-fit: cover mapping, mirrored for the front camera to match the preview.
  const scale = Math.max(width / vw, height / vh), dx = (width - vw * scale) / 2, dy = (height - vh * scale) / 2;
  ctx.lineWidth = 2;
  ctx.font = '600 14px -apple-system, system-ui, sans-serif';
  for (const item of tracks) {
    const { x, y, w, h } = item.box;
    let left = dx + x * scale;
    if (camera === 'user') left = width - left - w * scale;
    const top = dy + y * scale, text = label(item), known = !/^(unknown|…|too small)/.test(text);
    ctx.strokeStyle = known ? '#30d158' : 'rgba(255,255,255,.8)';
    ctx.strokeRect(left, top, w * scale, h * scale);
    const textWidth = ctx.measureText(text).width + 12;
    ctx.fillStyle = known ? 'rgba(48,209,88,.85)' : 'rgba(28,28,30,.7)';
    // Keep the name tag inside the view even when the face touches an edge.
    const tagX = Math.min(Math.max(left, 0), width - textWidth), tagY = Math.max(top - 22, 0);
    ctx.fillRect(tagX, tagY, textWidth, 20);
    ctx.fillStyle = '#fff';
    ctx.fillText(text, tagX + 6, tagY + 15);
  }
}

function hud() {
  const asr = window.liveAsr;
  const seconds = (performance.now() - stats.since) / 1000;
  const lines = [
    `face: ${workerError ? `error ${workerError}` : workerInfo ? `${workerInfo.backend} threads=${workerInfo.threads} load=${Math.round(workerInfo.downloadMs)}+${Math.round(workerInfo.sessionMs)}ms` : 'loading models'}`,
    `isolated=${crossOriginIsolated} webgpu=${'gpu' in navigator} cores=${navigator.hardwareConcurrency ?? '?'} video=${video.videoWidth}x${video.videoHeight}`,
    `detect ${average(stats.detect).toFixed(0)}ms read ${average(stats.read).toFixed(0)}ms · ${(stats.frames / seconds || 0).toFixed(1)} fps · embed ${average(stats.embed).toFixed(0)}ms`,
    `context: ${context.error ? `error ${context.error}` : `${context.people.filter(p => p.face?.length).length}/${context.people.length} people with faces, ${context.at ? Math.round((Date.now() - context.at) / 1000) + 's ago' : 'pending'}`}`,
    `asr: ${asr?.state.status ?? 'missing'} rtf=${asr ? asr.rtf().toFixed(2) : '-'}`,
  ];
  $('hud').textContent = lines.join('\n');
  if (seconds > 5) { stats.frames = 0; stats.since = performance.now(); }
}

async function refreshContext() {
  try {
    const response = await fetch('/v1/live/context', { cache: 'no-store', credentials: 'same-origin' });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const body = await response.json();
    context = { people: body.people ?? [], at: Date.now(), error: null };
    worker?.postMessage({ type: 'context', people: context.people, thresholds: body.thresholds });
  } catch (error) { context.error = error.message; }
}

async function pump() {
  requestAnimationFrame(pump);
  draw();
  if (!worker || workerBusy || !workerInfo || video.readyState < 2) return;
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
  window.liveAsr.state.onText = (finals, partial) => {
    $('final').textContent = finals.join(' ') + (finals.length && partial ? ' ' : '');
    $('partial').textContent = partial;
  };
}

function startWorker() {
  worker = new Worker('/live/face-worker.js', { type: 'module' });
  worker.onmessage = ({ data }) => {
    if (data.type === 'ready') { workerInfo = data; refreshContext(); }
    else if (data.type === 'result') {
      workerBusy = false;
      stats.frames++;
      push(stats.detect, data.timings.detectMs);
      push(stats.read, data.timings.readMs);
      if (data.embed && data.faces.length) push(stats.embed, data.timings.embedMs / Math.min(4, data.faces.length));
      track(data.faces, data.embed);
    } else if (data.type === 'error') { workerBusy = false; workerError = `${data.stage}: ${data.message}`; }
  };
  const threads = crossOriginIsolated ? Math.min(4, navigator.hardwareConcurrency || 2) : 1;
  worker.postMessage({ type: 'init', webgpu: 'gpu' in navigator && !new URLSearchParams(location.search).has('wasm'), threads });
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
window.liveDebug = () => ({ worker: workerInfo, error: workerError, context: { people: context.people.length, error: context.error },
  tracks: tracks.map(item => ({ box: item.box && { x: Math.round(item.box.x), y: Math.round(item.box.y), w: Math.round(item.box.w), h: Math.round(item.box.h) }, label: label(item), score: item.score })),
  caption: { finals: window.liveAsr?.state.finals, partial: window.liveAsr?.state.partial, status: window.liveAsr?.state.status, rtf: window.liveAsr?.rtf() },
  timings: { detect: average(stats.detect), embed: average(stats.embed), read: average(stats.read) } });
setInterval(refreshContext, CONTEXT_MS);
setInterval(hud, 500);
requestAnimationFrame(pump);

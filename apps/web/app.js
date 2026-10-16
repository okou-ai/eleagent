import { CaptureState, CLIP_MS, MAX_CLIP_BYTES, bufferHasRoom, bufferRecovered, captureCamera, formatAgo, formatElapsed,
  newCaptureId, recorderType, resumesAutomatically, uploadDisposition } from './capture-state.js';
import { openQueue } from './queue.js';

const $ = id => document.getElementById(id);
const CAMERA_KEY = 'eleagent-camera';
const STORAGE_FULL = 'Storage full';
const state = new CaptureState();
let queue, stream, recorder, wakeLock, clipTimer, locationWatch, locationFix, ticker, releaseTab, uploadTimer;
let session = null, ready = false, flipping = false, uploading = false, requestingWake = false;
let fatal = null, problem = null, rejected = false, uploadIssue = null;
let pending = { count: 0, bytes: 0 };
let recordedMs = 0, recordingSince = 0;
let observation = null, observationTag = null, observationTimer, observing = false;
let camera = remembered(CAMERA_KEY) === 'front' ? 'front' : 'back';

function remembered(key) {
  try { return localStorage.getItem(key); } catch { return null; }
}
function remember(key, value) {
  try { localStorage.setItem(key, value); } catch { /* Private browsing can refuse storage; the value still lasts this visit. */ }
}

// Earlier versions kept an access token from a #token= link. Drop both; uploads need no credentials.
try { localStorage.removeItem('eleagent-token'); } catch { /* Storage may be unavailable. */ }
if (window.location.hash) history.replaceState(history.state, '', window.location.pathname + window.location.search);

function elapsed() {
  return recordedMs + (recordingSince ? performance.now() - recordingSince : 0);
}
function statusView() {
  if (fatal) return { text: fatal, tone: 'error' };
  if (!ready) return { text: '' };
  if (rejected) return { text: 'Upload rejected', tone: 'error' };
  let view;
  if (state.phase === 'recording' && !flipping) view = { text: formatElapsed(elapsed()), tone: 'live' };
  else if (problem) view = { text: problem, tone: 'error' };
  else if (state.phase === 'paused' && !flipping) view = { text: 'Paused' };
  else view = { text: 'Starting' };
  if (uploadIssue && pending.count) view.text += ` · ${pending.count} waiting`;
  return view;
}
function render() {
  const view = statusView();
  $('status').textContent = view.text;
  $('status').dataset.tone = view.tone || '';
  const active = ['recording', 'acquiring'].includes(state.phase) || flipping;
  $('shutter').classList.toggle('recording', active);
  $('shutter').setAttribute('aria-label', active ? 'Pause' : 'Record');
  $('shutter').disabled = !ready || rejected || !!fatal;
  $('flip').disabled = !ready || !!fatal || flipping;
}
async function refreshQueue() {
  pending = await queue.stats();
  render();
}

async function requestWakeLock() {
  if (!navigator.wakeLock || state.phase !== 'recording' || document.hidden || wakeLock || requestingWake) return;
  requestingWake = true;
  try {
    const lock = await navigator.wakeLock.request('screen');
    if (state.phase !== 'recording' || document.hidden) { await lock.release(); return; }
    wakeLock = lock;
    lock.addEventListener('release', () => { if (wakeLock === lock) wakeLock = null; });
  } catch { /* Some browsers grant the lock only after a tap; the next tap retries. */ } finally { requestingWake = false; }
}
function stopDevices() {
  clearTimeout(clipTimer);
  clearInterval(ticker);
  if (recordingSince) recordedMs += performance.now() - recordingSince;
  recordingSince = 0;
  if (recorder?.state !== 'inactive') {
    try { recorder?.stop(); } catch { /* A track end may have already stopped the recorder. */ }
  }
  if (locationWatch !== undefined) navigator.geolocation.clearWatch(locationWatch);
  locationWatch = undefined;
  locationFix = null;
  stream?.getTracks().forEach(track => track.stop());
  stream = null;
  $('preview').srcObject = null;
  const lock = wakeLock;
  wakeLock = null;
  lock?.release().catch(() => {});
}
function pause(reason, interruption = 'Camera interrupted') {
  if (!['recording', 'acquiring'].includes(state.phase)) return;
  state.pause(reason);
  stopDevices();
  problem = reason === 'buffer_full' ? STORAGE_FULL : reason === 'capture_interrupted' ? (problem || interruption) : null;
  render();
}
function watchLocation() {
  if (!navigator.geolocation) return;
  locationWatch = navigator.geolocation.watchPosition(position => {
    const c = position.coords;
    locationFix = { captured_at: new Date(position.timestamp).toISOString(), latitude: c.latitude, longitude: c.longitude,
      accuracy_m: c.accuracy, altitude_m: c.altitude, altitude_accuracy_m: c.altitudeAccuracy,
      heading_deg: Number.isFinite(c.heading) ? c.heading : null, speed_mps: Number.isFinite(c.speed) && c.speed >= 0 ? c.speed : null };
  }, () => { locationFix = null; }, { enableHighAccuracy: false, maximumAge: 10_000, timeout: 15_000 });
}

function recordOne(activeStream, lens) {
  return new Promise((resolve, reject) => {
    const mimeType = recorderType(MediaRecorder);
    const current = new MediaRecorder(activeStream, { ...(mimeType ? { mimeType } : {}), videoBitsPerSecond: 1_200_000, audioBitsPerSecond: 64_000 });
    recorder = current;
    const parts = [];
    let meta, started = 0, failed = false;
    current.onstart = () => {
      if (state.phase !== 'recording') { current.stop(); return; }
      started = performance.now();
      meta = state.clip(lens);
      if (locationFix && Date.now() - Date.parse(locationFix.captured_at) < 30_000) meta.locations.push(locationFix);
      clipTimer = setTimeout(() => { if (current.state === 'recording') current.stop(); }, CLIP_MS);
    };
    current.ondataavailable = event => { if (event.data.size) parts.push(event.data); };
    current.onerror = () => { failed = true; };
    current.onstop = () => {
      clearTimeout(clipTimer);
      if (recorder === current) recorder = null;
      if (!meta) { resolve(null); return; }
      const duration = performance.now() - started;
      meta.captured_end_at = new Date().toISOString();
      if (failed) { reject(new Error('recording_failed')); return; }
      // Mobile browsers can defer timers while suspended. Never disguise a long segment as a five-second clip.
      if (duration > 6400) { reject(new Error('recording_suspended')); return; }
      const blob = new Blob(parts, { type: current.mimeType || parts[0]?.type || 'application/octet-stream' });
      if (duration < 200 || !blob.size) { resolve(null); return; }
      if (blob.size > MAX_CLIP_BYTES) { reject(new Error('clip_too_large')); return; }
      resolve({ meta, blob });
    };
    // Each recorder is new: every clip has its own container header and is independently decodable.
    current.start();
  });
}
async function captureLoop(activeStream, epoch, lens) {
  try {
    while (state.phase === 'recording' && state.epoch === epoch) {
      await refreshQueue();
      if (!bufferHasRoom(pending)) { pause('buffer_full'); break; }
      const clip = await recordOne(activeStream, lens);
      if (clip) {
        await queue.add(clip.meta, clip.blob);
        await refreshQueue();
        void upload();
      }
    }
  } catch (error) {
    if (error.message === 'buffer_full') pause('buffer_full');
    else pause('capture_interrupted', error.name === 'QuotaExceededError' ? STORAGE_FULL : 'Recording stopped');
  } finally {
    if (state.phase === 'recording' && state.epoch === epoch) pause('capture_interrupted');
  }
}

function start() {
  session ||= record().finally(() => {
    session = null;
    render();
    resumeIfAllowed();
  });
  return session;
}
async function record() {
  if (!ready || rejected || fatal || !['idle', 'paused'].includes(state.phase)) return;
  // A start requested in the background waits for the page to return.
  if (document.hidden) { state.pause('page_hidden'); return; }
  try { await refreshQueue(); } catch { fatal = 'Storage unavailable'; ready = false; return; }
  if (!bufferHasRoom(pending)) { problem = STORAGE_FULL; return; }
  // Resuming the same lens continues its capture; a different lens is a new capture.
  const resume = state.phase === 'paused' && captureCamera(state.captureId) === camera;
  const epoch = state.acquire(resume ? state.captureId : newCaptureId(camera));
  problem = null;
  render();
  try {
    const acquired = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: camera === 'front' ? 'user' : 'environment' },
      width: { ideal: 960 }, height: { ideal: 720 }, frameRate: { ideal: 15, max: 24 } }, audio: true });
    if (document.hidden) state.pause('page_hidden');
    if (!state.activate(epoch)) { acquired.getTracks().forEach(track => track.stop()); return; }
    stream = acquired;
    const facing = acquired.getVideoTracks()[0]?.getSettings().facingMode;
    const lens = facing === 'user' ? 'front' : facing === 'environment' ? 'back' : camera;
    if (lens !== captureCamera(state.captureId) && state.nextSeq === 0) {
      state.captureId = state.captureId.replace(/-(front|back)$/, `-${lens}`);
    }
    camera = lens;
    acquired.getTracks().forEach(track => track.addEventListener('ended', () => pause('capture_interrupted')));
    $('preview').classList.toggle('mirrored', lens === 'front');
    $('preview').srcObject = acquired;
    await $('preview').play().catch(() => {});
    if (state.phase !== 'recording' || state.epoch !== epoch) { stopDevices(); return; }
    recordingSince = performance.now();
    ticker = setInterval(render, 500);
    void requestWakeLock();
    watchLocation();
    render();
    await captureLoop(acquired, epoch, lens);
  } catch (error) {
    if (state.epoch === epoch) {
      state.pause('capture_interrupted');
      stopDevices();
      problem = error?.name === 'NotAllowedError' ? 'Allow camera access' : 'Camera unavailable';
    }
  }
}
function resumeIfAllowed() {
  if (session || flipping || !ready || rejected || fatal || document.hidden) return;
  if (problem === STORAGE_FULL || state.pauseReason === 'buffer_full') {
    if (bufferRecovered(pending)) void start();
  } else if (state.phase === 'idle' ? !problem : state.phase === 'paused' && resumesAutomatically(state.pauseReason)) {
    void start();
  }
}
function toggle() {
  if (['recording', 'acquiring'].includes(state.phase)) pause('user_pause');
  else void start();
}
async function flip() {
  if (!ready || flipping) return;
  camera = camera === 'back' ? 'front' : 'back';
  remember(CAMERA_KEY, camera);
  $('flip').classList.toggle('turned');
  // While paused, or before a pending start acquires the camera, the next start uses the new lens.
  if (!['recording', 'acquiring'].includes(state.phase)) { render(); return; }
  flipping = true;
  render();
  try {
    // Finish the current clip, then start a new capture on the other lens.
    pause('user_pause');
    await session;
  } finally {
    flipping = false;
  }
  void start();
}

async function upload() {
  if (!ready || uploading || rejected) return;
  if (!navigator.onLine) { uploadIssue = 'offline'; render(); return; }
  uploading = true;
  clearTimeout(uploadTimer);
  try {
    while (!rejected && navigator.onLine) {
      const item = await queue.first();
      if (!item) break;
      const body = new FormData();
      body.set('meta', JSON.stringify(item.meta));
      body.set('video', item.blob, item.blob.type.includes('webm') ? 'clip.webm' : 'clip.mp4');
      const abort = new AbortController();
      const timeout = setTimeout(() => abort.abort(), 70_000);
      let response;
      try {
        response = await fetch('/', { method: 'POST', body, signal: abort.signal, credentials: 'omit' });
      } finally { clearTimeout(timeout); }
      if (!response.ok) {
        if (uploadDisposition(response.status) === 'blocked') {
          // A rejected clip stays in the local buffer; reloading the page retries it.
          rejected = true;
          pause('capture_interrupted');
          break;
        }
        throw new Error('retry_upload');
      }
      const receipt = await response.json();
      if (receipt.archived !== true || receipt.capture_id !== item.meta.capture_id || receipt.clip_seq !== item.meta.clip_seq || !receipt.media_id) {
        throw new Error('archive_receipt_missing');
      }
      await queue.remove(item);
      uploadIssue = null;
      await refreshQueue();
      resumeIfAllowed();
    }
    if (!navigator.onLine) uploadIssue = 'offline';
  } catch {
    uploadIssue = 'retry';
    if (navigator.onLine) uploadTimer = setTimeout(() => void upload(), 5000);
  } finally {
    uploading = false;
    await refreshQueue().catch(() => {});
  }
}

// The latest MiniCPM observation is polled separately from uploads, so it keeps updating while paused.
async function pollObservation() {
  clearTimeout(observationTimer);
  if (observing || document.hidden) return;
  observing = true;
  try {
    const response = await fetch('/v1/observations/latest', { cache: 'no-store', credentials: 'omit',
      headers: observationTag ? { 'If-None-Match': observationTag } : {} });
    if (response.status === 200) {
      observation = await response.json();
      observationTag = response.headers.get('ETag');
    } else if (response.status === 204) {
      observation = observationTag = null;
    }
  } catch { /* Keep the last observation; the next poll retries. */ } finally { observing = false; }
  renderObservation();
  if (!document.hidden) observationTimer = setTimeout(() => void pollObservation(), 3000);
}
function renderObservation() {
  $('observation').hidden = !observation;
  if (!observation) return;
  const at = Date.parse(observation.captured_to || observation.observed_at);
  $('observation-age').textContent = Number.isFinite(at) ? formatAgo(at) : '';
  if ($('observation-text').textContent !== observation.text) $('observation-text').textContent = observation.text;
}
setInterval(renderObservation, 1000);

$('shutter').addEventListener('click', toggle);
$('flip').addEventListener('click', () => void flip());
document.addEventListener('pointerdown', () => void requestWakeLock());
document.addEventListener('visibilitychange', () => {
  if (document.hidden) { pause('page_hidden'); return; }
  void upload();
  void pollObservation();
  resumeIfAllowed();
  void requestWakeLock();
});
window.addEventListener('focus', () => void requestWakeLock());
window.addEventListener('online', () => { uploadIssue = null; render(); void upload(); });
window.addEventListener('offline', () => { uploadIssue = 'offline'; render(); });
window.addEventListener('pagehide', () => { pause('page_hidden'); ready = false; releaseTab?.(); });
window.addEventListener('pageshow', event => { if (event.persisted) window.location.reload(); });
window.addEventListener('beforeunload', event => {
  if (pending.count || ['recording', 'acquiring'].includes(state.phase)) { event.preventDefault(); event.returnValue = ''; }
});

async function initialize() {
  if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia || !window.MediaRecorder || !window.indexedDB || !navigator.locks) {
    fatal = 'Open in Safari or Chrome over HTTPS';
    render();
    return;
  }
  // One tab owns capture and uploads. This prevents two pages from deleting or sending the same local queue.
  await navigator.locks.request('eleagent-capture-owner', { ifAvailable: true }, async lock => {
    if (!lock) { fatal = 'Already open in another tab'; render(); return; }
    try {
      queue = await openQueue();
      ready = true;
      await refreshQueue();
      void upload();
      resumeIfAllowed();
      await new Promise(resolve => { releaseTab = resolve; });
    } catch {
      ready = false;
      fatal = 'Storage unavailable';
      render();
    }
  });
}
render();
void pollObservation();
void initialize();

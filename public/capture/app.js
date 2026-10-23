import { CaptureState, CLIP_MS, MAX_CLIP_BYTES, bufferHasRoom, bufferRecovered, captureCamera, formatElapsed,
  newCaptureId, recorderType, resumesAutomatically, uploadDisposition } from './capture-state.js';
import { openQueue } from './queue.js';
import { setupOkou } from './okou.js';

const $ = id => document.getElementById(id);
const CAMERA_KEY = 'eleagent-camera';
const STORAGE_FULL = 'Storage full';
const state = new CaptureState();
let queue, stream, recorder, wakeLock, clipTimer, locationWatch, locationFix, ticker, releaseTab, uploadTimer;
let session = null, ready = false, flipping = false, uploading = false, requestingWake = false;
let fatal = null, problem = null, blocked = null, uploadIssue = null, leaving = false;
let pending = { count: 0, bytes: 0 };
let recordedMs = 0, recordingSince = 0;
let camera = remembered(CAMERA_KEY) === 'front' ? 'front' : 'back';

function remembered(key) {
  try { return localStorage.getItem(key); } catch { return null; }
}
function remember(key, value) {
  try { localStorage.setItem(key, value); } catch { /* Private browsing can refuse storage; the value still lasts this visit. */ }
}

// Leaves the page for another one, after the recorder has stopped and its last segment is safely queued.
function leaveFor(url, reason) {
  pause(reason);
  render();
  void Promise.resolve(session).catch(() => {}).then(() => {
    leaving = true;
    window.location.assign(url);
  });
}

// The server owns the session cookie; the page never handles credentials.
function signIn() {
  if (blocked === 'auth') return;
  blocked = 'auth';
  clearTimeout(uploadTimer);
  leaveFor('/login?return_to=/', 'capture_interrupted');
}

// The Okou mark: grey until Eleagent is connected to the owner's Okou (requests said to Okou go there), in colour once
// it is. Grey goes to Okou to approve and comes back here; colour opens the account page, where Okou is managed.
async function okouStatus() {
  try {
    const response = await fetch('/api/okou/status', { cache: 'no-store' });
    const connected = response.ok && (await response.json()).connected === true;
    $('okou').dataset.connected = String(connected);
    $('okou').setAttribute('aria-label', connected ? 'Okou connected' : 'Connect Okou');
  } catch { /* offline: keep the last state */ }
}
// Grey goes to Okou to approve; once connected, a tap talks to Okou (okou.js) and a long press opens /account.
const okouConnected = () => $('okou').dataset.connected === 'true';
const okou = setupOkou({
  $, connected: okouConnected, recordingStream: () => stream,
  captureId: () => (['recording', 'acquiring'].includes(state.phase) ? state.captureId : null),
  onModeChange: () => render(),
  onDisconnected: () => void okouStatus(),
});
let okouPress = null, okouLongPress = false;
function openOkou() {
  if (okouLongPress) return;
  if (!okouConnected()) leaveFor('/api/okou/connect?return_to=/', 'user_pause');
  else okou.tap();
}
function pressOkou() {
  okouLongPress = false;
  clearTimeout(okouPress);
  okouPress = setTimeout(() => {
    if (!okouConnected() || okou.active()) return;
    okouLongPress = true;
    leaveFor('/account', 'user_pause');
  }, 650);
}
function sessionExpired(response) {
  return response.type === 'opaqueredirect' || response.status === 401 || response.status === 403 ||
    (response.status >= 300 && response.status < 400 && response.status !== 304);
}

function elapsed() {
  return recordedMs + (recordingSince ? performance.now() - recordingSince : 0);
}
function statusView() {
  if (fatal) return { text: fatal, tone: 'error' };
  if (!ready) return { text: '' };
  if (blocked === 'auth') return { text: 'Session expired · Sign in to resume. Saved clips remain on this device.', tone: 'error' };
  if (blocked === 'clip') return { text: 'Upload rejected', tone: 'error' };
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
  $('shutter').disabled = !ready || !!blocked || !!fatal;
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
  okou.recordingStopped();
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
  if (!ready || blocked || fatal || !['idle', 'paused'].includes(state.phase)) return;
  // A start requested in the background waits for the page to return.
  if (document.hidden) { state.pause('page_hidden'); return; }
  try { await refreshQueue(); } catch { fatal = 'Storage unavailable'; ready = false; return; }
  // A concurrent upload may have expired the session while storage was loading.
  if (!ready || blocked || fatal) return;
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
    // The same microphone feeds "Hey Okou".
    void okou.attach(acquired).catch(() => {});
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
  if (session || flipping || !ready || blocked || fatal || document.hidden) return;
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

function post(path, payload, signal) {
  return fetch(path, { method: 'POST', body: JSON.stringify(payload), headers: { 'Content-Type': 'application/json' },
    signal, credentials: 'same-origin', redirect: 'manual' });
}
// A clip goes straight from the page into private Blob storage: the server signs a one-clip upload URL, then records
// the clip once it is stored. Returns { receipt } or, when the server refuses a step, { response }.
async function send(item, signal) {
  const contentType = item.blob.type.includes('webm') ? 'video/webm' : 'video/mp4';
  let response = await post('/api/clips/prepare', { meta: item.meta, content_type: contentType, size: item.blob.size }, signal);
  if (!response.ok) return { response };
  const plan = await response.json();
  if (plan.receipt) return { receipt: plan.receipt };
  const stored = await fetch(plan.upload_url, { method: 'PUT', headers: { 'Content-Type': contentType }, body: item.blob, signal });
  if (!stored.ok) throw new Error('blob_upload_failed');
  response = await post('/api/clips/commit', { meta: item.meta, pathname: plan.pathname }, signal);
  if (!response.ok) return { response };
  return { receipt: (await response.json()).receipt };
}

async function upload() {
  if (!ready || uploading || blocked) return;
  if (!navigator.onLine) { uploadIssue = 'offline'; render(); return; }
  uploading = true;
  clearTimeout(uploadTimer);
  try {
    while (!blocked && navigator.onLine) {
      const item = await queue.first();
      if (!item) break;
      const abort = new AbortController();
      const timeout = setTimeout(() => abort.abort(), 70_000);
      let outcome;
      try {
        outcome = await send(item, abort.signal);
      } finally { clearTimeout(timeout); }
      if (outcome.response) {
        if (sessionExpired(outcome.response)) { signIn(); break; }
        if (uploadDisposition(outcome.response.status) === 'blocked') {
          // A rejected clip stays in the local buffer; reloading retries it.
          blocked = 'clip';
          pause('capture_interrupted');
          break;
        }
        throw new Error('retry_upload');
      }
      const receipt = outcome.receipt;
      if (receipt?.archived !== true || receipt.capture_id !== item.meta.capture_id || receipt.clip_seq !== item.meta.clip_seq || !receipt.media_id) {
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

$('shutter').addEventListener('click', toggle);
$('okou').addEventListener('click', openOkou);
$('okou').addEventListener('pointerdown', pressOkou);
for (const type of ['pointerup', 'pointercancel', 'pointerleave']) $('okou').addEventListener(type, () => clearTimeout(okouPress));
$('okou-cancel').addEventListener('click', () => okou.cancel());
$('flip').addEventListener('click', () => void flip());
document.addEventListener('pointerdown', () => void requestWakeLock());
document.addEventListener('visibilitychange', () => {
  if (document.hidden) { pause('page_hidden'); return; }
  void okouStatus();
  void upload();
  resumeIfAllowed();
  void requestWakeLock();
});
window.addEventListener('focus', () => void requestWakeLock());
window.addEventListener('online', () => { uploadIssue = null; render(); void upload(); });
window.addEventListener('offline', () => { uploadIssue = 'offline'; render(); });
window.addEventListener('pagehide', () => { pause('page_hidden'); ready = false; releaseTab?.(); });
window.addEventListener('pageshow', event => { if (event.persisted) window.location.reload(); });
window.addEventListener('beforeunload', event => {
  // The sign-in navigation already waits for the last segment to be durably queued.
  if (leaving) return;
  if (session || pending.count || ['recording', 'acquiring'].includes(state.phase)) { event.preventDefault(); event.returnValue = ''; }
});

async function initialize() {
  void okouStatus();
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
void initialize();

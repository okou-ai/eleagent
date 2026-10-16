import { CaptureState, CLIP_MS, MAX_CLIP_BYTES, MAX_QUEUE_BYTES, MAX_QUEUE_CLIPS, recorderType, uploadDisposition } from './capture-state.js';
import { openQueue } from './queue.js';

const $ = id => document.getElementById(id);
const state = new CaptureState();
let queue, stream, recorder, wakeLock, clipTimer, locationWatch, locationFix, sessionCamera;
let recordingLoop, releaseTab, uploadTimer, uploading = false, uploadBlocked = false, ready = false, starting = false;
let pending = { count: 0, bytes: 0 }, requestingWake = false;

function consumeTokenLink() {
  const token = new URLSearchParams(window.location.hash.slice(1)).get('token');
  if (token === null) return;
  $('token').value = token;
  history.replaceState(history.state, '', window.location.pathname + window.location.search);
  uploadBlocked = false;
  clearTimeout(uploadTimer);
  render();
  if (ready) {
    const hasToken = token.trim().length >= 16;
    message(hasToken
      ? (pending.count ? 'Access token is ready. Pending clips will upload when connected.' : 'Access token is ready.')
      : 'Enter your service access token first.', !hasToken);
    void upload();
  }
}
consumeTokenLink();

function message(text, error = false) {
  $('message').textContent = text;
  $('message').classList.toggle('error', error);
}
function render() {
  const active = state.phase === 'recording';
  $('capture-status').textContent = { idle: 'Ready', acquiring: 'Opening camera', recording: 'Recording', paused: 'Paused' }[state.phase];
  $('capture-status').classList.toggle('active', active);
  $('live-badge').hidden = !active;
  $('start').textContent = state.phase === 'paused' ? 'Resume recording' : 'Start recording';
  $('start').disabled = !ready || !['idle', 'paused'].includes(state.phase) || !!recordingLoop || starting || $('token').value.trim().length < 16 || uploadBlocked;
  $('pause').disabled = !['recording', 'acquiring'].includes(state.phase);
  $('stop').disabled = state.phase === 'idle' && !recordingLoop;
  $('camera').disabled = state.phase !== 'idle' || !!recordingLoop;
  $('location').disabled = state.phase !== 'idle' || !!recordingLoop;
  $('retry').disabled = !ready || !pending.count || uploading || $('token').value.trim().length < 16;
  $('discard').disabled = !ready || !pending.count || uploading || state.phase !== 'idle' || !!recordingLoop;
  $('queue-status').textContent = `${pending.count} clips · ${(pending.bytes / 1024 / 1024).toFixed(1)} / 128 MiB`;
}
async function refreshQueue() {
  pending = await queue.stats();
  render();
}
function hasRoom() {
  // Reserve one maximum-size clip before starting so a full buffer never drops a completed clip.
  return pending.count < MAX_QUEUE_CLIPS && pending.bytes + MAX_CLIP_BYTES <= MAX_QUEUE_BYTES;
}
async function requestWakeLock() {
  if (!navigator.wakeLock) {
    $('wake-status').textContent = 'Unavailable — adjust auto-lock';
    return;
  }
  if (state.phase !== 'recording' || document.hidden || wakeLock || requestingWake) return;
  requestingWake = true;
  try {
    const lock = await navigator.wakeLock.request('screen');
    if (state.phase !== 'recording' || document.hidden) { await lock.release(); return; }
    wakeLock = lock;
    $('wake-status').textContent = 'Kept awake';
    lock.addEventListener('release', () => {
      if (wakeLock === lock) {
        wakeLock = null;
        $('wake-status').textContent = state.phase === 'recording' ? 'Released by system' : 'Not requested';
      }
    });
  } catch {
    $('wake-status').textContent = 'Unavailable — adjust auto-lock';
  } finally { requestingWake = false; }
}
function releaseWakeLock() {
  const lock = wakeLock;
  wakeLock = null;
  lock?.release().catch(() => {});
  $('wake-status').textContent = 'Not requested';
}
function stopDevices() {
  clearTimeout(clipTimer);
  if (recorder?.state !== 'inactive') {
    try { recorder?.stop(); } catch { /* A track end may have already stopped the recorder. */ }
  }
  if (locationWatch !== undefined) navigator.geolocation.clearWatch(locationWatch);
  locationWatch = undefined;
  locationFix = null;
  stream?.getTracks().forEach(track => track.stop());
  stream = null;
  $('preview').srcObject = null;
  $('preview-placeholder').hidden = false;
  releaseWakeLock();
}
function pause(reason = 'user_pause') {
  if (!['recording', 'acquiring'].includes(state.phase)) return;
  state.pause(reason);
  stopDevices();
  message(reason === 'page_hidden' ? 'Capture paused when the page left the foreground. Tap Resume to begin a new segment.' :
    reason === 'buffer_full' ? 'Local buffer is nearly full. Capture is paused; let uploads finish, then tap Resume.' :
    reason === 'capture_interrupted' ? 'Capture was interrupted. Check camera access, then tap Resume.' : 'Capture paused. Pending clips continue uploading.');
  render();
}
function stop() {
  state.stop();
  stopDevices();
  message('Camera and microphone are off. Pending clips continue uploading.');
  render();
}
function watchLocation() {
  if (!$('location').checked || !navigator.geolocation) return;
  $('location-status').textContent = 'Requesting location permission…';
  locationWatch = navigator.geolocation.watchPosition(position => {
    const c = position.coords;
    locationFix = { captured_at: new Date(position.timestamp).toISOString(), latitude: c.latitude, longitude: c.longitude,
      accuracy_m: c.accuracy, altitude_m: c.altitude, altitude_accuracy_m: c.altitudeAccuracy,
      heading_deg: Number.isFinite(c.heading) ? c.heading : null, speed_mps: Number.isFinite(c.speed) && c.speed >= 0 ? c.speed : null };
    $('location-status').textContent = `Location included (accuracy about ${Math.round(c.accuracy)} m). No device motion.`;
  }, () => {
    locationFix = null;
    $('location-status').textContent = 'Location unavailable. Recording continues without it.';
  }, { enableHighAccuracy: false, maximumAge: 10_000, timeout: 15_000 });
}
function recordOne(activeStream, camera) {
  return new Promise((resolve, reject) => {
    const mimeType = recorderType(MediaRecorder);
    const current = new MediaRecorder(activeStream, { ...(mimeType ? { mimeType } : {}), videoBitsPerSecond: 1_200_000, audioBitsPerSecond: 64_000 });
    recorder = current;
    const parts = [];
    let meta, started = 0, failed = false;
    current.onstart = () => {
      if (state.phase !== 'recording') { current.stop(); return; }
      started = performance.now();
      meta = state.clip(camera);
      if (locationFix && Date.now() - Date.parse(locationFix.captured_at) < 30_000) meta.locations.push(locationFix);
      clipTimer = setTimeout(() => { if (current.state === 'recording') current.stop(); }, CLIP_MS);
    };
    current.ondataavailable = event => { if (event.data.size) parts.push(event.data); };
    current.onerror = () => { failed = true; };
    current.onstop = () => {
      clearTimeout(clipTimer);
      if (recorder === current) recorder = null;
      if (!meta) { resolve(null); return; }
      const elapsed = performance.now() - started;
      meta.captured_end_at = new Date().toISOString();
      if (failed) { reject(new Error('recording_failed')); return; }
      // Mobile browsers can defer timers while suspended. Never disguise a long segment as a five-second clip.
      if (elapsed > 6400) { reject(new Error('recording_suspended')); return; }
      const blob = new Blob(parts, { type: current.mimeType || parts[0]?.type || 'application/octet-stream' });
      if (elapsed < 200 || !blob.size) { resolve(null); return; }
      if (blob.size > MAX_CLIP_BYTES) { reject(new Error('clip_too_large')); return; }
      resolve({ meta, blob });
    };
    // Each recorder is new: every clip has its own container header and is independently decodable.
    current.start();
  });
}
async function captureLoop(activeStream, epoch) {
  try {
    while (state.phase === 'recording' && state.epoch === epoch) {
      await refreshQueue();
      if (!hasRoom()) { pause('buffer_full'); break; }
      if (state.phase !== 'recording' || state.epoch !== epoch) break;
      const clip = await recordOne(activeStream, sessionCamera);
      if (clip) {
        await queue.add(clip.meta, clip.blob);
        await refreshQueue();
        void upload();
      }
    }
  } catch (error) {
    pause(error.message === 'buffer_full' ? 'buffer_full' : 'capture_interrupted');
    const storageError = error.name === 'QuotaExceededError';
    message(storageError ? 'Browser storage is full. The last segment could not be saved; capture has stopped.' :
      'Capture stopped because the last segment could not be safely saved. A recording gap is present. Resume when ready.', true);
  } finally {
    if (state.phase === 'recording') pause('capture_interrupted');
  }
}
async function start() {
  if (!ready || recordingLoop || starting || document.hidden || !['idle', 'paused'].includes(state.phase)) return;
  if ($('token').value.trim().length < 16) { message('Enter your service access token first.', true); return; }
  starting = true;
  render();
  try { await refreshQueue(); } catch {
    starting = false;
    ready = false;
    message("The local buffer could not be read. Capture is disabled to protect pending clips.", true);
    render();
    return;
  }
  if (document.hidden || !ready) { starting = false; render(); return; }
  if (!hasRoom()) { message('The local buffer is nearly full. Upload or discard pending clips before recording.', true); starting = false; render(); return; }
  sessionCamera = $('camera').value;
  const id = state.phase === 'paused' ? state.captureId : `web-${crypto.randomUUID()}-${sessionCamera}`;
  const epoch = state.acquire(id);
  render();
  message('Allow camera and microphone access to begin.');
  try {
    const acquired = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: sessionCamera === 'front' ? 'user' : 'environment' },
      width: { ideal: 960 }, height: { ideal: 720 }, frameRate: { ideal: 15, max: 24 } }, audio: true });
    if (document.hidden) state.pause('page_hidden');
    if (!state.activate(epoch)) { acquired.getTracks().forEach(track => track.stop()); return; }
    stream = acquired;
    const actualFacing = acquired.getVideoTracks()[0]?.getSettings().facingMode;
    if (actualFacing === 'user') sessionCamera = 'front';
    if (actualFacing === 'environment') sessionCamera = 'back';
    // The observer also reads the camera direction from the capture identity.
    state.captureId = state.captureId.replace(/-(front|back)$/, `-${sessionCamera}`);
    acquired.getTracks().forEach(track => track.addEventListener('ended', () => pause('capture_interrupted')));
    $('preview').srcObject = acquired;
    $('preview-placeholder').hidden = true;
    await $('preview').play().catch(() => {});
    if (state.phase !== 'recording' || state.epoch !== epoch) { stopDevices(); return; }
    void requestWakeLock();
    watchLocation();
    message('Recording independent five-second segments. Keep this page in the foreground.');
    render();
    recordingLoop = captureLoop(acquired, epoch);
    await recordingLoop;
  } catch {
    if (state.epoch === epoch) {
      state.pause('capture_interrupted');
      stopDevices();
      message('Camera or microphone access failed. Check browser permissions, then tap Resume.', true);
    }
  } finally {
    recordingLoop = null;
    starting = false;
    render();
  }
}
async function upload() {
  if (!ready || uploading || uploadBlocked || !navigator.onLine || $('token').value.trim().length < 16) return;
  uploading = true;
  clearTimeout(uploadTimer);
  render();
  try {
    while (!uploadBlocked && navigator.onLine) {
      const item = await queue.first();
      if (!item) break;
      const token = $('token').value.trim();
      if (token.length < 16) break;
      const body = new FormData();
      body.set('meta', JSON.stringify(item.meta));
      body.set('video', item.blob, item.blob.type.includes('webm') ? 'clip.webm' : 'clip.mp4');
      const abort = new AbortController();
      const timeout = setTimeout(() => abort.abort(), 70_000);
      let response;
      try {
        response = await fetch('/', { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body, signal: abort.signal, credentials: 'omit' });
      } finally { clearTimeout(timeout); }
      if (!response.ok) {
        const disposition = uploadDisposition(response.status);
        if (disposition === 'auth' && token !== $('token').value.trim()) continue;
        if (disposition === 'auth' || disposition === 'blocked') {
          uploadBlocked = true;
          pause('capture_interrupted');
          message(disposition === 'auth' ? 'Access token was rejected. Enter the correct token, then retry uploads.' :
            `A clip was rejected (HTTP ${response.status}). It remains in the local buffer; inspect the service before retrying.`, true);
          break;
        }
        throw new Error('retry_upload');
      }
      const receipt = await response.json();
      if (receipt.archived !== true || receipt.capture_id !== item.meta.capture_id || receipt.clip_seq !== item.meta.clip_seq || !receipt.media_id) {
        throw new Error('archive_receipt_missing');
      }
      await queue.remove(item);
      $('last-upload').textContent = new Date(item.meta.captured_end_at).toLocaleTimeString() + ' · confirmed by archive';
      await refreshQueue();
    }
  } catch {
    message('Upload is waiting for the connection or archive. Saved clips remain in the local buffer.', true);
    if (navigator.onLine) uploadTimer = setTimeout(() => void upload(), 5000);
  } finally {
    uploading = false;
    await refreshQueue().catch(() => {});
  }
}

$('start').addEventListener('click', () => void start());
$('pause').addEventListener('click', () => pause());
$('stop').addEventListener('click', stop);
$('retry').addEventListener('click', () => { uploadBlocked = false; void upload(); render(); });
$('token').addEventListener('input', () => { uploadBlocked = false; clearTimeout(uploadTimer); render(); });
$('token').addEventListener('change', () => void upload());
$('discard').addEventListener('click', async () => {
  if (uploading || state.phase !== 'idle' || recordingLoop) return;
  if (!confirm('Permanently discard all pending clips from this browser? Clips already archived are unaffected.')) return;
  try {
    await queue.clear();
    uploadBlocked = false;
    await refreshQueue();
    message('Pending clips were discarded from this browser.');
  } catch { message('Could not clear local storage.', true); }
});
document.addEventListener('visibilitychange', () => {
  if (document.hidden) pause('page_hidden');
  else { void upload(); if (state.phase === 'recording') void requestWakeLock(); }
});
window.addEventListener('focus', () => { if (state.phase === 'recording') void requestWakeLock(); });
window.addEventListener('hashchange', consumeTokenLink);
window.addEventListener('online', () => void upload());
window.addEventListener('offline', () => message('Offline. Clips are stored locally until the connection returns.'));
window.addEventListener('pagehide', () => { pause('page_hidden'); ready = false; releaseTab?.(); });
window.addEventListener('pageshow', event => { if (event.persisted) window.location.reload(); });
window.addEventListener('beforeunload', event => {
  if (pending.count || ['recording', 'acquiring'].includes(state.phase)) { event.preventDefault(); event.returnValue = ''; }
});

async function initialize() {
  if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia || !window.MediaRecorder || !window.indexedDB || !navigator.locks) {
    message('Use a current browser over HTTPS. Camera recording, IndexedDB, and Web Locks are required.', true);
    return;
  }
  // One tab owns capture and uploads. This prevents two pages from deleting or sending the same local queue.
  await navigator.locks.request('eleagent-capture-owner', { ifAvailable: true }, async lock => {
    if (!lock) { message('Eleagent is already open in another tab. Close that tab, then reload this page.', true); return; }
    try {
      queue = await openQueue();
      ready = true;
      await refreshQueue();
      const hasToken = $('token').value.trim().length >= 16;
      message(pending.count
        ? (hasToken ? 'Pending clips were restored. Uploads will resume when connected.' : 'Pending clips were restored. Enter your access token to resume uploads.')
        : (hasToken ? 'Access token is ready. Choose a camera and start when ready.' : 'Enter your access token, choose a camera, and start when ready.'));
      if (hasToken && pending.count) void upload();
      await new Promise(resolve => { releaseTab = resolve; });
    } catch {
      ready = false;
      message('Local browser storage is unavailable. Enable storage before recording.', true);
      render();
    }
  });
}
void initialize();

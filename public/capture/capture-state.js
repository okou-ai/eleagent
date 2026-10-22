export const CLIP_MS = 5000;
export const MAX_CLIP_BYTES = 16_000_000;
export const MAX_QUEUE_BYTES = 128 * 1024 * 1024;
export const MAX_QUEUE_CLIPS = 240;

export function recorderType(Recorder) {
  const types = ['video/mp4;codecs=avc1.42E01E,mp4a.40.2', 'video/mp4', 'video/webm;codecs=vp8,opus', 'video/webm'];
  return types.find(type => Recorder.isTypeSupported(type)) || '';
}

// Reserve one maximum-size clip so a full buffer never drops a completed clip.
export function bufferHasRoom(stats) {
  return stats.count < MAX_QUEUE_CLIPS && stats.bytes + MAX_CLIP_BYTES <= MAX_QUEUE_BYTES;
}

// Resume after a full buffer only once it has drained to half, so capture does not stutter clip by clip.
export function bufferRecovered(stats) {
  return stats.count <= MAX_QUEUE_CLIPS / 2 && stats.bytes <= MAX_QUEUE_BYTES / 2;
}

// The observer reads the lens from the capture identity, so each camera direction is its own capture.
export function newCaptureId(camera, uuid = crypto.randomUUID()) {
  return `web-${uuid}-${camera}`;
}

export function captureCamera(captureId) {
  return captureId?.match(/-(front|back)$/)?.[1] ?? null;
}

export function resumesAutomatically(reason) {
  return reason === 'page_hidden' || reason === 'buffer_full';
}

export function formatElapsed(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(total / 3600), minutes = Math.floor(total / 60) % 60, seconds = total % 60;
  const pad = value => String(value).padStart(2, '0');
  return hours ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${pad(minutes)}:${pad(seconds)}`;
}

// How long ago an observation's footage was recorded: seconds, minutes and hours, then a date.
export function formatAgo(then, now = Date.now(), { locale, timeZone } = {}) {
  const seconds = Math.max(0, Math.floor((now - then) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  return new Date(then).toLocaleString(locale, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false, timeZone });
}

export function uploadDisposition(status) {
  if (status === 401 || status === 403) return 'auth';
  if ([400, 409, 413, 415, 422].includes(status)) return 'blocked';
  return 'retry';
}

export class CaptureState {
  constructor() {
    this.phase = 'idle';
    this.epoch = 0;
    this.captureId = null;
    this.nextSeq = 0;
    this.gap = null;
    this.pauseReason = null;
  }
  acquire(id) {
    if (!['idle', 'paused'].includes(this.phase)) throw new Error('Capture is already active.');
    if (id !== this.captureId) {
      this.captureId = id;
      this.nextSeq = 0;
      this.gap = null;
    }
    this.phase = 'acquiring';
    this.pauseReason = null;
    return ++this.epoch;
  }
  activate(epoch) {
    if (epoch !== this.epoch || this.phase !== 'acquiring') return false;
    this.phase = 'recording';
    return true;
  }
  pause(reason, at = new Date().toISOString()) {
    if (this.phase === 'idle') return;
    this.phase = 'paused';
    this.pauseReason = reason;
    ++this.epoch;
    this.gap ||= { started_at: at, reason };
  }
  stop() {
    this.phase = 'idle';
    ++this.epoch;
  }
  clip(camera, at = new Date().toISOString()) {
    if (this.phase !== 'recording') throw new Error('Capture is not recording.');
    const meta = { capture_id: this.captureId, clip_seq: this.nextSeq++, captured_at: at,
      camera, source: 'browser_media_recorder', locations: [], motion: null, capture_gaps: [],
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone };
    if (this.gap) {
      meta.capture_gaps.push({ ...this.gap, ended_at: at });
      this.gap = null;
    }
    return meta;
  }
}

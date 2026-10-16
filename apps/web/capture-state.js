export const CLIP_MS = 5000;
export const MAX_CLIP_BYTES = 16_000_000;
export const MAX_QUEUE_BYTES = 128 * 1024 * 1024;
export const MAX_QUEUE_CLIPS = 240;

export function recorderType(Recorder) {
  const types = ['video/mp4;codecs=avc1.42E01E,mp4a.40.2', 'video/mp4', 'video/webm;codecs=vp8,opus', 'video/webm'];
  return types.find(type => Recorder.isTypeSupported(type)) || '';
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
  }
  acquire(id) {
    if (!['idle', 'paused'].includes(this.phase)) throw new Error('Capture is already active.');
    if (id !== this.captureId) {
      this.captureId = id;
      this.nextSeq = 0;
      this.gap = null;
    }
    this.phase = 'acquiring';
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
      camera, source: 'browser_media_recorder', locations: [], motion: null, capture_gaps: [] };
    if (this.gap) {
      meta.capture_gaps.push({ ...this.gap, ended_at: at });
      this.gap = null;
    }
    return meta;
  }
}

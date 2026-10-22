import test from 'node:test';
import assert from 'node:assert/strict';
import { CaptureState, MAX_QUEUE_BYTES, MAX_QUEUE_CLIPS, bufferHasRoom, bufferRecovered, captureCamera, formatElapsed,
  formatAgo, newCaptureId, recorderType, resumesAutomatically, uploadDisposition } from '../public/capture/capture-state.js';

test('a delayed permission grant cannot restart capture after stopping or hiding', () => {
  const state = new CaptureState();
  const pending = state.acquire('web-synthetic-back');
  state.pause('page_hidden');
  assert.equal(state.activate(pending), false);
  const next = state.acquire('web-synthetic-back');
  state.stop();
  assert.equal(state.activate(next), false);
});

test('resume keeps clip identity monotonic and reports the real capture gap once', () => {
  const state = new CaptureState();
  state.activate(state.acquire('web-synthetic-back'));
  assert.equal(state.clip('back', '2026-01-01T17:00:00Z').clip_seq, 0);
  state.pause('page_hidden', '2026-01-01T17:00:04Z');
  state.activate(state.acquire('web-synthetic-back'));
  const next = state.clip('back', '2026-01-01T17:02:00Z');
  assert.equal(next.clip_seq, 1);
  assert.deepEqual(next.capture_gaps, [{ reason: 'page_hidden', started_at: '2026-01-01T17:00:04Z', ended_at: '2026-01-01T17:02:00Z' }]);
  assert.deepEqual(state.clip('back').capture_gaps, []);
});

test('a new capture resets sequence identity and cannot claim a prior capture gap', () => {
  const state = new CaptureState();
  state.activate(state.acquire('web-first-back'));
  state.clip('back');
  state.pause('user_pause');
  state.stop();
  state.activate(state.acquire('web-second-front'));
  assert.equal(state.clip('front').clip_seq, 0);
  assert.deepEqual(state.clip('front').capture_gaps, []);
});

test('supported media formats are negotiated and permanent rejection never retries forever', () => {
  assert.equal(recorderType({ isTypeSupported: type => type === 'video/webm' }), 'video/webm');
  assert.equal(recorderType({ isTypeSupported: () => false }), '');
  assert.equal(uploadDisposition(401), 'auth');
  assert.equal(uploadDisposition(422), 'blocked');
  assert.equal(uploadDisposition(503), 'retry');
});

test('switching cameras starts a new capture whose identity carries the lens', () => {
  const state = new CaptureState();
  const back = newCaptureId('back', '0000');
  state.activate(state.acquire(back));
  state.clip('back');
  state.pause('user_pause');
  assert.equal(captureCamera(state.captureId), 'back');
  const front = newCaptureId('front', '0001');
  assert.equal(captureCamera(front), 'front');
  state.activate(state.acquire(front));
  const first = state.clip('front');
  assert.equal(first.clip_seq, 0);
  assert.deepEqual(first.capture_gaps, []);
  assert.equal(captureCamera('web-legacy'), null);
});

test('only background and storage pauses resume without a tap', () => {
  const state = new CaptureState();
  state.activate(state.acquire('web-synthetic-back'));
  state.pause('page_hidden');
  assert.equal(resumesAutomatically(state.pauseReason), true);
  state.acquire('web-synthetic-back');
  assert.equal(state.pauseReason, null);
  state.pause('user_pause');
  assert.equal(resumesAutomatically(state.pauseReason), false);
  assert.equal(resumesAutomatically('capture_interrupted'), false);
  assert.equal(resumesAutomatically('buffer_full'), true);
});

test('a full buffer pauses capture and resumes only after draining to half', () => {
  const full = { count: MAX_QUEUE_CLIPS, bytes: 0 };
  assert.equal(bufferHasRoom(full), false);
  assert.equal(bufferHasRoom({ count: 0, bytes: MAX_QUEUE_BYTES - 1 }), false);
  assert.equal(bufferHasRoom({ count: MAX_QUEUE_CLIPS - 1, bytes: 0 }), true);
  assert.equal(bufferRecovered({ count: MAX_QUEUE_CLIPS - 1, bytes: 0 }), false);
  assert.equal(bufferRecovered({ count: MAX_QUEUE_CLIPS / 2, bytes: MAX_QUEUE_BYTES / 2 }), true);
});

test('elapsed recording time reads like a camera timer', () => {
  assert.equal(formatElapsed(0), '00:00');
  assert.equal(formatElapsed(62_400), '01:02');
  assert.equal(formatElapsed(3_723_000), '1:02:03');
});

test('observation age reads in seconds, minutes and hours, then as a date', () => {
  const now = Date.parse('2026-10-16T12:00:00Z');
  assert.equal(formatAgo(now - 12_400, now), '12s ago');
  assert.equal(formatAgo(now + 3_000, now), '0s ago');
  assert.equal(formatAgo(now - 3 * 60_000, now), '3 min ago');
  assert.equal(formatAgo(now - 2 * 3_600_000, now), '2 h ago');
  assert.equal(formatAgo(Date.parse('2026-10-14T21:04:00Z'), now, { locale: 'en-US', timeZone: 'UTC' }), 'Oct 14, 21:04');
});

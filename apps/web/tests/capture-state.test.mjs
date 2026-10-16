import test from 'node:test';
import assert from 'node:assert/strict';
import { CaptureState, recorderType, uploadDisposition } from '../capture-state.js';

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

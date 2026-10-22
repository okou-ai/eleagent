import test from 'node:test';
import assert from 'node:assert/strict';
import { SAMPLE_RATE, SpeechEnd, encodeWav, levelDb, resample } from '../public/capture/okou.js';

// The capture page's helpers for talking to Okou: when the speaker has finished, and the audio that is sent.
const chunk = (amplitude) => Float32Array.from({ length: SAMPLE_RATE / 10 }, (_, i) => amplitude * Math.sin(i / 3));
const feed = (ender, pattern) => {
  for (const [amplitude, n] of pattern) for (let i = 0; i < n; i++) { const verdict = ender.push(chunk(amplitude)); if (verdict !== 'continue') return verdict; }
  return 'continue';
};

test('a request ends after speech followed by a pause; silence alone, or talking too long, ends it too', () => {
  assert.equal(feed(new SpeechEnd({ floorDb: -60 }), [[0.2, 20], [0.0005, 13]]), 'continue', 'a 1.3 s pause is not yet the end');
  assert.equal(feed(new SpeechEnd({ floorDb: -60 }), [[0.2, 20], [0.0005, 14]]), 'done');
  assert.equal(feed(new SpeechEnd({ floorDb: -60 }), [[0.0005, 60]]), 'nothing');
  assert.equal(feed(new SpeechEnd({ floorDb: -60 }), [[0.2, 150]]), 'max');
  // Speech is judged against the room: its hum is not speech…
  const room = levelDb(chunk(0.01));
  assert.equal(feed(new SpeechEnd({ floorDb: room }), [[0.01, 60]]), 'nothing');
  assert.equal(feed(new SpeechEnd({ floorDb: room }), [[0.2, 20], [0.01, 14]]), 'done');
  // …but however loud the room, the owner speaking close to the phone is heard.
  assert.equal(feed(new SpeechEnd({ floorDb: levelDb(chunk(0.2)) }), [[0.1, 60]]), 'continue');
});

test('requests are sent as 16 kHz mono 16-bit WAV, resampled from the microphone\'s rate', () => {
  const wav = encodeWav(new Float32Array([0, 1, -1, 0.5]));
  const view = new DataView(wav.buffer);
  assert.equal(String.fromCharCode(...wav.slice(0, 4)), 'RIFF');
  assert.equal(view.getUint32(24, true), 16000);
  assert.equal(view.getUint16(22, true), 1);
  assert.deepEqual([view.getInt16(44, true), view.getInt16(46, true), view.getInt16(48, true)], [0, 32767, -32767]);
  assert.equal(resample(new Float32Array(48000), 48000).length, 16000);
});

// Fetches the voiceprint model (CAM++ from 3D-Speaker, Apache-2.0, 28 MB) into public/voice/models before a build, so
// it is served from this deployment without living in the repository. The download is checked against its hash.
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';

const target = new URL('../public/voice/models/speaker.onnx', import.meta.url);
const source = 'https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-recongition-models/3dspeaker_speech_campplus_sv_zh_en_16k-common_advanced.onnx';
const sha256 = 'aa3cfc16963a10586a9393f5035d6d6b57e98d358b347f80c2a30bf4f00ceba2';
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');

const existing = await readFile(target).catch(() => null);
if (existing && digest(existing) === sha256) {
  console.log('voice models: present');
} else {
  const response = await fetch(source);
  if (!response.ok) throw new Error(`voice models: HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (digest(bytes) !== sha256) throw new Error('voice models: the speaker model does not match its hash');
  await writeFile(target, bytes);
  console.log('voice models: fetched speaker.onnx');
}

import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ffmpeg from '@ffmpeg-installer/ffmpeg';

// Still frames from a clip, for agents that need to see what the camera saw. A bundled static ffmpeg decodes the
// browser's recordings (WebM from Chrome, MP4 from Safari).

export const MAX_FRAMES = 6;

export function run(args: string[]): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    execFile(ffmpeg.path, args, { encoding: 'buffer', maxBuffer: 16_000_000, timeout: 20_000 }, (error, stdout, stderr) => {
      if (error) reject(new Error(`ffmpeg: ${stderr.toString().trim().slice(-200) || error.message}`));
      else resolve(stdout);
    });
  });
}

const still = (file: string, seek: string[], size: number) => run([
  '-nostdin', '-hide_banner', '-loglevel', 'error', '-protocol_whitelist', 'file,pipe', '-threads', '1', ...seek,
  '-i', file, '-map', '0:v:0', '-frames:v', '1',
  '-vf', `scale='min(${size},iw)':'min(${size},ih)':force_original_aspect_ratio=decrease`,
  '-q:v', '4', '-f', 'image2pipe', '-c:v', 'mjpeg', 'pipe:1',
]);

// One JPEG per offset (seconds from the clip's start); the longer side is at most `size` pixels.
export async function framesFromFile(file: string, offsets: number[], size: number): Promise<Buffer[]> {
  const frames: Buffer[] = [];
  for (const offset of offsets) {
    let jpeg = await still(file, ['-ss', Math.max(0, offset).toFixed(3)], size);
    // The video track can end a little before the clip's nominal end: take its last frame instead.
    if (!jpeg.length) jpeg = await still(file, ['-sseof', '-0.5'], size);
    if (!jpeg.length) throw new Error('ffmpeg: no frame decoded');
    frames.push(jpeg);
  }
  return frames;
}

// The clip's sound as 16 kHz mono 16-bit PCM; empty when it has no audio track.
export async function audioPcm(file: string): Promise<Buffer> {
  return run(['-nostdin', '-hide_banner', '-loglevel', 'error', '-protocol_whitelist', 'file,pipe', '-i', file,
    '-map', '0:a:0?', '-vn', '-ac', '1', '-ar', '16000', '-f', 's16le', 'pipe:1']).catch(() => Buffer.alloc(0));
}

// 16 kHz mono PCM (a file) as MP3, the audio format speech and omni models accept.
export function encodeMp3(pcmFile: string): Promise<Buffer> {
  return run(['-nostdin', '-hide_banner', '-loglevel', 'error', '-f', 's16le', '-ar', '16000', '-ac', '1', '-i', pcmFile,
    '-c:a', 'libmp3lame', '-b:a', '48k', '-f', 'mp3', 'pipe:1']);
}

export async function framesFromUrl(url: string, offsets: number[], size: number): Promise<Buffer[]> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`clip download failed: ${response.status}`);
  const dir = await mkdtemp(join(tmpdir(), 'eleagent-frames-'));
  try {
    const file = join(dir, 'clip');
    await writeFile(file, Buffer.from(await response.arrayBuffer()));
    return await framesFromFile(file, offsets, size);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

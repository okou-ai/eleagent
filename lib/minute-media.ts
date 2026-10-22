import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { audioPcm, encodeMp3, framesFromFile } from './frames.ts';

// One minute of a capture prepared for the models: a still from the middle of each clip, and the clips' sound laid
// on one timeline (silence where nothing was recorded), so a time in the audio maps back to a wall-clock time.

export interface MinuteClip { url: string; startedAt: Date; endedAt: Date }
export interface MinuteMedia { startedAt: Date; endedAt: Date; frames: { at: Date; jpeg: Buffer }[]; audio: Buffer | null }

const RATE = 16_000, BYTES = 2;
export const STILL_SIZE = 512;

export async function minuteMedia(clips: MinuteClip[]): Promise<MinuteMedia> {
  const ordered = [...clips].sort((a, b) => a.startedAt.getTime() - b.startedAt.getTime());
  const startedAt = ordered[0].startedAt;
  const endedAt = new Date(Math.max(...ordered.map((clip) => clip.endedAt.getTime())));
  const dir = await mkdtemp(join(tmpdir(), 'eleagent-minute-'));
  try {
    const files = await Promise.all(ordered.map(async (clip, index) => {
      const response = await fetch(clip.url);
      if (!response.ok) throw new Error(`clip download failed: ${response.status}`);
      const file = join(dir, `clip-${index}`);
      await writeFile(file, Buffer.from(await response.arrayBuffer()));
      return file;
    }));
    const frames: MinuteMedia['frames'] = [];
    const timeline = Buffer.alloc(Math.ceil(((endedAt.getTime() - startedAt.getTime()) / 1000) * RATE) * BYTES);
    let sound = false;
    for (const [index, clip] of ordered.entries()) {
      const length = (clip.endedAt.getTime() - clip.startedAt.getTime()) / 1000;
      const middle = Math.max(0, Math.min(length / 2, length - 0.25));
      const [jpeg] = await framesFromFile(files[index], [middle], STILL_SIZE).catch(() => [null]);
      if (jpeg) frames.push({ at: new Date(clip.startedAt.getTime() + middle * 1000), jpeg });
      const pcm = await audioPcm(files[index]);
      if (!pcm.length) continue;
      sound = true;
      const offset = Math.round(((clip.startedAt.getTime() - startedAt.getTime()) / 1000) * RATE) * BYTES;
      pcm.copy(timeline, offset, 0, Math.min(pcm.length, timeline.length - offset));
    }
    let audio: Buffer | null = null;
    if (sound) {
      await writeFile(join(dir, 'minute.pcm'), timeline);
      audio = await encodeMp3(join(dir, 'minute.pcm'));
    }
    return { startedAt, endedAt, frames, audio };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

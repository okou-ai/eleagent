import { after } from 'next/server';
import { signDownload } from './blob';
import { sql } from './db';
import { minuteMedia } from './minute-media';
import { perceive, transcribe } from './openrouter';
import { processReadyMinutes, type PerceptionDeps } from './perception';

export function perceptionDeps(): PerceptionDeps {
  return { query: sql().query, signDownload, media: minuteMedia, transcribe, perceive,
    language: process.env.MEMORY_LANGUAGE || 'English' };
}

// After this response, process the minutes that are ready. With `tail`, look again once the quiet period has passed,
// so the last minute of a recording is processed even though no later clip will arrive to trigger it.
export function perceiveAfterResponse({ tail = false } = {}) {
  after(async () => {
    const deps = perceptionDeps();
    await processReadyMinutes(deps, { max: 2 });
    if (!tail) return;
    await new Promise((resolve) => setTimeout(resolve, 35_000));
    await processReadyMinutes(deps, { max: 2 });
  });
}

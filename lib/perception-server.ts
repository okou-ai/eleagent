import { after } from 'next/server';
import { signDownload } from './blob';
import { sql } from './db';
import { minuteMedia } from './minute-media';
import { handOffMinute } from './okou-server';
import { perceive, transcribe } from './openrouter';
import { processReadyMinutes, type PerceptionDeps } from './perception';

export function perceptionDeps(): PerceptionDeps {
  return { query: sql().query, signDownload, media: minuteMedia, transcribe, perceive,
    language: process.env.MEMORY_LANGUAGE || 'English',
    // Requests reach Okou when the owner says "Hey Okou" or taps the mark; reading every minute for requests made to
    // Okou in passing is optional (OKOU_MINUTE_CHECK=on).
    afterMinute: process.env.OKOU_MINUTE_CHECK === 'on' ? handOffMinute : undefined };
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

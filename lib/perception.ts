import type { MinuteClip, MinuteMedia } from './minute-media.ts';
import type { Query, SignDownload } from './mcp.ts';
import type { PerceiveInput, Word } from './openrouter.ts';

// Hearing and seeing: each wall-clock minute of a capture becomes an observation, its speech by speaker and a
// description of the scene. Minutes are queued as clips arrive (queueClip) and processed by whichever request runs
// processReadyMinutes next: a claim in the database keeps two requests from processing the same minute.

export interface PerceptionDeps {
  query: Query;
  signDownload: SignDownload;
  media: (clips: MinuteClip[]) => Promise<MinuteMedia>;
  transcribe: (mp3: Buffer) => Promise<{ words: Word[]; cost: number }>;
  perceive: (input: PerceiveInput) => Promise<{ perception: Record<string, unknown>; cost: number }>;
  /** The language observations are written in (MEMORY_LANGUAGE). */
  language: string;
  /** Runs after a minute has been heard and seen (handing requests to Okou); its failures do not affect the minute. */
  afterMinute?: (captureId: string, minute: string) => Promise<unknown>;
}

export interface Segment { start: string; end: string; speaker: string | null; text: string }

// A minute is ready once the recording has moved past it, or nothing new has arrived for it for this long.
const QUIET_SECONDS = 30;
const MAX_ATTEMPTS = 3;
const SEGMENT_PAUSE_SECONDS = 1.5;
// How far back the previous minutes' descriptions are given to the model as context.
const CONTEXT_MINUTES = 3;

const iso = (value: unknown) => new Date(value as string).toISOString();

export async function queueClip(query: Query, captureId: string, capturedAt: string): Promise<void> {
  await query(`INSERT INTO observations (capture_id, minute, clip_count) VALUES ($1, date_trunc('minute', $2::timestamptz), 1)
    ON CONFLICT (capture_id, minute) DO UPDATE SET clip_count = observations.clip_count + 1, updated_at = now(),
      status = CASE WHEN observations.status = 'done' THEN 'pending' ELSE observations.status END,
      attempts = CASE WHEN observations.status = 'done' THEN 0 ELSE observations.attempts END`, [captureId, capturedAt]);
}

// Words into speaker turns, split at pauses, with wall-clock times.
export function segments(words: Word[], startedAt: Date): Segment[] {
  const turns: { speaker: string | null; start: number; end: number; text: string }[] = [];
  for (const word of words) {
    const last = turns.at(-1);
    if (last && last.speaker === word.speaker && word.start - last.end <= SEGMENT_PAUSE_SECONDS) {
      const glue = /[A-Za-z0-9]$/.test(last.text) && /^[A-Za-z0-9]/.test(word.text) ? ' ' : '';
      last.text += glue + word.text;
      last.end = Math.max(last.end, word.end);
    } else if (word.text.trim()) {
      turns.push({ speaker: word.speaker, start: word.start, end: word.end, text: word.text });
    }
  }
  const at = (seconds: number) => new Date(startedAt.getTime() + seconds * 1000).toISOString();
  return turns.map((turn) => ({ start: at(turn.start), end: at(turn.end), speaker: turn.speaker, text: turn.text.replace(/\s+/g, ' ').trim() }))
    .filter((turn) => turn.text);
}

const list = (value: unknown) => (Array.isArray(value) ? value : []) as Record<string, unknown>[];

// Everything search should find for a minute, in one string.
function searchText(perception: Record<string, unknown>, transcript: Segment[]): string {
  const parts = [perception.summary, perception.place, perception.activity, perception.attention, perception.sounds,
    perception.speech_gist, perception.notable,
    ...list(perception.people).flatMap((person) => [person.description, person.doing]),
    ...list(perception.objects).flatMap((object) => [object.name, object.detail]),
    ...list(perception.visible_text).map((text) => text.text),
    ...transcript.map((turn) => turn.text)];
  return parts.filter((part) => typeof part === 'string' && part.trim()).join('\n');
}

async function claim(query: Query) {
  const [row] = await query(`UPDATE observations o SET status = 'processing', claimed_at = now(), attempts = o.attempts + 1, updated_at = now()
    WHERE (o.capture_id, o.minute) IN (
      SELECT q.capture_id, q.minute FROM observations q
      WHERE (q.status = 'pending'
          OR (q.status = 'failed' AND q.attempts < ${MAX_ATTEMPTS} AND q.updated_at < now() - interval '2 minutes')
          OR (q.status = 'processing' AND q.claimed_at < now() - interval '5 minutes'))
        AND (EXISTS (SELECT 1 FROM clips k WHERE k.capture_id = q.capture_id AND k.captured_at >= q.minute + interval '1 minute')
          OR NOT EXISTS (SELECT 1 FROM clips k WHERE k.capture_id = q.capture_id AND k.captured_at >= q.minute
            AND k.captured_at < q.minute + interval '1 minute' AND k.uploaded_at > now() - interval '${QUIET_SECONDS} seconds'))
      ORDER BY q.minute LIMIT 1 FOR UPDATE SKIP LOCKED)
    RETURNING o.capture_id, o.minute`, []);
  return row ? { captureId: String(row.capture_id), minute: iso(row.minute) } : null;
}

export async function processMinute(deps: PerceptionDeps, captureId: string, minute: string): Promise<void> {
  const { query } = deps;
  try {
    const rows = await query(`SELECT captured_at, captured_end_at, pathname FROM clips WHERE capture_id = $1
      AND captured_at >= $2::timestamptz AND captured_at < $2::timestamptz + interval '1 minute' ORDER BY captured_at`, [captureId, minute]);
    if (!rows.length) throw new Error('No clips in this minute');
    const clips = await Promise.all(rows.map(async (row) => {
      const startedAt = new Date(iso(row.captured_at));
      const endedAt = row.captured_end_at ? new Date(iso(row.captured_end_at)) : new Date(startedAt.getTime() + 5000);
      return { url: (await deps.signDownload(String(row.pathname))).url, startedAt, endedAt };
    }));
    const media = await deps.media(clips);
    let cost = 0;
    let transcript: Segment[] = [];
    if (media.audio) {
      const heard = await deps.transcribe(media.audio);
      cost += heard.cost;
      transcript = segments(heard.words, media.startedAt);
    }
    const offset = (time: string | Date) => (new Date(time).getTime() - media.startedAt.getTime()) / 1000;
    const earlier = await query(`SELECT minute, summary FROM observations WHERE capture_id = $1 AND status = 'done'
      AND minute < $2::timestamptz AND minute >= $2::timestamptz - make_interval(mins => ${CONTEXT_MINUTES}) ORDER BY minute`, [captureId, minute]);
    const context = earlier.filter((row) => row.summary).map((row) =>
      `${Math.round((Date.parse(minute) - Date.parse(iso(row.minute))) / 60_000)} min earlier: ${row.summary}`).join('\n');
    const seen = await deps.perceive({
      camera: captureId.endsWith('-front') ? 'front' : 'back',
      frames: media.frames.map((frame) => ({ offset: offset(frame.at), jpeg: frame.jpeg })),
      audio: media.audio,
      transcript: transcript.map((turn) => `[${offset(turn.start).toFixed(1)}s] ${turn.speaker ?? 'speaker'}: ${turn.text}`).join('\n'),
      context,
      language: deps.language,
    });
    cost += seen.cost;
    const summary = String(seen.perception.summary ?? seen.perception.activity ?? '');
    await query(`UPDATE observations SET status = CASE WHEN clip_count > $3 THEN 'pending' ELSE 'done' END,
      processed_clips = $3, started_at = $4, ended_at = $5, transcript = $6, perception = $7, summary = $8, search_text = $9,
      cost_usd = $10, error = NULL, claimed_at = NULL, updated_at = now() WHERE capture_id = $1 AND minute = $2`,
    [captureId, minute, rows.length, media.startedAt.toISOString(), media.endedAt.toISOString(), JSON.stringify(transcript),
      JSON.stringify(seen.perception), summary, searchText(seen.perception, transcript), cost]);
  } catch (error) {
    await query(`UPDATE observations SET status = 'failed', error = $3, claimed_at = NULL, updated_at = now()
      WHERE capture_id = $1 AND minute = $2`, [captureId, minute, String((error as Error).message ?? error).slice(0, 500)]);
    return;
  }
  await deps.afterMinute?.(captureId, minute).catch(() => {});
}

// Processes ready minutes one at a time until none is left, `max` were done, or the deadline passes.
export async function processReadyMinutes(deps: PerceptionDeps, { max = 3, deadline = Date.now() + 120_000 } = {}) {
  let processed = 0;
  while (processed < max && Date.now() < deadline) {
    const next = await claim(deps.query);
    if (!next) break;
    await processMinute(deps, next.captureId, next.minute);
    processed += 1;
  }
  return processed;
}

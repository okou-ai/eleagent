import { createHash } from 'node:crypto';
import type { Query } from './mcp.ts';

// Sleep: once a day has ended in the owner's time zone, its observations become long-term memory. The day is cut
// into episodes (stretches of continuous experience), a model digests each episode once, and a final model call
// consolidates the digests with what is already remembered: people, objects, places, routines and readings are
// created or enriched, the day's events and conversations are saved with their times, related memories are linked,
// and a first-person diary is written. Re-running a day replaces that day's events, conversations and diary.

export const SLEEP_MODEL = 'z-ai/glm-5.3-flash';
export type Complete = (system: string, user: string, maxTokens: number) => Promise<{ json: Record<string, unknown>; cost: number }>;
export interface SleepDeps {
  query: Query;
  complete: Complete;
  /** The language memories and the diary are written in (MEMORY_LANGUAGE). */
  language: string;
  now?: () => Date;
}

const EPISODE_GAP_MINUTES = 10;
const EPISODE_MAX_MINUTES = 45;
const EPISODE_MOVE_METERS = 300;
const SETTLE_HOURS = 1;
const MAX_ATTEMPTS = 3;
const CATALOG_SIZE = 400;
const MEMORY_KINDS = ['person', 'object', 'place', 'routine', 'reading'];

type Row = Record<string, unknown>;
type Location = { latitude?: number; longitude?: number };
export interface Minute {
  capture_id: string; minute: string; started_at: string; ended_at: string; summary: string;
  perception: Row; transcript: { start: string; speaker: string | null; text: string }[]; location: Location | null;
}
export interface Episode { id: string; minutes: Minute[] }

const iso = (value: unknown) => new Date(value as string).toISOString();
const list = (value: unknown) => (Array.isArray(value) ? value : []) as Row[];
const text = (value: unknown, max = 2000) => (typeof value === 'string' ? value.trim().slice(0, max) : '');

// --- Time in the owner's time zone ---

function parts(date: Date, timeZone: string) {
  const values = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).formatToParts(date).map((part) => [part.type, part.value]));
  return { day: `${values.year}-${values.month}-${values.day}`, time: `${values.hour}:${values.minute}`, seconds: `${values.hour}:${values.minute}:${values.second}` };
}
export const localDay = (date: Date, timeZone: string) => parts(date, timeZone).day;
export const localTime = (date: Date, timeZone: string) => parts(date, timeZone).time;

// The instant at which it is `HH:MM` on `day` in the time zone.
export function instantAt(day: string, hhmm: string, timeZone: string): Date | null {
  const match = /^(\d{1,2}):(\d{2})/.exec(hhmm ?? '');
  const [year, month, date] = day.split('-').map(Number);
  if (!match || !year) return null;
  const guess = Date.UTC(year, month - 1, date, Number(match[1]), Number(match[2]));
  // The zone's offset at an instant: the wall-clock time it shows there, read as UTC, minus the instant.
  const offset = (instant: number) => {
    const local = parts(new Date(instant), timeZone);
    const [y, m, d] = local.day.split('-').map(Number), [h, min] = local.time.split(':').map(Number);
    return Date.UTC(y, m - 1, d, h, min) - instant;
  };
  // Take the offset again at the first answer, in case a daylight-saving change lies between.
  return new Date(guess - offset(guess - offset(guess)));
}

export function validTimeZone(value: unknown): value is string {
  if (typeof value !== 'string' || !value || value.length > 64) return false;
  try { new Intl.DateTimeFormat('en', { timeZone: value }); return true; } catch { return false; }
}

// --- Episodes ---

function meters(a: Location | null, b: Location | null) {
  if (typeof a?.latitude !== 'number' || typeof b?.latitude !== 'number' || typeof a.longitude !== 'number' || typeof b.longitude !== 'number') return 0;
  const rad = Math.PI / 180, dLat = (b.latitude - a.latitude) * rad, dLon = (b.longitude - a.longitude) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.latitude * rad) * Math.cos(b.latitude * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * 6_371_000 * Math.asin(Math.sqrt(h));
}

// Consecutive minutes, split by a gap, by moving away, or when an episode grows too long.
export function episodesOf(minutes: Minute[], timeZone: string): Episode[] {
  const episodes: Minute[][] = [];
  let place: Location | null = null;
  for (const minute of [...minutes].sort((a, b) => a.minute.localeCompare(b.minute))) {
    const current = episodes.at(-1);
    const last = current?.at(-1);
    const gap = last ? (Date.parse(minute.minute) - Date.parse(last.minute)) / 60_000 : Infinity;
    if (!current || gap > EPISODE_GAP_MINUTES || current.length >= EPISODE_MAX_MINUTES || meters(place, minute.location) > EPISODE_MOVE_METERS) {
      episodes.push([minute]);
      place = minute.location;
    } else {
      current.push(minute);
      place ??= minute.location;
    }
  }
  return episodes.map((group) => {
    const start = new Date(group[0].minute);
    return { id: `episode:${localDay(start, timeZone).replaceAll('-', '')}-${localTime(start, timeZone).replace(':', '')}`, minutes: group };
  });
}

// --- Prompts ---

const EVIDENCE_RULES = `Evidence rules:
- The recording is a partial view of the day; gaps are normal. Never invent what happened in a gap.
- Distinguish what was seen, what someone said (a plan or claim is not an action that happened), and your interpretation.
- Speech from a screen, a call or a broadcast is not a conversation in the room.
- Scene descriptions and speech recognition come from models and can be wrong about words, names, numbers and who spoke.
  Speaker labels are anonymous and only consistent within one minute; the owner is usually the closest, clearest voice.
- Prefer fewer, well-supported memories over many speculative ones.`;

function minuteLines(minute: Minute, timeZone: string) {
  const p = minute.perception;
  const at = (value: string) => parts(new Date(value), timeZone).seconds;
  const lines = [`[${localTime(new Date(minute.minute), timeZone)}] ${text(minute.summary, 400)}`];
  for (const [label, value] of [['place', p.place], ['activity', p.activity], ['attention', p.attention], ['sounds', p.sounds], ['notable', p.notable]] as const) {
    if (text(value)) lines.push(`  ${label}: ${text(value, 300)}`);
  }
  const people = list(p.people).map((person) => [text(person.description, 120), text(person.doing, 120)].filter(Boolean).join(', ')).filter(Boolean);
  if (people.length) lines.push(`  people: ${people.join('; ')}`);
  const objects = list(p.objects).map((object) => [text(object.name, 80), text(object.detail, 120)].filter(Boolean).join(' – ')).filter(Boolean);
  if (objects.length) lines.push(`  objects: ${objects.join('; ')}`);
  const readings = list(p.visible_text).map((item) => `"${text(item.text, 200)}" (${text(item.on, 80)})`).filter((item) => item.length > 5);
  if (readings.length) lines.push(`  visible text: ${readings.join('; ')}`);
  for (const turn of minute.transcript) lines.push(`  [${at(turn.start)}] ${turn.speaker ?? 'speaker'}: ${text(turn.text, 600)}`);
  return lines.join('\n');
}

const digestSystem = (language: string) => `You are the sleeping brain of a personal memory system. The owner's phone recorded \
part of their day; another model described each minute and transcribed its speech. Digest one episode (a stretch of \
continuous recording) into what is worth remembering. Times are the owner's local time.

${EVIDENCE_RULES}

Write every value in ${language}; keep quotes and visible text in their original language. Reply with JSON only:
{"title": "short title of the episode",
 "summary": "what happened, in order, in 2-6 sentences",
 "events": [{"title": "...", "description": "...", "start": "HH:MM", "end": "HH:MM"}],
 "conversations": [{"title": "...", "summary": "who talked about what, and any decision or plan", "participants": ["owner", "..."], "start": "HH:MM", "end": "HH:MM"}],
 "people": [{"name": "a name if one was said or shown, else a short description", "detail": "..."}],
 "objects": [{"name": "...", "detail": "brand, colour, label; what the owner did with it"}],
 "places": [{"name": "...", "detail": "..."}],
 "readings": [{"text": "verbatim", "on": "where it appeared", "why": "why it may matter"}],
 "plans": ["explicit plans, promises, open questions"]}`;

const consolidateSystem = (language: string) => `You are the sleeping brain of a personal memory system. Turn one day's \
episode digests into long-term memory and a diary. You also get the memories that already exist: match people, \
objects, places, routines and readings to them by id when they are the same thing, and give an improved description \
that integrates the old one with today's evidence; create new memories only for things worth remembering later. The \
owner is "person:owner". Events and conversations are today's occurrences, with local start and end times. Links are \
one plain sentence relating two memories; mention the date when it concerns a particular day.

${EVIDENCE_RULES}

The diary is a coherent first-person account of the recorded day, in order, as the owner would write it: what they \
did, where, with whom, what they saw, read, said and decided. Mark notable moments with time anchors like ⟦14:05⟧ \
(times that appear in the material). Keeping memories is not something the owner experienced; do not write about it.

Write every value in ${language}; keep quotes and visible text in their original language. Reply with JSON only:
{"diary": {"title": "...", "text": "..."},
 "memories": [{"id": "an existing id, or null for a new memory", "kind": "person | object | place | routine | reading",
   "name": "...", "description": "...", "evidence": [{"time": "HH:MM", "text": "what today showed"}]}],
 "events": [{"title": "...", "description": "...", "start": "HH:MM", "end": "HH:MM", "related": ["memory id or name"]}],
 "conversations": [{"title": "...", "summary": "...", "start": "HH:MM", "end": "HH:MM", "participants": ["memory id or name"]}],
 "links": [{"a": "memory id or name", "b": "memory id or name", "text": "..."}],
 "diary_mentions": ["memory id or name"]}`;

// --- Storage helpers ---

const slug = (value: string) => value.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'item';

function searchTextOf(name: string, properties: Row) {
  return [name, properties.description, properties.summary, properties.text, ...list(properties.evidence).map((item) => item.text)]
    .filter((part) => typeof part === 'string' && part).join('\n');
}

async function saveEntity(query: Query, id: string, kind: string, name: string, properties: Row) {
  await query(`INSERT INTO entities (id, kind, name, properties, search_text) VALUES ($1, $2, $3, $4, $5)
    ON CONFLICT (id) DO UPDATE SET kind = EXCLUDED.kind, name = EXCLUDED.name, properties = EXCLUDED.properties,
      search_text = EXCLUDED.search_text, updated_at = now()`, [id, kind, name, JSON.stringify(properties), searchTextOf(name, properties)]);
}

async function saveLink(query: Query, x: string, y: string, sentence: string) {
  if (!sentence || x === y) return;
  const [a, b] = x < y ? [x, y] : [y, x];
  await query(`INSERT INTO entity_links (a, b, text) VALUES ($1, $2, $3)
    ON CONFLICT (a, b) DO UPDATE SET updated_at = now(),
      text = CASE WHEN position(EXCLUDED.text IN entity_links.text) > 0 THEN entity_links.text ELSE entity_links.text || ' ' || EXCLUDED.text END`,
  [a, b, sentence.slice(0, 1000)]);
}

async function uniqueId(query: Query, base: string) {
  for (let n = 1; ; n++) {
    const id = n === 1 ? base : `${base}-${n}`;
    if (!(await query('SELECT 1 FROM entities WHERE id = $1', [id])).length) return id;
  }
}

// --- One day ---

async function dayMinutes(query: Query, day: string, timeZone: string): Promise<Minute[]> {
  const rows = await query(`SELECT o.capture_id, o.minute, o.started_at, o.ended_at, o.summary, o.perception, o.transcript,
      (SELECT k.meta->'locations'->-1 FROM clips k WHERE k.capture_id = o.capture_id AND k.captured_at >= o.minute
        AND k.captured_at < o.minute + interval '1 minute' AND jsonb_array_length(coalesce(k.meta->'locations', '[]')) > 0
        ORDER BY k.captured_at DESC LIMIT 1) AS location
    FROM observations o WHERE o.status = 'done' AND (o.minute AT TIME ZONE $2)::date = $1::date ORDER BY o.minute`, [day, timeZone]);
  return rows.map((row) => ({ capture_id: String(row.capture_id), minute: iso(row.minute), started_at: iso(row.started_at),
    ended_at: iso(row.ended_at), summary: String(row.summary ?? ''), perception: (row.perception ?? {}) as Row,
    transcript: (row.transcript ?? []) as Minute['transcript'], location: (row.location ?? null) as Location | null }));
}

async function digestEpisodes(deps: SleepDeps, day: string, timeZone: string, episodes: Episode[], deadline: number) {
  const { query } = deps;
  const known = new Map((await query('SELECT id, fingerprint, digest IS NOT NULL AS digested FROM episodes WHERE day = $1', [day]))
    .map((row) => [String(row.id), row]));
  await query('DELETE FROM episodes WHERE day = $1 AND NOT (id = ANY($2))', [day, episodes.map((episode) => episode.id)]);
  const todo: { episode: Episode; fingerprint: string }[] = [];
  for (const episode of episodes) {
    const fingerprint = createHash('sha256').update(JSON.stringify(episode.minutes.map((minute) => [minute.capture_id, minute.minute, minute.summary]))).digest('hex');
    const row = known.get(episode.id);
    if (row?.fingerprint === fingerprint && row.digested) continue;
    await query(`INSERT INTO episodes (id, day, started_at, ended_at, minutes, fingerprint) VALUES ($1, $2, $3, $4, $5, $6)
      ON CONFLICT (id) DO UPDATE SET started_at = EXCLUDED.started_at, ended_at = EXCLUDED.ended_at, minutes = EXCLUDED.minutes,
        fingerprint = EXCLUDED.fingerprint, digest = NULL, updated_at = now()`,
    [episode.id, day, episode.minutes[0].started_at, episode.minutes.at(-1)!.ended_at,
      JSON.stringify(episode.minutes.map((minute) => ({ capture_id: minute.capture_id, minute: minute.minute }))), fingerprint]);
    todo.push({ episode, fingerprint });
  }
  let cost = 0;
  const run = async ({ episode }: { episode: Episode }) => {
    if (Date.now() > deadline) return;
    const start = localTime(new Date(episode.minutes[0].minute), timeZone), end = localTime(new Date(episode.minutes.at(-1)!.ended_at), timeZone);
    const user = `Episode ${start}–${end} on ${day} (${timeZone}), ${episode.minutes.length} recorded minutes:\n\n` +
      episode.minutes.map((minute) => minuteLines(minute, timeZone)).join('\n');
    const result = await deps.complete(digestSystem(deps.language), user, 4000);
    cost += result.cost;
    await query('UPDATE episodes SET digest = $2, cost_usd = $3, updated_at = now() WHERE id = $1', [episode.id, JSON.stringify(result.json), result.cost]);
  };
  for (let i = 0; i < todo.length; i += 4) await Promise.all(todo.slice(i, i + 4).map(run));
  const missing = (await query('SELECT count(*)::int AS n FROM episodes WHERE day = $1 AND digest IS NULL', [day]))[0].n as number;
  return { cost, complete: missing === 0 };
}

async function consolidate(deps: SleepDeps, day: string, timeZone: string, minutes: Minute[]) {
  const { query } = deps;
  const compact = day.replaceAll('-', '');
  const digests = await query('SELECT id, started_at, ended_at, digest FROM episodes WHERE day = $1 ORDER BY started_at', [day]);
  const catalog = await query(`SELECT id, kind, name, properties->>'description' AS description FROM entities
    WHERE kind = ANY($1) ORDER BY updated_at DESC LIMIT ${CATALOG_SIZE}`, [MEMORY_KINDS]);
  const earlier = (await query('SELECT properties->>\'text\' AS text FROM entities WHERE id = $1', [`diary:${compact}`]))[0]?.text;
  const user = [`Day: ${day} (${timeZone}).`,
    `Existing memories (id | kind | name | description):\n${catalog.map((row) => `${row.id} | ${row.kind} | ${row.name} | ${text(row.description, 200)}`).join('\n') || '(none yet)'}`,
    earlier ? `An earlier version of this day's diary (rewrite it with everything now known):\n${earlier}` : '',
    `Episode digests of the day, in order:\n${digests.map((row) => `## ${localTime(new Date(iso(row.started_at)), timeZone)}–${localTime(new Date(iso(row.ended_at)), timeZone)}\n${JSON.stringify(row.digest)}`).join('\n\n')}`,
  ].filter(Boolean).join('\n\n');
  const { json, cost } = await deps.complete(consolidateSystem(deps.language), user, 12000);

  const at = (hhmm: unknown) => instantAt(day, String(hhmm ?? ''), timeZone)?.toISOString() ?? null;
  // Names this run used for memories, so links and mentions can say a name instead of an id.
  const byName = new Map<string, string>();
  const resolve = (ref: unknown) => {
    const value = String(ref ?? '').trim();
    return byName.get(value.toLowerCase()) ?? (/^[a-z]+:/.test(value) ? value : null);
  };
  const exists = async (id: string) => (await query('SELECT 1 FROM entities WHERE id = $1', [id])).length > 0;

  if (!(await exists('person:owner'))) await saveEntity(query, 'person:owner', 'person', 'Owner', { description: 'The owner of this memory.' });
  byName.set('owner', 'person:owner');

  // Today's occurrences are rewritten on every run of the day.
  await query(`DELETE FROM entities WHERE kind IN ('event', 'conversation') AND properties->>'day' = $1`, [day]);

  for (const memory of list(json.memories)) {
    const kind = MEMORY_KINDS.includes(String(memory.kind)) ? String(memory.kind) : null;
    const name = text(memory.name, 200);
    if (!kind || !name) continue;
    // The model should name an existing memory by id; one with the same kind and name is the same memory anyway.
    const existingId = typeof memory.id === 'string' && memory.id.startsWith(`${kind}:`) && await exists(memory.id) ? memory.id
      : (await query('SELECT id FROM entities WHERE kind = $1 AND lower(name) = lower($2) LIMIT 1', [kind, name]))[0]?.id as string | undefined ?? null;
    const previous = existingId ? (await query('SELECT properties FROM entities WHERE id = $1', [existingId]))[0].properties as Row : {};
    const id = existingId ?? await uniqueId(query, `${kind}:${slug(name)}`);
    const evidence = [...list(previous.evidence), ...list(memory.evidence).map((item) => ({ day, time: text(item.time, 5), text: text(item.text, 500) }))].slice(-30);
    const days = [...new Set([...(Array.isArray(previous.days) ? previous.days as string[] : []), day])].sort();
    await saveEntity(query, id, kind, name, { ...previous, description: text(memory.description, 2000) || previous.description, evidence, days, last_seen: day });
    byName.set(name.toLowerCase(), id);
    if (typeof memory.id === 'string') byName.set(memory.id.toLowerCase(), id);
  }

  const occurrence = async (kind: 'event' | 'conversation', item: Row, refs: unknown) => {
    const name = text(item.title, 200);
    const start = at(item.start), end = at(item.end) ?? start;
    if (!name || !start) return;
    const id = await uniqueId(query, `${kind}:${compact}-${String(item.start).replace(':', '').slice(0, 4)}-${slug(name)}`);
    const properties: Row = { day, t_start: start, t_end: end, description: text(item.description ?? item.summary, 3000) };
    if (kind === 'conversation') {
      properties.summary = text(item.summary, 3000);
      // The original words, as transcribed, for the conversation's time span.
      properties.transcript = minutes.flatMap((minute) => minute.transcript)
        .filter((turn) => turn.start >= start && turn.start <= new Date(Date.parse(end!) + 59_000).toISOString());
    }
    await saveEntity(query, id, kind, name, properties);
    for (const ref of Array.isArray(refs) ? refs : []) {
      const other = resolve(ref);
      if (other && await exists(other)) await saveLink(query, id, other, kind === 'conversation' ? `Took part in "${name}" on ${day}.` : `Related to "${name}" on ${day}.`);
    }
  };
  for (const event of list(json.events)) await occurrence('event', event, event.related);
  for (const conversation of list(json.conversations)) await occurrence('conversation', conversation, conversation.participants);

  for (const link of list(json.links)) {
    const a = resolve(link.a), b = resolve(link.b);
    if (a && b && await exists(a) && await exists(b)) await saveLink(query, a, b, text(link.text, 500));
  }

  const diary = (json.diary ?? {}) as Row;
  const diaryText = text(diary.text, 30_000);
  if (!diaryText) throw new Error('The consolidation produced no diary');
  // Each ⟦HH:MM⟧ anchor points at the recorded minute it names, so an agent can look at that moment.
  const moments = [...diaryText.matchAll(/⟦(\d{1,2}:\d{2})⟧/g)].map((match) => {
    const t = at(match[1]);
    const minute = t ? minutes.find((item) => Math.abs(Date.parse(item.minute) - Date.parse(t)) < 60_000) : undefined;
    return { anchor: match[1], t, capture_id: minute?.capture_id ?? null, minute: minute?.minute ?? null };
  });
  const diaryId = `diary:${compact}`;
  const title = text(diary.title, 200) || `Diary ${day}`;
  await saveEntity(query, diaryId, 'diary', title, { day, t_start: instantAt(day, '00:00', timeZone)?.toISOString(), summary: title,
    text: diaryText, description: diaryText, moments, timezone: timeZone });
  for (const ref of Array.isArray(json.diary_mentions) ? json.diary_mentions : []) {
    const other = resolve(ref);
    if (other && await exists(other)) await saveLink(query, diaryId, other, `The diary of ${day} mentions this.`);
  }
  return cost;
}

// Sleeps one day now (also before it has ended, for a manual run). Returns false when episodes remain to be
// digested after the deadline; calling again continues where it stopped.
export async function sleepDay(deps: SleepDeps, day: string, timeZone: string, { deadline = Date.now() + 240_000 } = {}) {
  const { query } = deps;
  await query(`INSERT INTO sleep_days (day, timezone, status, attempts, claimed_at) VALUES ($1, $2, 'running', 1, now())
    ON CONFLICT (day) DO UPDATE SET timezone = EXCLUDED.timezone, status = 'running', claimed_at = now(), updated_at = now(),
      attempts = CASE WHEN sleep_days.status = 'running' THEN sleep_days.attempts ELSE sleep_days.attempts + 1 END`, [day, timeZone]);
  try {
    const minutes = await dayMinutes(query, day, timeZone);
    if (!minutes.length) throw new Error('No observations for this day');
    const digested = await digestEpisodes(deps, day, timeZone, episodesOf(minutes, timeZone), deadline);
    await query('UPDATE sleep_days SET cost_usd = cost_usd + $2, updated_at = now() WHERE day = $1', [day, digested.cost]);
    if (!digested.complete) return false;
    const cost = await consolidate(deps, day, timeZone, minutes);
    await query(`UPDATE sleep_days SET status = 'done', finished_at = now(), claimed_at = NULL, error = NULL,
      cost_usd = cost_usd + $2, updated_at = now() WHERE day = $1`, [day, cost]);
    return true;
  } catch (error) {
    await query(`UPDATE sleep_days SET status = 'failed', claimed_at = NULL, error = $2, updated_at = now() WHERE day = $1`,
      [day, String((error as Error).message ?? error).slice(0, 500)]);
    throw error;
  }
}

// Days that ended at least an hour ago, whose minutes are all processed, and that were not slept since their last
// observation (or failed, and are due for another try).
export async function dueDays(query: Query, timeZone: string, now: Date) {
  const rows = await query(`SELECT d.day::text AS day FROM (
      SELECT (minute AT TIME ZONE $1)::date AS day, max(updated_at) AS changed,
        count(*) FILTER (WHERE status IN ('pending', 'processing')) AS waiting, count(*) FILTER (WHERE status = 'done') AS done
      FROM observations GROUP BY 1) d
    LEFT JOIN sleep_days s ON s.day = d.day
    WHERE d.done > 0 AND d.waiting = 0 AND ((d.day + 1)::timestamp AT TIME ZONE $1) <= $2::timestamptz - make_interval(hours => ${SETTLE_HOURS})
      AND (s.day IS NULL
        OR (s.status = 'done' AND d.changed > s.finished_at)
        OR (s.status = 'failed' AND s.attempts < ${MAX_ATTEMPTS} AND s.updated_at < $2::timestamptz - interval '30 minutes')
        OR (s.status = 'running' AND s.claimed_at < $2::timestamptz - interval '10 minutes'))
    ORDER BY d.day`, [timeZone, now.toISOString()]);
  return rows.map((row) => String(row.day));
}

// Sleeps every due day in order until the deadline. Returns whether work remains.
export async function sleepDueDays(deps: SleepDeps, timeZone: string, { deadline = Date.now() + 240_000 } = {}) {
  const days = await dueDays(deps.query, timeZone, (deps.now ?? (() => new Date()))());
  for (const day of days) {
    if (Date.now() > deadline) return true;
    try {
      if (!(await sleepDay(deps, day, timeZone, { deadline }))) return true;
    } catch { /* recorded on the day; the next run retries it */ }
  }
  return false;
}

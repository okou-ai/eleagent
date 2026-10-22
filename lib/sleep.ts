import type { Query } from './mcp.ts';

// Sleep: once a day has ended in the owner's time zone, an agent (Pi, in a Vercel Sandbox: lib/sleep-run.ts) turns
// its observations into long-term memory and a diary with the tools in lib/sleep-tools.ts. This module holds what
// both share: the owner's local time, episodes, conversation candidates, the memory store and which days are due.

export const TEXT_MODEL = 'z-ai/glm-5.3-flash';
export type Complete = (system: string, user: string, maxTokens: number) => Promise<{ json: Record<string, unknown>; cost: number }>;

const EPISODE_GAP_MINUTES = 10;
const EPISODE_MAX_MINUTES = 45;
const EPISODE_MOVE_METERS = 300;
const SETTLE_HOURS = 1;
const MAX_ATTEMPTS = 3;
export const MEMORY_KINDS = ['person', 'object', 'place', 'routine', 'reading'];
// A talk is a stretch of minutes with speech; one closer than this to the last belongs to it.
const TALK_GAP_MINUTES = 2;

export type Row = Record<string, unknown>;
type Location = { latitude?: number; longitude?: number };
export interface Minute {
  capture_id: string; minute: string; started_at: string; ended_at: string; summary: string;
  perception: Row; transcript: { start: string; speaker: string | null; text: string }[]; location: Location | null;
}
export interface Episode { id: string; minutes: Minute[] }

export const iso = (value: unknown) => new Date(value as string).toISOString();
export const list = (value: unknown) => (Array.isArray(value) ? value : []) as Row[];
export const text = (value: unknown, max = 2000) => (typeof value === 'string' ? value.trim().slice(0, max) : '');

// --- Time in the owner's time zone ---

export function parts(date: Date, timeZone: string) {
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

// One minute as the agent reads it.
export function minuteLines(minute: Minute, timeZone: string) {
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

// --- Storage helpers ---

export const slug = (value: string) => value.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'item';

export function searchTextOf(name: string, properties: Row) {
  return [name, properties.description, properties.summary, properties.text, ...list(properties.evidence).map((item) => item.text)]
    .filter((part) => typeof part === 'string' && part).join('\n');
}

export async function saveEntity(query: Query, id: string, kind: string, name: string, properties: Row) {
  await query(`INSERT INTO entities (id, kind, name, properties, search_text) VALUES ($1, $2, $3, $4, $5)
    ON CONFLICT (id) DO UPDATE SET kind = EXCLUDED.kind, name = EXCLUDED.name, properties = EXCLUDED.properties,
      search_text = EXCLUDED.search_text, updated_at = now()`, [id, kind, name, JSON.stringify(properties), searchTextOf(name, properties)]);
}

export async function saveLink(query: Query, x: string, y: string, sentence: string) {
  if (!sentence || x === y) return;
  const [a, b] = x < y ? [x, y] : [y, x];
  await query(`INSERT INTO entity_links (a, b, text) VALUES ($1, $2, $3)
    ON CONFLICT (a, b) DO UPDATE SET updated_at = now(),
      text = CASE WHEN position(EXCLUDED.text IN entity_links.text) > 0 THEN entity_links.text ELSE entity_links.text || ' ' || EXCLUDED.text END`,
  [a, b, sentence.slice(0, 1000)]);
}

export async function uniqueId(query: Query, base: string) {
  for (let n = 1; ; n++) {
    const id = n === 1 ? base : `${base}-${n}`;
    if (!(await query('SELECT 1 FROM entities WHERE id = $1', [id])).length) return id;
  }
}

// --- One day ---

export async function dayMinutes(query: Query, day: string, timeZone: string): Promise<Minute[]> {
  const rows = await query(`SELECT o.capture_id, o.minute, o.started_at, o.ended_at, o.summary, o.perception, o.transcript,
      (SELECT k.meta->'locations'->-1 FROM clips k WHERE k.capture_id = o.capture_id AND k.captured_at >= o.minute
        AND k.captured_at < o.minute + interval '1 minute' AND jsonb_array_length(coalesce(k.meta->'locations', '[]')) > 0
        ORDER BY k.captured_at DESC LIMIT 1) AS location
    FROM observations o WHERE o.status = 'done' AND (o.minute AT TIME ZONE $2)::date = $1::date ORDER BY o.minute`, [day, timeZone]);
  return rows.map((row) => ({ capture_id: String(row.capture_id), minute: iso(row.minute), started_at: iso(row.started_at),
    ended_at: iso(row.ended_at), summary: String(row.summary ?? ''), perception: (row.perception ?? {}) as Row,
    transcript: (row.transcript ?? []) as Minute['transcript'], location: (row.location ?? null) as Location | null }));
}

// Conversation candidates: stretches of minutes with speech, each of which the agent must remember or dismiss.
export interface Talk { id: string; start: string; end: string; minutes: number; turns: number; speakers: number }
export function talksOf(minutes: Minute[], timeZone: string): Talk[] {
  const talks: Minute[][] = [];
  for (const minute of minutes.filter((item) => item.transcript.some((turn) => turn.text.trim()))) {
    const current = talks.at(-1);
    const gap = current ? (Date.parse(minute.minute) - Date.parse(current.at(-1)!.minute)) / 60_000 : Infinity;
    if (current && gap <= TALK_GAP_MINUTES) current.push(minute); else talks.push([minute]);
  }
  return talks.map((group) => {
    const start = new Date(group[0].minute);
    const turns = group.flatMap((minute) => minute.transcript);
    return { id: `talk:${localDay(start, timeZone).replaceAll('-', '')}-${localTime(start, timeZone).replace(':', '')}`,
      start: group[0].minute, end: group.at(-1)!.ended_at, minutes: group.length, turns: turns.length,
      speakers: Math.max(...group.map((minute) => new Set(minute.transcript.map((turn) => turn.speaker)).size)) };
  });
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
        OR (s.status = 'running' AND s.claimed_at < $2::timestamptz - interval '60 minutes'))
    ORDER BY d.day`, [timeZone, now.toISOString()]);
  return rows.map((row) => String(row.day));
}

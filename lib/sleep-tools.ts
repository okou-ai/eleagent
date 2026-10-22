import type { ExtractFrames, Query, SignDownload } from './mcp.ts';
import {
  MEMORY_KINDS, dayMinutes, episodesOf, instantAt, iso, list, localTime, minuteLines, parts, saveEntity, saveLink, slug, talksOf,
  text, uniqueId, type Minute, type Row,
} from './sleep.ts';

// The sleeping agent's tools. Pi calls them from its sandbox through POST /api/sleep/tools; each works on one day of
// one run and reads or writes the memory in Postgres. Names follow the self-hosted Eleagent's sleep tools.

export interface SleepRun { day: string; timeZone: string; startedAt: string }
export interface ToolDeps { query: Query; signDownload: SignDownload; extractFrames: ExtractFrames }
export interface ToolResult { text: string; images?: { data: string; mimeType: string }[] }

export class ToolInputError extends Error {}

const CATALOG_SIZE = 400;
const MAX_MOMENTS = 6;
const PROTECTED = (id: string) => id === 'person:owner' || id.startsWith('conversation:') || id.startsWith('diary:');
const compact = (day: string) => day.replaceAll('-', '');
const fail = (message: string): never => { throw new ToolInputError(message); };

async function entityRow(query: Query, id: string) {
  return (await query('SELECT id, kind, name, properties FROM entities WHERE id = $1', [id]))[0] as Row | undefined;
}

async function talkStatus(query: Query, run: SleepRun) {
  const [row] = await query('SELECT talks FROM sleep_days WHERE day = $1', [run.day]);
  const marked = { ...((row?.talks ?? {}) as Record<string, string>) };
  // Conversations saved by an earlier run of the day already remember their talk.
  for (const saved of await query(`SELECT id, properties->>'talk' AS talk FROM entities WHERE kind = 'conversation' AND properties->>'day' = $1`, [run.day])) {
    if (saved.talk && !marked[String(saved.talk)]) marked[String(saved.talk)] = `remembered as ${saved.id}`;
  }
  return marked;
}

async function markTalk(query: Query, run: SleepRun, talk: string, status: string) {
  await query(`UPDATE sleep_days SET talks = talks || jsonb_build_object($2::text, $3::text), updated_at = now() WHERE day = $1`, [run.day, talk, status]);
}

// "HH:MM" or "HH:MM:SS" on the run's day, in the owner's time zone.
function instant(run: SleepRun, value: unknown): Date {
  const match = /^(\d{1,2}:\d{2})(?::(\d{2}))?$/.exec(String(value ?? '').trim());
  const at = match && instantAt(run.day, match[1], run.timeZone);
  if (!at) return fail(`Times are local HH:MM or HH:MM:SS, not ${JSON.stringify(value)}`);
  return new Date(at.getTime() + Number(match![2] ?? 0) * 1000);
}

async function linkAll(query: Query, from: string, refs: unknown, sentence: string) {
  const linked: string[] = [];
  for (const ref of Array.isArray(refs) ? refs : []) {
    const id = String(ref);
    if (id !== from && await entityRow(query, id)) {
      await saveLink(query, from, id, sentence);
      linked.push(id);
    }
  }
  return linked;
}

const tools: Record<string, (deps: ToolDeps, run: SleepRun, args: Row) => Promise<ToolResult>> = {
  async recall_day({ query }, run) {
    // The owner is always there to link to.
    if (!await entityRow(query, 'person:owner')) await saveEntity(query, 'person:owner', 'person', 'Owner', { description: 'The owner of this memory.' });
    const minutes = await dayMinutes(query, run.day, run.timeZone);
    const status = await talkStatus(query, run);
    const time = (value: string) => localTime(new Date(value), run.timeZone);
    const episodes = episodesOf(minutes, run.timeZone).map((episode) => {
      const places = [...new Set(episode.minutes.map((minute) => text(minute.perception.place, 60)).filter(Boolean))].slice(0, 3);
      return `- ${episode.id}  ${time(episode.minutes[0].minute)}–${time(episode.minutes.at(-1)!.ended_at)}, ${episode.minutes.length} min` +
        `${places.length ? ` | ${places.join('; ')}` : ''} | ${text(episode.minutes[0].summary, 160)}`;
    });
    const talks = talksOf(minutes, run.timeZone).map((talk) => `- ${talk.id}  ${time(talk.start)}–${time(talk.end)}, ${talk.minutes} min, ` +
      `${talk.turns} turns, up to ${talk.speakers} speakers per minute — ${status[talk.id] ?? 'not yet remembered or dismissed'}`);
    const diary = await entityRow(query, `diary:${compact(run.day)}`);
    const today = await query(`SELECT id, kind, name FROM entities WHERE kind IN ('event', 'conversation') AND properties->>'day' = $1 ORDER BY id`, [run.day]);
    const catalog = await query(`SELECT id, kind, name, properties->>'description' AS description FROM entities WHERE kind = ANY($1)
      ORDER BY updated_at DESC LIMIT ${CATALOG_SIZE}`, [MEMORY_KINDS]);
    return { text: [
      `Day ${run.day} (${run.timeZone}). ${minutes.length} recorded minutes${minutes.length ? `, ${time(minutes[0].minute)} to ${time(minutes.at(-1)!.ended_at)}` : ''}.`,
      `Episodes (view_episode shows each minute; view_moments shows what the camera saw):\n${episodes.join('\n') || '(none)'}`,
      `Conversation candidates (each must be remembered with remember_conversation or dismissed with dismiss_conversation before finish):\n${talks.join('\n') || '(none)'}`,
      `This day's diary so far: ${diary ? `\n${(diary.properties as Row).text}` : '(none)'}`,
      `This day's events and conversations already saved:\n${today.map((row) => `- ${row.id} (${row.name})`).join('\n') || '(none)'}`,
      `Long-term memories (id | kind | name | description), most recently updated first:\n` +
        `${catalog.map((row) => `${row.id} | ${row.kind} | ${row.name} | ${text(row.description, 160)}`).join('\n') || '(none yet)'}`,
    ].join('\n\n') };
  },

  async view_episode({ query }, run, { id }) {
    const minutes = await dayMinutes(query, run.day, run.timeZone);
    const episode = episodesOf(minutes, run.timeZone).find((item) => item.id === id) ?? fail(`No episode ${id} on ${run.day}; recall_day lists them`);
    return { text: episode.minutes.map((minute: Minute) => minuteLines(minute, run.timeZone)).join('\n') };
  },

  async view_moments({ query, signDownload, extractFrames }, run, { times, size }) {
    const wanted = (Array.isArray(times) ? times : [times]).slice(0, MAX_MOMENTS).map((value) => instant(run, value));
    if (!wanted.length) fail('Give one to six local times');
    const images: ToolResult['images'] = [], lines: string[] = [];
    for (const at of wanted) {
      const [clip] = await query(`SELECT capture_id, captured_at, captured_end_at, pathname FROM clips WHERE captured_at <= $1
        ORDER BY captured_at DESC LIMIT 1`, [at.toISOString()]);
      const end = clip ? Date.parse(iso(clip.captured_end_at ?? clip.captured_at)) + 1000 : 0;
      const label = parts(at, run.timeZone).seconds;
      if (!clip || at.getTime() > end) { lines.push(`${label}: nothing was recorded`); continue; }
      const offset = Math.max(0, (at.getTime() - Date.parse(iso(clip.captured_at))) / 1000);
      try {
        const [jpeg] = await extractFrames((await signDownload(String(clip.pathname))).url, [offset], Math.min(Number(size) || 640, 1024));
        images.push({ data: jpeg.toString('base64'), mimeType: 'image/jpeg' });
        lines.push(`image ${images.length}: ${label} (recording ${clip.capture_id})`);
      } catch {
        lines.push(`${label}: the frame could not be decoded`);
      }
    }
    return { text: lines.join('\n'), images };
  },

  async view_memory({ query }, _run, { ids }) {
    const out: string[] = [];
    for (const id of (Array.isArray(ids) ? ids : [ids]).slice(0, 20).map(String)) {
      const row = await entityRow(query, id);
      if (!row) { out.push(`${id}: not found`); continue; }
      const links = await query('SELECT a, b, text FROM entity_links WHERE a = $1 OR b = $1 ORDER BY updated_at DESC LIMIT 50', [id]);
      out.push(`${id} (${row.kind}) ${row.name}\n${JSON.stringify(row.properties)}\nlinks:\n` +
        `${links.map((link) => `- ${link.a === id ? link.b : link.a}: ${link.text}`).join('\n') || '(none)'}`);
    }
    return { text: out.join('\n\n') };
  },

  async search_memory({ query }, _run, { query: words, kind }) {
    const pattern = `%${String(words ?? '').replace(/[\\%_]/g, '\\$&')}%`;
    const rows = await query(`SELECT id, kind, name, properties->>'description' AS description FROM entities
      WHERE (name ILIKE $1 OR search_text ILIKE $1) AND ($2::text IS NULL OR kind = $2) ORDER BY updated_at DESC LIMIT 30`,
    [pattern, typeof kind === 'string' ? kind : null]);
    return { text: rows.map((row) => `${row.id} | ${row.kind} | ${row.name} | ${text(row.description, 300)}`).join('\n') || 'No matches.' };
  },

  async consolidate({ query }, run, { id, kind, name, description, evidence, merge }) {
    const memoryKind = MEMORY_KINDS.includes(String(kind)) ? String(kind) : fail(`kind must be one of ${MEMORY_KINDS.join(', ')}`);
    const memoryName = text(name, 200) || fail('A memory needs a name');
    const existing = typeof id === 'string' && id ? await entityRow(query, id) ?? fail(`No memory ${id}; omit id to create one`) : null;
    if (existing && existing.kind !== memoryKind) fail(`${id} is a ${existing.kind}, not a ${memoryKind}`);
    const target = existing ? String(existing.id) : await uniqueId(query, `${memoryKind}:${slug(memoryName)}`);
    const previous = (existing?.properties ?? {}) as Row;
    // A new memory exists before others are merged into it, so their links can move to it.
    if (!existing) await saveEntity(query, target, memoryKind, memoryName, {});
    let gathered = [...list(previous.evidence), ...list(evidence).map((item) => ({ day: run.day, time: text(item.time, 8), text: text(item.text, 500) }))];
    const merged: string[] = [];
    for (const other of (Array.isArray(merge) ? merge : []).map(String)) {
      const row = other !== target && !PROTECTED(other) ? await entityRow(query, other) : undefined;
      if (!row || row.kind !== memoryKind) continue;
      gathered = [...gathered, ...list((row.properties as Row).evidence)];
      for (const link of await query('SELECT a, b, text FROM entity_links WHERE a = $1 OR b = $1', [other])) {
        await saveLink(query, target, String(link.a === other ? link.b : link.a), String(link.text));
      }
      await query('DELETE FROM entities WHERE id = $1', [other]);
      merged.push(other);
    }
    const days = [...new Set([...(Array.isArray(previous.days) ? previous.days as string[] : []), run.day])].sort();
    await saveEntity(query, target, memoryKind, memoryName, { ...previous, description: text(description, 3000) || previous.description,
      evidence: gathered.slice(-30), days, last_seen: run.day });
    return { text: `${existing ? 'Updated' : 'Created'} ${target}${merged.length ? `; merged ${merged.join(', ')} into it` : ''}.` };
  },

  async remember_event({ query }, run, { title, description, start, end, related }) {
    const name = text(title, 200) || fail('An event needs a title');
    const from = instant(run, start), to = end ? instant(run, end) : from;
    const id = await uniqueId(query, `event:${compact(run.day)}-${parts(from, run.timeZone).time.replace(':', '')}-${slug(name)}`);
    await saveEntity(query, id, 'event', name, { day: run.day, t_start: from.toISOString(), t_end: to.toISOString(), description: text(description, 3000) });
    const linked = await linkAll(query, id, related, `Involved in "${name}" on ${run.day}.`);
    return { text: `Saved ${id}${linked.length ? `, linked to ${linked.join(', ')}` : ''}.` };
  },

  async remember_conversation({ query }, run, { talk, title, summary, participants }) {
    const minutes = await dayMinutes(query, run.day, run.timeZone);
    const candidate = talksOf(minutes, run.timeZone).find((item) => item.id === talk) ?? fail(`No conversation candidate ${talk}; recall_day lists them`);
    const name = text(title, 200) || fail('A conversation needs a title');
    const transcript = minutes.filter((minute) => minute.minute >= candidate.start && minute.minute < candidate.end).flatMap((minute) => minute.transcript);
    const id = await uniqueId(query, `conversation:${candidate.id.slice('talk:'.length)}-${slug(name)}`);
    await saveEntity(query, id, 'conversation', name, { day: run.day, talk: candidate.id, t_start: candidate.start, t_end: candidate.end,
      summary: text(summary, 3000), description: text(summary, 3000), transcript });
    const linked = await linkAll(query, id, participants, `Took part in "${name}" on ${run.day}.`);
    await markTalk(query, run, candidate.id, `remembered as ${id}`);
    return { text: `Saved ${id} with ${transcript.length} transcribed turns${linked.length ? `, linked to ${linked.join(', ')}` : ''}.` };
  },

  async dismiss_conversation({ query }, run, { talk, reason }) {
    const minutes = await dayMinutes(query, run.day, run.timeZone);
    if (!talksOf(minutes, run.timeZone).some((item) => item.id === talk)) fail(`No conversation candidate ${talk}`);
    const why = text(reason, 300) || fail('Say why it is not worth remembering (e.g. a video playing, background chatter)');
    await markTalk(query, run, String(talk), `dismissed: ${why}`);
    return { text: `Dismissed ${talk}.` };
  },

  async link({ query }, _run, { a, b, text: sentence, rewrite }) {
    for (const id of [a, b]) if (!await entityRow(query, String(id))) fail(`No memory ${id}`);
    const [x, y] = String(a) < String(b) ? [String(a), String(b)] : [String(b), String(a)];
    if (rewrite) {
      await query('DELETE FROM entity_links WHERE a = $1 AND b = $2', [x, y]);
      if (!text(sentence)) return { text: `Removed the link between ${x} and ${y}.` };
    }
    await saveLink(query, x, y, text(sentence, 1000) || fail('A link is one plain sentence'));
    return { text: `Linked ${x} and ${y}.` };
  },

  async revise({ query }, _run, { id, name, description }) {
    const row = await entityRow(query, String(id)) ?? fail(`No memory ${id}`);
    if (String(id).startsWith('diary:')) fail('Rewrite the diary with write_diary');
    const properties = row.properties as Row;
    await saveEntity(query, String(id), String(row.kind), text(name, 200) || String(row.name),
      { ...properties, description: text(description, 3000) || properties.description });
    return { text: `Revised ${id}.` };
  },

  async forget({ query }, _run, { ids }) {
    const forgotten: string[] = [], kept: string[] = [];
    for (const id of (Array.isArray(ids) ? ids : [ids]).map(String)) {
      if (PROTECTED(id)) { kept.push(id); continue; }
      if ((await query('DELETE FROM entities WHERE id = $1 RETURNING id', [id])).length) forgotten.push(id);
    }
    return { text: `Forgot ${forgotten.join(', ') || 'nothing'}${kept.length ? `; ${kept.join(', ')} cannot be forgotten` : ''}.` };
  },

  async write_diary({ query }, run, { title, text: body, refs }) {
    const diaryText = text(body, 40_000) || fail('The diary is empty');
    const minutes = await dayMinutes(query, run.day, run.timeZone);
    // Each ⟦HH:MM⟧ anchor points at the recorded minute it names, so an agent can look at that moment later.
    const moments = [...diaryText.matchAll(/⟦(\d{1,2}:\d{2})⟧/g)].map((match) => {
      const t = instantAt(run.day, match[1], run.timeZone)?.toISOString() ?? null;
      const minute = t ? minutes.find((item) => Math.abs(Date.parse(item.minute) - Date.parse(t)) < 60_000) : undefined;
      return { anchor: match[1], t, capture_id: minute?.capture_id ?? null, minute: minute?.minute ?? null };
    });
    const id = `diary:${compact(run.day)}`;
    const name = text(title, 200) || `Diary ${run.day}`;
    await saveEntity(query, id, 'diary', name, { day: run.day, t_start: instantAt(run.day, '00:00', run.timeZone)?.toISOString(),
      summary: name, text: diaryText, description: diaryText, moments, timezone: run.timeZone, written_at: new Date().toISOString() });
    await linkAll(query, id, refs, `The diary of ${run.day} mentions this.`);
    const unmatched = moments.filter((moment) => !moment.minute).map((moment) => moment.anchor);
    return { text: `Wrote the diary of ${run.day}: ${moments.length} time anchors` +
      (unmatched.length ? `; nothing was recorded at ${unmatched.join(', ')} (use times from the material)` : ', all matched to recorded minutes') + '.' };
  },

  async finish({ query }, run) {
    const minutes = await dayMinutes(query, run.day, run.timeZone);
    const status = await talkStatus(query, run);
    const missing = talksOf(minutes, run.timeZone).filter((talk) => !status[talk.id]).map((talk) => talk.id);
    const diary = await entityRow(query, `diary:${compact(run.day)}`);
    const written = diary && String((diary.properties as Row).written_at ?? '') >= run.startedAt;
    const problems = [...(missing.length ? [`conversation candidates neither remembered nor dismissed: ${missing.join(', ')}`] : []),
      ...(written ? [] : ['the diary was not written in this run (write_diary)'])];
    if (problems.length) return { text: `Not finished: ${problems.join('; ')}.` };
    await query(`UPDATE sleep_days SET status = 'done', finished_at = now(), claimed_at = NULL, error = NULL, updated_at = now()
      WHERE day = $1`, [run.day]);
    return { text: 'The night is complete. Stop here.' };
  },
};

export const SLEEP_TOOLS = Object.keys(tools);

export async function runTool(deps: ToolDeps, run: SleepRun, name: string, args: Row): Promise<ToolResult> {
  const tool = tools[name] ?? fail(`Unknown tool ${name}`);
  return tool(deps, run, args ?? {});
}

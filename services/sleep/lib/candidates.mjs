// Night preparation: turn the working set into candidates the agent can reason about.
// Objects: average-linkage clusters per detector label (+ hints to existing memories).
// Faces/voices: the existing clusters. Conversations: speech cut at long pauses.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { J, agglomerate, localTime, cosine, mean, normalize, pool } from './util.mjs';

const OBJECT_CUT = 0.5;            // cosine-distance cutoff
const CONVERSATION_GAP_MS = 90_000;
const CONVERSATION_MIN_LINES = 3, CONVERSATION_MIN_SECONDS = 15;
const CROPS_PER_CANDIDATE = 6;

const auth = () => ({ Authorization: `Bearer ${process.env.SCENE_ARCHIVE_TOKEN}` });
const ARCHIVE_URL = () => process.env.ARCHIVE_URL || 'http://archive:22401';

/** File name of a cover crop: {media_id, offset, box: [x, y, w, h], w, h} -> stable hash. */
export const coverFile = (cover) => `c-${crypto.createHash('sha1').update(JSON.stringify([cover.media_id, cover.offset, cover.box])).digest('hex').slice(0, 16)}.jpg`;

/** Cut a cover crop out of the archived original (the archive is the only source; no recognizer API). */
export async function crop(cover, dir) {
  if (!cover?.media_id || !cover.box || !cover.w) return null;
  const file = path.join(dir, coverFile(cover));
  if (fs.existsSync(file)) return file;
  try {
    const [bx, by, bw, bh] = cover.box;
    const x = Math.max(0, bx), y = Math.max(0, by), w = Math.min(cover.w - x, bw), h = Math.min(cover.h - y, bh);
    if (w < 4 || h < 4) return null;
    const url = `${ARCHIVE_URL()}/v1/archive/media/${cover.media_id}/frame?t=${Number(cover.offset || 0).toFixed(3)}` +
      `&box=${[x, y, w, h].map((v) => v.toFixed(1)).join(',')}&ref_w=${cover.w}&ref_h=${cover.h}&pad=0.15&size=256`;
    const res = await fetch(url, { headers: auth(), signal: AbortSignal.timeout(30_000) });
    if (!res.ok) return null;
    fs.writeFileSync(file, Buffer.from(await res.arrayBuffer()));
    return file;
  } catch {
    return null;
  }
}

/** Pick samples from as many different episodes as possible (like recalling different occasions). */
function spreadSamples(members, k) {
  const byEp = new Map();
  for (const m of [...members].sort((a, b) => Number(b.frames || 1) - Number(a.frames || 1))) {
    const list = byEp.get(m.episode_id) || [];
    list.push(m); byEp.set(m.episode_id, list);
  }
  const out = [];
  for (let round = 0; out.length < k; round++) {
    let any = false;
    for (const list of byEp.values()) {
      if (list.length > round && out.length < k) { const crops = J(list[round].crops) || []; if (crops[0]) out.push(crops[0]); any = true; }
    }
    if (!any) break;
  }
  return out;
}

export async function buildCandidates(ws, runDir, { log }) {
  const imgDir = path.join(runDir, 'img');
  fs.mkdirSync(imgDir, { recursive: true });
  const nodes = Object.values(ws.nodes);
  // Fragment -> its cluster, or the memory entity that cluster was absorbed into.
  const memberOf = new Map(nodes.filter((n) => n.cluster_id).map((n) => [n.id, n.cluster_id]));
  const gists = nodes.filter((n) => n.layer === 'memory' && !['conversation', 'diary'].includes(n.kind));
  const gistVec = (g, key) => (g[key] ? normalize(J(g[key]).map(Number)) : null);
  const hints = (vec, key) => !vec ? [] : gists.map((g) => ({ g, v: gistVec(g, key) })).filter((x) => x.v)
    .map((x) => ({ id: x.g.id, name: x.g.name, sim: +cosine(vec, x.v).toFixed(2) })).filter((x) => x.sim >= 0.55)
    .sort((a, b) => b.sim - a.sim).slice(0, 3);
  const cands = [];

  // Objects
  const apps = nodes.filter((n) => n.kind === 'object_appearance' && n.object_vec);
  const recognized = new Map(), byLabel = new Map();
  for (const a of apps) {
    const target = memberOf.get(a.id);
    if (target && ws.nodes[target]?.layer === 'memory') { (recognized.get(target) || recognized.set(target, []).get(target)).push(a); continue; }
    (byLabel.get(a.label) || byLabel.set(a.label, []).get(a.label)).push(a);
  }
  const pushObject = (id, label, members, recognizedAs) => {
    const vec = mean(members.map((m) => normalize(J(m.object_vec).map(Number))));
    cands.push({ id, modality: 'object', label, fragments: members.map((m) => m.id), episodes: [...new Set(members.map((m) => m.episode_id))],
      frames: members.reduce((s, m) => s + Number(m.frames || 1), 0), t_first: members.map((m) => m.t_start).sort()[0],
      t_last: members.map((m) => m.t_start).sort().at(-1), recognized_as: recognizedAs, similar_memories: recognizedAs ? [] : hints(vec, 'object_vec'),
      samples: spreadSamples(members, CROPS_PER_CANDIDATE), vec });
  };
  for (const [gid, members] of recognized) pushObject(`obj-known-${gid.slice(-8)}`, members[0].label, members, gid);
  for (const [label, group] of byLabel) {
    const lab = agglomerate(group.map((a) => normalize(J(a.object_vec).map(Number))), OBJECT_CUT);
    const parts = new Map();
    group.forEach((a, i) => (parts.get(lab[i]) || parts.set(lab[i], []).get(lab[i])).push(a));
    for (const members of parts.values()) pushObject(`obj-${label.replace(/ /g, '_')}-${String(cands.length).padStart(3, '0')}`, label, members, null);
  }

  // Faces and voices: existing clusters (or appearances already linked to a person memory).
  for (const [kind, fragKind, vecKey] of [['face', 'face_appearance', 'face_vec'], ['voice', 'speech_segment', 'voice_vec']]) {
    const groups = new Map();
    for (const n of nodes.filter((x) => x.kind === fragKind)) {
      const t = memberOf.get(n.id);
      if (t) (groups.get(t) || groups.set(t, []).get(t)).push(n);
    }
    for (const [target, members] of groups) {
      const known = ws.nodes[target]?.layer === 'memory' ? target : null;
      const vec = mean(members.filter((m) => m[vecKey]).map((m) => normalize(J(m[vecKey]).map(Number))));
      const c = { id: `${kind}-${target.slice(-8)}`, modality: kind, cluster_id: known ? null : target, recognized_as: known,
        fragments: members.map((m) => m.id).concat(known ? [] : [target]), episodes: [...new Set(members.map((m) => m.episode_id).filter(Boolean))],
        t_first: members.map((m) => m.t_start).sort()[0], t_last: members.map((m) => m.t_start).sort().at(-1),
        similar_memories: known ? [] : hints(vec, vecKey), vec };
      if (kind === 'face') { c.count = members.length; c.samples = spreadSamples(members, CROPS_PER_CANDIDATE); }
      else { c.seconds = +members.reduce((s, m) => s + Number(m.duration_s || 0), 0).toFixed(1); c.sample_lines = [...members].sort((a, b) => Number(b.duration_s || 0) - Number(a.duration_s || 0)).slice(0, 6).map((m) => m.text); }
      cands.push(c);
    }
  }

  // Conversations: speech cut at long pauses or capture changes.
  const speech = nodes.filter((n) => n.kind === 'speech_segment' && n.text).sort((a, b) => a.t_start.localeCompare(b.t_start));
  const convs = [];
  let cur = null;
  for (const s of speech) {
    const t = new Date(s.t_start).getTime();
    if (!cur || s.capture_id !== cur.capture_id || t - cur.lastMs > CONVERSATION_GAP_MS) { cur = { capture_id: s.capture_id, lines: [], lastMs: t }; convs.push(cur); }
    cur.lines.push(s); cur.lastMs = t + Number(s.duration_s || 0) * 1000;
  }
  const voiceCand = new Map(cands.filter((c) => c.modality === 'voice').flatMap((c) => c.fragments.map((f) => [f, c.id])));
  for (const c of convs) {
    const seconds = c.lines.reduce((s, l) => s + Number(l.duration_s || 0), 0);
    if (c.lines.length < CONVERSATION_MIN_LINES && seconds < CONVERSATION_MIN_SECONDS) continue;
    const first = c.lines[0], last = c.lines.at(-1);
    const transcript = c.lines.map((l) => ({ t: l.t_start, speaker: voiceCand.get(l.id) || 'unknown', text: l.text }));
    cands.push({ id: `conv-${localTime(first.t_start).replace(':', '')}-${first.id.slice(-6)}`, modality: 'conversation', fragments: c.lines.map((l) => l.id),
      episodes: [...new Set(c.lines.map((l) => l.episode_id).filter(Boolean))], t_first: first.t_start,
      t_last: new Date(new Date(last.t_start).getTime() + Number(last.duration_s || 0) * 1000).toISOString(),
      seconds: +seconds.toFixed(1), speakers: [...new Set(transcript.map((l) => l.speaker))], transcript });
  }

  // Evidence crops for objects and faces.
  // Objects seen only once are listed without crops (fetched when the agent opens one); a long day has thousands.
  const withSamples = cands.filter((c) => c.samples?.length && (c.modality !== 'object' || c.fragments.length >= 2 || c.recognized_as));
  await pool(withSamples, 8, async (c) => { c.crops = (await pool(c.samples, 3, (s) => crop(s, imgDir))).filter(Boolean); });
  const fastCost = 0;
  log?.(`candidates: ${cands.length} (${['object', 'face', 'voice', 'conversation'].map((m) => `${m} ${cands.filter((c) => c.modality === m).length}`).join(', ')}), fast-model cost $${fastCost.toFixed(3)}`);
  return { candidates: cands, fastCost };
}

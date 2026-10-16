// Export memory entities, their links and cover crops for a static viewer page.
import fs from 'node:fs';
import path from 'node:path';
import { connect } from '/app/lib/graph.mjs';
import { crop } from '/app/lib/candidates.mjs';
const out = '/out'; fs.mkdirSync(`${out}/img`, { recursive: true });
const driver = connect(), s = driver.session();
const nodes = (await s.run("MATCH (e:Entity {layer:'memory'}) RETURN properties(e) AS p")).records.map((r) => r.get('p'));
const ids = nodes.map((n) => n.id);
const links = (await s.run('MATCH (a:Entity)-[l:LINK]->(b:Entity) WHERE a.id IN $ids OR b.id IN $ids RETURN a.id AS a, b.id AS b, properties(l) AS p', { ids })).records
  .map((r) => ({ a: r.get('a'), b: r.get('b'), ...r.get('p') }));
const stats = (await s.run('MATCH (e:Entity) RETURN coalesce(e.layer, "fragment") AS layer, count(*) AS n')).records.map((r) => [r.get('layer'), r.get('n')]);
await s.close(); await driver.close();
for (const n of nodes) {
  for (const k of ['object_vec', 'face_vec', 'voice_vec']) delete n[k];
  const covers = (n.covers ? JSON.parse(n.covers) : []).slice(0, 8);
  n.covers = [];
  for (const c of covers) { const f = await crop(c, `${out}/img`); if (f) n.covers.push(path.basename(f)); }
}
// Raw video/audio references: the archived clip behind each diary time anchor and the first clip of each conversation.
fs.mkdirSync(`${out}/clips`, { recursive: true });
async function clip(mediaId) {
  const file = `${mediaId}.mp4`;
  if (fs.existsSync(`${out}/clips/${file}`)) return file;
  const auth = { Authorization: `Bearer ${process.env.SCENE_ARCHIVE_TOKEN}` }, base = process.env.ARCHIVE_URL || 'http://archive:22401';
  try {
    const info = await (await fetch(`${base}/v1/archive/media/${mediaId}`, { headers: auth })).json();
    const dur = Math.max(0.5, Math.floor(Number(info.duration_seconds) * 10) / 10 - 0.05);
    const r = await fetch(`${base}/v1/archive/media/${mediaId}/excerpt?start=0&duration=${dur}&format=mp4`, { headers: auth, signal: AbortSignal.timeout(90_000) });
    if (!r.ok) return null;
    fs.writeFileSync(`${out}/clips/${file}`, Buffer.from(await r.arrayBuffer()));
    return file;
  } catch { return null; }
}
let clips = 0;
for (const n of nodes) {
  if (n.kind === 'diary') {
    n.moments = (n.moments ? JSON.parse(n.moments) : []);
    for (const m of n.moments) if (m.media_id && (m.clip = await clip(m.media_id))) clips++;
  }
  if (n.kind === 'conversation') {
    const first = (n.media_ids ? JSON.parse(n.media_ids) : [])[0];
    if (first && (n.clip = await clip(first))) clips++;
  }
}
console.log('clips', clips);
fs.writeFileSync(`${out}/memory.json`, JSON.stringify({ exported_at: new Date().toISOString(), nodes, links, stats }));
console.log('nodes', nodes.length, 'links', links.length, 'covers', nodes.reduce((a, n) => a + n.covers.length, 0));

// Neo4j access for the sleep service: pick captures to consolidate, load them as a working set,
// and apply the night's result in one transaction.
import neo4j from 'neo4j-driver';
import { randomUUID } from 'node:crypto';
import { pairKey } from './memory.mjs';
import { localDate } from './util.mjs';

export const DERIVED = ['episode', 'face_appearance', 'object_appearance', 'speech_segment', 'text_appearance'];
const TEST_PREFIXES = ['archive-probe-', 'entity-acceptance-'];
const SLEEP_ID = 'sleep';

export function connect() {
  return neo4j.driver(process.env.GRAPH_URL || 'bolt://graph:7687', neo4j.auth.none(), { disableLosslessIntegers: true });
}

export async function sleepState(session) {
  const r = await session.run('MERGE (s:SleepState {id: $id}) RETURN s', { id: SLEEP_ID });
  const s = r.records[0].get('s').properties;
  return { captures: new Set(s.captures || []), clusterMap: JSON.parse(s.cluster_map || '{}'), nights: s.nights || 0 };
}

/** Captures not consolidated yet, grouped by the local day they started on: { 'YYYY-MM-DD': [capture ids] }.
 * A capture that received clips within `idleMs` is still being recorded and is left for a later sleep. */
export async function pendingCaptures(session, state, idleMs) {
  const cutoffUs = (Date.now() - idleMs) * 1000;
  const r = await session.run(
    `MATCH (e:Entity) WHERE e.kind IN $kinds AND e.capture_id IS NOT NULL
     RETURN e.capture_id AS c, min(toInteger(e.t_start_us)) AS first, max(toInteger(e.t_end_us)) AS last`, { kinds: DERIVED });
  const out = {};
  for (const rec of r.records) {
    const c = rec.get('c');
    if (TEST_PREFIXES.some((p) => c.startsWith(p)) || (rec.get('last') || 0) >= cutoffUs) continue;
    (out[localDate(new Date(rec.get('first') / 1000))] ||= []).push(c);
  }
  for (const list of Object.values(out)) list.sort();
  return out;
}

/** Shared write serialization point for the minute job and nightly apply. */
export async function lockGraphWriter(tx) {
  const result = await tx.run("MERGE (s:SyncState {id: 'cursors'}) SET s.locked_at = $now RETURN s", { now: new Date().toISOString() });
  return result.records[0].get('s').properties;
}

function maintenanceBusy() {
  const error = new Error('minute maintenance is pending; sleep must wait');
  error.code = 'MAINTENANCE_PENDING';
  return error;
}

async function claimedSnapshot(session, read, { expiresAt } = {}) {
  const tx = session.beginTransaction();
  try {
    const state = await lockGraphWriter(tx);
    if (state.maintenance_token) throw maintenanceBusy();
    const now = Date.now();
    if (state.sleep_token && Date.parse(state.sleep_expires_at) > now) throw new Error('another sleep already owns a working snapshot');
    const expires = expiresAt || new Date(now + 8 * 3600_000).toISOString();
    if (!Number.isFinite(Date.parse(expires)) || Date.parse(expires) <= now) throw new Error('invalid sleep claim expiry');
    const result = await read(tx);
    const token = randomUUID();
    const protectedIds = new Set();
    for (const node of Object.values(result.nodes)) {
      for (const id of [node.id, node.cluster_id]) if (id?.startsWith('cluster:')) protectedIds.add(id.slice(8));
    }
    await tx.run(`MATCH (s:SyncState {id:'cursors'})
      SET s.sleep_token=$token,s.sleep_protected_ids=$ids,s.sleep_expires_at=$expires`,
      { token, ids: [...protectedIds], expires });
    result.sleep_claim = { token, expires_at: expires };
    await tx.commit();
    return result;
  } catch (error) {
    await tx.rollback();
    throw error;
  }
}

export async function releaseSleep(session, token) {
  if (!token) return;
  const tx = session.beginTransaction();
  try {
    await lockGraphWriter(tx);
    await tx.run(`MATCH (s:SyncState {id:'cursors'}) WHERE s.sleep_token=$token
      REMOVE s.sleep_token,s.sleep_protected_ids,s.sleep_expires_at`, { token });
    await tx.commit();
  } catch (error) {
    await tx.rollback();
    throw error;
  }
}

export async function loadWorkingSet(session, captures, options) {
  return claimedSnapshot(session, (tx) => readWorkingSet(tx, captures), options);
}

async function readWorkingSet(session, captures) {
  const nodes = new Map();
  const add = (rows) => { for (const rec of rows.records) { const p = rec.get('p'); nodes.set(p.id, p); } };
  add(await session.run(
    `MATCH (e:Entity) WHERE e.capture_id IN $caps AND (e.kind IN $kinds OR e.kind = 'session') RETURN properties(e) AS p`,
    { caps: captures, kinds: DERIVED }));
  // Clusters the fragments belong to (fragments carry cluster_id), with how many members lie outside tonight's captures.
  add(await session.run(
    `MATCH (f:Entity) WHERE f.capture_id IN $caps AND f.cluster_id IS NOT NULL
     WITH DISTINCT f.cluster_id AS cid
     MATCH (c:Entity {id: cid}) WHERE c.kind ENDS WITH '_cluster'
     OPTIONAL MATCH (o:Entity {cluster_id: cid}) WHERE NOT o.capture_id IN $caps
     WITH c, count(o) AS outside RETURN c {.*, _outside_members: outside} AS p`, { caps: captures }));
  add(await session.run(`MATCH (g:Entity) WHERE g.layer = 'memory' RETURN properties(g) AS p`));
  return { nodes: Object.fromEntries(nodes), edges: await loadLinks(session, [...nodes.keys()]) };
}

/** Links among the given nodes, one per pair: {a, b, text}. */
async function loadLinks(session, ids) {
  const edges = {};
  const r = await session.run(
    `MATCH (a:Entity)-[l:LINK]-(b:Entity) WHERE a.id IN $ids AND b.id IN $ids AND a.id < b.id
     RETURN a.id AS a, b.id AS b, l.text AS text ORDER BY l.created_at`, { ids });
  for (const rec of r.records) {
    const [a, b, text] = ['a', 'b', 'text'].map((k) => rec.get(k));
    const k = pairKey(a, b);
    edges[k] = edges[k] ? { ...edges[k], text: `${edges[k].text}\n${text}`, _dirty: true } : { a, b, text: text || '' };
  }
  return edges;
}

/** All long-term memory entities and the links among them (nightly integration works on memories only). */
export async function loadMemoryLayer(session, options) {
  return claimedSnapshot(session, async (tx) => {
    const nodes = {};
    for (const rec of (await tx.run(`MATCH (g:Entity) WHERE g.layer = 'memory' RETURN properties(g) AS p`)).records) {
      const p = rec.get('p'); nodes[p.id] = p;
    }
    return { nodes, edges: await loadLinks(tx, Object.keys(nodes)) };
  }, options);
}

const VECTOR_KEYS = ['object_vec', 'face_vec', 'voice_vec'];

function clean(props) {
  const out = {};
  for (const [k, v] of Object.entries(props)) {
    if (v === null || v === undefined) continue;
    if (VECTOR_KEYS.includes(k)) { out[k] = v.map(Number); continue; }
    out[k] = typeof v === 'object' ? JSON.stringify(v) : v;
  }
  return out;
}

/**
 * Apply a night: delete forgotten/absorbed nodes, upsert memory nodes, replace the text of every link
 * written tonight (one link per pair; created_at survives), delete unlinked pairs, and record
 * which captures and clusters are consolidated so graph-sync stops rebuilding them.
 */
export async function applyNight(session, { deleted, upserts, links, unlinked = [], captures = [], clusterMap = {}, mergedInto = {}, observedSync = {}, sleepToken }) {
  const tx = session.beginTransaction();
  try {
    const writer = await lockGraphWriter(tx);
    if (writer.maintenance_token) throw maintenanceBusy();
    if (!sleepToken || writer.sleep_token !== sleepToken || !(Date.parse(writer.sleep_expires_at) > Date.now())) {
      throw new Error('sleep snapshot claim expired or changed; reload before applying');
    }
    const now = new Date().toISOString();
    const cur = await tx.run(`MERGE (s:SleepState {id: $id}) RETURN s.cluster_map AS m`, { id: SLEEP_ID });
    const map = { ...JSON.parse(cur.records[0].get('m') || '{}'), ...clusterMap };
    const replacements = { ...map, ...mergedInto };
    const upsertIds = new Set(upserts.map((n) => n.id));
    const requested = new Set(deleted);
    function resolve(value) {
      const seen = new Set();
      while (value && Object.hasOwn(replacements, value)) {
        if (seen.has(value)) throw new Error('cyclic memory redirect');
        seen.add(value); value = replacements[value];
      }
      return value && requested.has(value) && !upsertIds.has(value) ? '' : value;
    }
    for (const key of Object.keys(map)) map[key] = resolve(map[key]);
    // A node read by the model may have received more observations while it reasoned.
    // Only retire the version the model actually consumed; never delete a whole capture.
    const current = await tx.run('UNWIND $ids AS id MATCH (e:Entity {id: id}) RETURN properties(e) AS p', { ids: deleted });
    const remove = new Set();
    const clusters = [];
    for (const rec of current.records) {
      const n = rec.get('p');
      if (n.kind?.endsWith('_cluster')) { clusters.push(n.id); remove.add(n.id); continue; }
      if (DERIVED.includes(n.kind) || n.kind === 'session') {
        if (!Object.hasOwn(observedSync, n.id) || (n.synced_at || null) !== observedSync[n.id]) continue;
        if (n.name || (n.user_notes && n.user_notes !== '[]')) continue;
      }
      remove.add(n.id);
    }
    await tx.run(
      `UNWIND $rows AS r MERGE (e:Entity {id: r.id}) ON CREATE SET e.created_at = r.now SET e += r.props, e.updated_at = r.now`,
      { rows: upserts.map((p) => ({ id: p.id, props: clean(p), now })) });
    // Unmapped clusters are still needed by observations outside the consumed snapshot,
    // including references written by this transaction's upserts.
    const remaining = await tx.run(
      `UNWIND $ids AS id MATCH (f:Entity {cluster_id: id}) WHERE NOT f.id IN $deleted RETURN DISTINCT id`,
      { ids: clusters, deleted: [...remove] });
    for (const rec of remaining.records) {
      const id = rec.get('id');
      if (!map[id]) { remove.delete(id); delete map[id]; }
    }
    // A protected or newly appended fragment still needs its episode. Inspect the
    // final live graph, including these upserts, instead of just the model snapshot.
    const referencedEpisodes = await tx.run(
      `MATCH (f:Entity) WHERE NOT f.id IN $deleted AND f.episode_id IN $deleted
       MATCH (e:Entity {id: f.episode_id, kind: 'episode'}) RETURN DISTINCT e.id AS id`,
      { deleted: [...remove] });
    for (const rec of referencedEpisodes.records) remove.delete(rec.get('id'));
    // Sessions are the capture containers; this schema connects them through
    // capture_id, not a session_id property. Keep only containers with live detail.
    const referencedSessions = await tx.run(
      `MATCH (f:Entity) WHERE f.kind IN $kinds AND NOT f.id IN $deleted AND f.capture_id IS NOT NULL
       WITH DISTINCT f.capture_id AS capture
       MATCH (s:Entity {kind: 'session', capture_id: capture}) WHERE s.id IN $deleted
       RETURN DISTINCT s.id AS id`,
      { deleted: [...remove], kinds: DERIVED });
    for (const rec of referencedSessions.records) remove.delete(rec.get('id'));
    // Redirect references from both clusters and older memory identities before deleting them.
    const redirects = new Map(Object.entries(map));
    for (const [from, to] of Object.entries(mergedInto)) redirects.set(from, resolve(to));
    for (const id of remove) if (!redirects.has(id)) redirects.set(id, '');
    const targets = [...new Set([...redirects.values()].filter(Boolean))];
    const live = await tx.run('UNWIND $ids AS id MATCH (e:Entity {id: id}) RETURN id', { ids: targets });
    const liveIds = new Set(live.records.map((r) => r.get('id')));
    for (const [from, to] of redirects) {
      if (to && !liveIds.has(to)) throw new Error('memory redirect target missing');
      if (from === to) throw new Error('self memory redirect');
    }
    await tx.run(
      'UNWIND $rows AS r MATCH (f:Entity {cluster_id: r.from}) SET f.cluster_id = r.to',
      { rows: [...redirects].map(([from, to]) => ({ from, to: to || null })) });
    for (let i = 0, ids = [...remove]; i < ids.length; i += 2000) {
      await tx.run('UNWIND $ids AS id MATCH (e:Entity {id: id}) DETACH DELETE e', { ids: ids.slice(i, i + 2000) });
    }
    await tx.run(
      `UNWIND $rows AS r MATCH (a:Entity {id: r.a}), (b:Entity {id: r.b})
       OPTIONAL MATCH (a)-[old:LINK]-(b)
       WITH a, b, r, collect(old) AS olds, min(old.created_at) AS created
       FOREACH (x IN olds | DELETE x)
       CREATE (a)-[:LINK {text: r.text, created_at: coalesce(created, $now), updated_at: $now}]->(b)`,
      { rows: links.filter((l) => l.a !== l.b).map((l) => (l.a < l.b ? l : { a: l.b, b: l.a, text: l.text })), now });
    await tx.run(`UNWIND $pairs AS p MATCH (:Entity {id: p[0]})-[l:LINK]-(:Entity {id: p[1]}) DELETE l`, { pairs: unlinked });
    await tx.run(
      `MATCH (s:SleepState {id: $id})
       SET s.captures = coalesce(s.captures, []) + [c IN $caps WHERE NOT c IN coalesce(s.captures, [])],
           s.cluster_map = $map, s.nights = coalesce(s.nights, 0) + 1, s.last_night = $now`,
      { id: SLEEP_ID, caps: captures, map: JSON.stringify(map), now });
    await tx.run(`MATCH (s:SyncState {id:'cursors'}) WHERE s.sleep_token=$token
      REMOVE s.sleep_token,s.sleep_protected_ids,s.sleep_expires_at`, { token: sleepToken });
    await tx.commit();
  } catch (e) {
    await tx.rollback();
    throw e;
  }
}

/** Conversations whose summary should fade to a shorter level tonight. */
export async function conversationsToFade(session, levels) {
  const r = await session.run(`MATCH (c:Entity {kind: 'conversation'}) RETURN properties(c) AS p`);
  const now = Date.now(), out = [];
  for (const rec of r.records) {
    const c = rec.get('p');
    const ageDays = (now - new Date(c.t_start).getTime()) / 86_400_000;
    const level = levels.filter((l) => ageDays >= l.days).length;
    if (level > (c.summary_level || 0)) out.push({ ...c, target: levels[level - 1], level });
  }
  return out;
}

export async function setConversationSummary(session, id, summary, level) {
  const tx = session.beginTransaction();
  try {
    await lockGraphWriter(tx);
    await tx.run(`MATCH (c:Entity {id: $id}) SET c.summary = $summary, c.summary_level = $level, c.summary_faded_at = $now`,
      { id, summary, level, now: new Date().toISOString() });
    await tx.commit();
  } catch (error) {
    await tx.rollback();
    throw error;
  }
}

import { localTime } from './util.mjs';
// Sleep-private access to timestamped archive evidence. Nothing here is written to the graph.
export function interval(node) {
  const start = Date.parse(node.t_start);
  const ends = [Date.parse(node.t_last), Number(node.t_end_us) / 1000,
    start + Number(node.duration_s) * 1000].filter(Number.isFinite);
  return { start, end: Math.max(start, ...ends) };
}

export async function readTimeline(capture, start, end) {
  const base = process.env.ARCHIVE_URL, token = process.env.SCENE_ARCHIVE_TOKEN;
  if (!base || !token) throw new Error('Archive access is not configured');
  if (!capture || !Number.isFinite(start) || !Number.isFinite(end) || end < start) throw new Error('Invalid evidence interval');
  const byKind = await Promise.all(['minicpm', 'speech'].map(async (kind) => {
    const out = [], cursors = new Set();
    let after;
    for (let page = 0; page < 100; page++) {
      const q = new URLSearchParams({ capture_id: capture, kind, started_at: new Date(start).toISOString(), ended_at: new Date(end).toISOString(), limit: '100' });
      if (after) q.set('after', after);
      const response = await fetch(`${base}/v1/archive/events?${q}`, {
        headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(15_000),
      });
      if (!response.ok) throw new Error(`Archive timeline unavailable (HTTP ${response.status})`);
      const data = await response.json();
      if (!Array.isArray(data.items)) throw new Error('Invalid archive timeline response');
      for (const event of data.items) {
        const from = Date.parse(event.started_at), to = Date.parse(event.ended_at);
        if (!event.event_id || event.kind !== kind || event.capture_id !== capture || !Number.isFinite(from) || !Number.isFinite(to) || to < from) throw new Error('Invalid archive evidence');
        if (from <= end && to >= start) out.push(event);
      }
      if (!data.has_more) return out;
      after = data.next_cursor;
      if (!after || cursors.has(after)) throw new Error('Archive timeline pagination did not advance');
      cursors.add(after);
    }
    throw new Error('Archive timeline exceeds the inspection limit; inspect a shorter interval');
  }));
  return [...new Map(byKind.flat().map((e) => [e.event_id, e])).values()]
    .sort((a, b) => Date.parse(a.started_at) - Date.parse(b.started_at) || a.event_id.localeCompare(b.event_id));
}

export function timelineLine(event) {
  const local = (iso) => localTime(iso, true);
  const text = event.kind === 'minicpm' ? event.body?.generated_text : event.body?.text;
  return `- archive_window_id=${event.event_id} | ${local(event.started_at)}–${local(event.ended_at)} | ${event.kind}: ${String(text || '').replace(/\n/g, ' ')}`;
}

export async function readMedia(capture, start, end) {
  // Speech windows may cross the selected event boundary. Resolve clips by time instead of copying
  // all of their references, which could attach footage from outside the semantic event.
  const base = process.env.ARCHIVE_URL, token = process.env.SCENE_ARCHIVE_TOKEN;
  if (!base || !token) throw new Error('Archive access is not configured');
  if (!capture || !Number.isFinite(start) || !Number.isFinite(end) || end < start) throw new Error('Invalid evidence interval');
  const out = new Set(), cursors = new Set();
  let after;
  for (let page = 0; page < 100; page++) {
    const q = new URLSearchParams({ capture_id: capture, started_at: new Date(start).toISOString(), ended_at: new Date(end).toISOString(), limit: '100' });
    if (after) q.set('after', after);
    const r = await fetch(`${base}/v1/archive/media?${q}`, {
      headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(15_000),
    });
    if (!r.ok) throw new Error(`Archive media unavailable (HTTP ${r.status})`);
    const data = await r.json();
    if (!Array.isArray(data.items)) throw new Error('Invalid archive media response');
    for (const item of data.items) {
      const from = Date.parse(item.captured_at), to = from + Number(item.duration_seconds) * 1000;
      if (!item.media_id || item.capture_id !== capture || !Number.isFinite(from) || !Number.isFinite(to) || to <= from) throw new Error('Invalid archived media interval');
      if (from < end && to > start) out.add(item.media_id);
    }
    if (!data.has_more) return [...out];
    after = data.next_cursor;
    if (!after || cursors.has(after)) throw new Error('Archive media pagination did not advance');
    cursors.add(after);
  }
  throw new Error('Archive media exceeds the inspection limit; inspect a shorter interval');
}

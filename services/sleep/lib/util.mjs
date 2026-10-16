// Calendar operations use an IANA zone, including daylight-saving transitions.
export const TIME_ZONE = process.env.ELEAGENT_TIMEZONE || 'America/Los_Angeles';
const formatter = new Intl.DateTimeFormat('en-CA', { timeZone: TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
export const J = (x) => (typeof x === 'string' && (x[0] === '[' || x[0] === '{') ? JSON.parse(x) : x);
export function localParts(date = new Date()) {
  return Object.fromEntries(formatter.formatToParts(new Date(date)).filter((p) => p.type !== 'literal').map((p) => [p.type, p.value]));
}
export function localDate(date = new Date()) {
  const p = localParts(date); return `${p.year}-${p.month}-${p.day}`;
}
export function localTime(iso, seconds = false) {
  if (!iso) return '?';
  const p = localParts(iso); return `${p.hour}:${p.minute}${seconds ? ':' + p.second : ''}`;
}
export function shiftDay(day, amount) {
  return new Date(Date.parse(day + 'T12:00:00Z') + amount * 86_400_000).toISOString().slice(0, 10);
}
export const previousDay = (day) => shiftDay(day, -1);
export function zonedDateTime(day, hour = 0, minute = 0, second = 0) {
  const [year, month, date] = day.split('-').map(Number);
  if (![hour, minute, second].every(Number.isInteger) || hour < 0 || hour > 23 || minute < 0 || minute > 59 || second < 0 || second > 59) throw new Error('Invalid local clock time');
  const target = Date.UTC(year, month - 1, date, hour, minute, second);
  let guess = target;
  for (let i = 0; i < 4; i++) {
    const p = localParts(new Date(guess));
    const represented = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
    if (represented === target) return new Date(guess);
    guess += target - represented;
  }
  throw new Error(`Local time does not exist in ${TIME_ZONE}`);
}

// Scheduling may advance across a missing wall-clock time. Source timestamps
// continue to use zonedDateTime directly so missing evidence is never invented.
export function scheduledStart(day, startMinute, endMinute = 300) {
  if (![startMinute, endMinute].every(Number.isInteger) || startMinute < 0 || startMinute >= endMinute || endMinute > 1440) throw new Error('Invalid scheduling window');
  for (let minute = startMinute; minute < endMinute; minute++) {
    try { return zonedDateTime(day, Math.floor(minute / 60), minute % 60); }
    catch (error) { if (!error.message.includes('Local time does not exist')) throw error; }
  }
  return null;
}

export function normalize(v) {
  const n = Math.hypot(...v) || 1;
  return v.map((x) => x / n);
}

export function cosine(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

export function mean(vectors) {
  if (!vectors.length) return null;
  const out = new Array(vectors[0].length).fill(0);
  for (const v of vectors) for (let i = 0; i < v.length; i++) out[i] += v[i];
  return normalize(out.map((x) => x / vectors.length));
}

/** Average-linkage agglomerative clustering on normalized vectors with a cosine-distance cut. */
export function agglomerate(vectors, threshold) {
  const n = vectors.length;
  if (n <= 1) return vectors.map(() => 0);
  const D = vectors.map((a) => vectors.map((b) => 1 - cosine(a, b)));
  const size = new Array(n).fill(1);
  const alive = new Set(vectors.map((_, i) => i));
  const owner = vectors.map((_, i) => i);
  for (;;) {
    let best = Infinity, bi = -1, bj = -1;
    for (const i of alive) for (const j of alive) if (i < j && D[i][j] < best) { best = D[i][j]; bi = i; bj = j; }
    if (bi < 0 || best >= threshold) break;
    for (const k of alive) {
      if (k === bi || k === bj) continue;
      const d = (size[bi] * D[bi][k] + size[bj] * D[bj][k]) / (size[bi] + size[bj]);
      D[bi][k] = D[k][bi] = d;
    }
    size[bi] += size[bj];
    alive.delete(bj);
    for (let i = 0; i < n; i++) if (owner[i] === bj) owner[i] = bi;
  }
  const relabel = new Map();
  return owner.map((o) => (relabel.has(o) ? relabel.get(o) : (relabel.set(o, relabel.size), relabel.size - 1)));
}

export async function pool(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  }));
  return out;
}

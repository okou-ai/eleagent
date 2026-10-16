import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { ApiError } from './graph.mjs';
const MAX_CURSOR = 12 * 1024;
const bad = (message) => new ApiError(400, 'invalid_request', message);
const object = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);

export function integer(value, fallback, min, max, name) {
  if (value === undefined) return fallback;
  if ((typeof value !== 'string' && typeof value !== 'number') ||
      (typeof value === 'string' && !/^\d+$/.test(value))) throw bad(`${name} must be an integer from ${min} to ${max}`);
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < min || n > max) throw bad(`${name} must be an integer from ${min} to ${max}`);
  return n;
}

export function string(value, max, name) {
  if (typeof value !== 'string' || value.length === 0 || value.length > max || /[\u0000-\u001f]/.test(value)) {
    throw bad(`${name} must be a nonempty string of at most ${max} characters`);
  }
  return value;
}

export function queryParams(url, allowed) {
  const out = Object.create(null);
  for (const [k, v] of url.searchParams) {
    if (!allowed.includes(k) || Object.hasOwn(out, k)) throw bad('Unknown or repeated query parameter');
    out[k] = v;
  }
  return out;
}

export function parseFilter(raw) {
  if (raw === undefined) return {};
  if (raw.length > 16384) throw bad('filter is too large');
  let filter;
  try { filter = JSON.parse(raw); } catch { throw bad('filter must be a JSON object'); }
  if (!object(filter) || Object.keys(filter).length > 20) throw bad('filter must be an object with at most 20 properties');
  const scalar = (v) => v === null || typeof v === 'boolean' ||
    (typeof v === 'string' && v.length <= 16384) ||
    (typeof v === 'number' && Number.isFinite(v) && (!Number.isInteger(v) || Number.isSafeInteger(v)));
  for (const [k, v] of Object.entries(filter)) {
    string(k, 256, 'filter property');
    if (!(scalar(v) || (Array.isArray(v) && v.length <= 256 && v.every(scalar)))) {
      throw bad('filter values must be JSON scalars or arrays of scalars; integers must be safe JSON integers');
    }
  }
  return filter;
}

export function cursors(token) {
  const key = createHmac('sha256', token).update('scene-graph-api/cursor/v1').digest();
  const sign = (value) => createHmac('sha256', key).update(value).digest('base64url');
  const scopeId = (scope) => createHash('sha256').update(JSON.stringify(scope)).digest('base64url');
  return {
    encode(after, scope) {
      if (after === null || after === undefined) return null;
      const data = Buffer.from(JSON.stringify({ v: 1, scope: scopeId(scope), after })).toString('base64url');
      const result = `${data}.${sign(data)}`;
      if (result.length > MAX_CURSOR) throw bad('The selected sort value is too large for pagination; choose another sort property');
      return result;
    },
    decode(cursor, scope) {
      if (cursor === undefined) return null;
      if (typeof cursor !== 'string' || cursor.length > MAX_CURSOR || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(cursor)) throw bad('Invalid cursor');
      const [data, signature] = cursor.split('.');
      const expected = Buffer.from(sign(data));
      const actual = Buffer.from(signature);
      if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw bad('Invalid cursor');
      let decoded;
      try { decoded = JSON.parse(Buffer.from(data, 'base64url').toString()); } catch { throw bad('Invalid cursor'); }
      if (!object(decoded) || decoded.v !== 1 || decoded.scope !== scopeId(scope) || !Object.hasOwn(decoded, 'after')) throw bad('Cursor does not match this query');
      return decoded.after;
    },
  };
}


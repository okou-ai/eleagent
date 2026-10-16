import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { ApiError } from './graph.mjs';

const MAX_AUTH_BODY = 64 * 1024;
export async function authRequest(req, publicUrl, { body = false } = {}) {
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (value === undefined || ['host', 'connection', 'transfer-encoding', 'forwarded', 'x-forwarded-host', 'x-forwarded-proto'].includes(key)) continue;
    if (Array.isArray(value)) for (const item of value) headers.append(key, item);
    else headers.set(key, value);
  }
  let bytes;
  if (body && !['GET', 'HEAD'].includes(req.method)) {
    if (Number(req.headers['content-length']) > MAX_AUTH_BODY) {
      req.resume(); throw new ApiError(413, 'body_too_large', 'Authentication request exceeds 64 KiB');
    }
    let length = 0; const chunks = [];
    for await (const chunk of req.iterator({ destroyOnReturn: false })) {
      length += chunk.length;
      if (length > MAX_AUTH_BODY) { req.resume(); throw new ApiError(413, 'body_too_large', 'Authentication request exceeds 64 KiB'); }
      chunks.push(chunk);
    }
    bytes = Buffer.concat(chunks);
  } else headers.delete('content-length');
  // Never derive the issuer/redirect origin from Host or reverse-proxy headers.
  const target = new URL(publicUrl);
  const path = new URL(req.url, 'http://request.invalid');
  target.pathname = path.pathname; target.search = path.search;
  return new Request(target, { method: req.method, headers, ...(bytes?.length ? { body: bytes } : {}) });
}

export async function sendAuthResponse(res, response) {
  for (const [key, value] of response.headers) if (key !== 'set-cookie') res.setHeader(key, value);
  const cookies = response.headers.getSetCookie();
  if (cookies.length) res.setHeader('Set-Cookie', cookies);
  res.setHeader('Cache-Control', 'no-store');
  res.writeHead(response.status);
  if (!response.body) return res.end();
  await pipeline(Readable.fromWeb(response.body), res);
}

export function requireSameOrigin(req, publicUrl) {
  if (req.headers.origin !== new URL(publicUrl).origin) {
    throw new ApiError(403, 'forbidden_origin', 'Use the same-origin account form');
  }
}

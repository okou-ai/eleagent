import test from 'node:test';
import assert from 'node:assert/strict';
import { presignUrl } from '@vercel/blob';
import { CAPTURE_CSP } from '../lib/capture-page.ts';

// Does a CSP source expression allow this URL? Enough of CSP3 for the sources the capture page uses.
function allows(source: string, url: URL): boolean {
  if (source === "'self'") return false;
  const match = /^(https:)\/\/([^/]+)(\/.*)?$/.exec(source);
  if (!match || url.protocol !== match[1]) return false;
  const [, , host, path] = match;
  const hostOk = host.startsWith('*.') ? url.host.endsWith(host.slice(1)) : url.host === host;
  const pathOk = !path || (path.endsWith('/') ? url.pathname.startsWith(path) : url.pathname === path);
  return hostOk && pathOk;
}

test('the capture page may PUT a clip to the URL the Blob SDK signs', async () => {
  // presignUrl only signs locally; a structurally valid delegation token is enough.
  const scope = { pathname: '*', operations: ['put'], storeId: 'store_test', validUntil: Date.now() + 3_600_000 };
  const delegationToken = Buffer.from(JSON.stringify(scope)).toString('base64url') + '.signature';
  const { presignedUrl } = await presignUrl({ delegationToken, clientSigningToken: 'k'.repeat(64) }, {
    operation: 'put', pathname: 'captures/web-x-back/0000001.mp4', access: 'private', validUntil: Date.now() + 60_000,
    allowedContentTypes: ['video/mp4'], maximumSizeInBytes: 16_000_000,
  });
  const connect = CAPTURE_CSP.split('; ').find((d) => d.startsWith('connect-src '))!.split(' ').slice(1);
  const url = new URL(presignedUrl);
  assert.ok(connect.some((source) => allows(source, url)), `connect-src ${connect.join(' ')} blocks ${url.origin}${url.pathname}`);
});

import http from 'node:http';
import { readFileSync, lstatSync } from 'node:fs';
import neo4j from 'neo4j-driver';
import { GraphStore } from './graph.mjs';
import { createApiServer } from './server.mjs';
import { ArchiveClient } from './archive.mjs';
import { createAuthService } from './auth.mjs';

const token = process.env.GRAPH_API_TOKEN;
const auth = process.env.NEO4J_AUTH || '';
const slash = auth.indexOf('/');
if (slash < 1 || !token) throw new Error('NEO4J_AUTH and GRAPH_API_TOKEN are required');
const authPublicUrl = process.env.AUTH_PUBLIC_URL;
if (!authPublicUrl || !process.env.AUTH_SECRET_FILE || !process.env.AUTH_DB_PATH) {
  throw new Error('AUTH_PUBLIC_URL, AUTH_SECRET_FILE and AUTH_DB_PATH are required; refusing to start without OAuth');
}
const secretInfo = lstatSync(process.env.AUTH_SECRET_FILE);
if (!secretInfo.isFile() || secretInfo.isSymbolicLink() || (secretInfo.mode & 0o077) !== 0) {
  throw new Error('AUTH_SECRET_FILE must be a private regular file (mode 0600 or 0400)');
}
const authService = await createAuthService({
  publicUrl: authPublicUrl, databasePath: process.env.AUTH_DB_PATH,
  secret: readFileSync(process.env.AUTH_SECRET_FILE, 'utf8').trim(),
  bootstrapToken: token, ownerEmail: process.env.AUTH_OWNER_EMAIL || undefined,
});
const driver = neo4j.driver(process.env.GRAPH_URL || 'bolt://graph:7687',
  neo4j.auth.basic(auth.slice(0, slash), auth.slice(slash + 1)), {
    maxConnectionPoolSize: 8,
    connectionAcquisitionTimeout: 5000,
    connectionTimeout: 5000,
    maxTransactionRetryTime: 0,
  });
await driver.verifyConnectivity();
const store = new GraphStore(driver, { timeoutMs: 5000 });
const counts = new Map();
const durations = new Map();
let inShutdown = false;
const archive = process.env.ARCHIVE_URL ? new ArchiveClient({
  url: process.env.ARCHIVE_URL, token: process.env.SCENE_ARCHIVE_TOKEN,
}) : undefined;
const server = createApiServer({ store, token, archive, authService, authPublicUrl, onRequest(route, status, seconds) {
  const key = `route="${route}",status="${status}"`;
  counts.set(key, (counts.get(key) || 0) + 1);
  const old = durations.get(route) || { count: 0, sum: 0 };
  durations.set(route, { count: old.count + 1, sum: old.sum + seconds });
} });
const metrics = http.createServer((req, res) => {
  if (req.url === '/healthz') {
    res.writeHead(inShutdown ? 503 : 200, { 'Content-Type': 'text/plain' });
    return res.end(inShutdown ? 'stopping\n' : 'ok\n');
  }
  if (req.url !== '/metrics') { res.writeHead(404); return res.end(); }
  const lines = ['# TYPE scene_graph_api_requests_total counter'];
  for (const [key, value] of counts) lines.push(`scene_graph_api_requests_total{${key}} ${value}`);
  lines.push('# TYPE scene_graph_api_request_duration_seconds summary');
  for (const [route, value] of durations) {
    lines.push(`scene_graph_api_request_duration_seconds_sum{route="${route}"} ${value.sum}`,
      `scene_graph_api_request_duration_seconds_count{route="${route}"} ${value.count}`);
  }
  res.writeHead(200, { 'Content-Type': 'text/plain; version=0.0.4' });
  res.end(`${lines.join('\n')}\n`);
});
const listen = (s, port, host) => new Promise((resolve, reject) => {
  s.once('error', reject);
  s.listen(port, host, resolve);
});
await listen(server, Number(process.env.PORT || 22403), process.env.HOST || '127.0.0.1');
await listen(metrics, Number(process.env.METRICS_PORT || 9208), '127.0.0.1');
console.log('scene-graph-api ready');
async function stop() {
  if (inShutdown) return;
  inShutdown = true;
  const force = setTimeout(() => process.exit(1), 15_000).unref();
  await Promise.all([server, metrics].map((s) => new Promise((resolve) => s.close(resolve))));
  await driver.close();
  await authService.close();
  clearTimeout(force);
}
process.once('SIGTERM', stop);
process.once('SIGINT', stop);

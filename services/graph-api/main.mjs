import http from 'node:http';
import neo4j from 'neo4j-driver';
import { GraphStore } from './graph.mjs';
import { createApiServer } from './server.mjs';

const driver = neo4j.driver(process.env.GRAPH_URL || 'bolt://graph:7687', neo4j.auth.none(), {
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
const server = createApiServer({ store, onRequest(route, status, seconds) {
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
  clearTimeout(force);
}
process.once('SIGTERM', stop);
process.once('SIGINT', stop);

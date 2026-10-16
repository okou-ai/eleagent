import { TIME_ZONE } from './util.mjs';
// Fixed local inference route; no provider fallback or proxy is involved.
import fs from 'node:fs';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

export const LOCAL_MODEL = 'glm-5.3-flash-atlas';
export const LOCAL_PROVIDER = 'local-glm';
const MANAGERS = (process.env.GPU_MANAGER_URLS || '').split(',').map((s) => s.trim()).filter(Boolean);
const API = process.env.LOCAL_GLM_URL || 'http://127.0.0.1:8893';
const log = (message) => process.stderr.write(`${new Date().toISOString()} ${message}\n`);

export function localPiEnv(runDir) {
  // Memory tools need read access to Archive. Provider keys and proxy settings are deliberately absent;
  // Pi has a separate, otherwise empty agent directory.
  const agentDir = process.env.PI_CODING_AGENT_DIR || '/app/pi-agent';
  const home = agentDir + '/home';
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  const configPath = agentDir + '/models.json';
  const models = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  models.providers[LOCAL_PROVIDER].baseUrl = API.replace(/\/$/, '') + '/v1';
  fs.writeFileSync(configPath, JSON.stringify(models), { mode: 0o600 });
  const env = { PATH: process.env.PATH || '/usr/local/bin:/usr/bin:/bin', HOME: home, LANG: 'C.UTF-8', TZ: TIME_ZONE, ELEAGENT_TIMEZONE: TIME_ZONE,
    RUN_DIR: runDir, PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: '1', PI_SKIP_VERSION_CHECK: '1', PI_TELEMETRY: '0', NO_PROXY: '*' };
  if (process.env.ARCHIVE_URL) env.ARCHIVE_URL = process.env.ARCHIVE_URL;
  return env;
}

export function signalGroup(pid, signal) {
  if (!Number.isInteger(pid) || pid <= 1) return;
  try { process.kill(-pid, signal); } catch (error) { if (error.code !== 'ESRCH') throw error; }
}

// node:http ignores environment proxy settings. Do not include response bodies or headers in errors.
function request(origin, route, { body, signal, timeout = 5_000 } = {}) {
  return new Promise((resolve, reject) => {
    let timer, settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error); else resolve(value);
    };
    const payload = body === undefined ? null : JSON.stringify(body);
    const req = http.request(new URL(route, origin), {
      method: payload === null ? 'GET' : 'POST', ...(signal ? { signal } : {}),
      headers: payload === null ? {} : { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
    }, (res) => {
      let text = '';
      res.on('data', (chunk) => { text += chunk; if (text.length > 1_000_000) req.destroy(new Error('oversized status response')); });
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) { finish(new Error(`${route} HTTP ${res.statusCode}`)); return; }
        try { finish(null, text ? JSON.parse(text) : {}); }
        catch { if (route === '/health') finish(null, {}); else finish(new Error(`${route} invalid JSON`)); }
      });
      res.on('error', (error) => finish(error));
      res.on('aborted', () => finish(new Error(`${route} response interrupted`)));
    });
    // An absolute request budget also bounds slow or trickling responses.
    timer = setTimeout(() => req.destroy(new Error(`${route} request timeout`)), timeout);
    req.on('error', (error) => finish(error));
    req.end(payload);
  });
}

export class NightRuntime {
  constructor(deadline) {
    if (!Number.isFinite(deadline) || deadline <= Date.now()) throw new Error('night deadline has passed');
    if (MANAGERS.length !== 2 || new Set(MANAGERS).size !== 2) throw new Error('GPU_MANAGER_URLS must name two distinct host managers');
    this.deadline = deadline;
    this.lease = randomUUID();
    this.controller = new AbortController();
    this.signal = this.controller.signal;
    this.acquired = false;
    this.heartbeatBusy = false;
    this.deadlineTimer = setTimeout(() => this.abort(new Error('night deadline')), deadline - Date.now());
  }
  abort(reason = new Error('night cancelled')) { if (!this.signal.aborted) this.controller.abort(reason); }
  check() { if (this.signal.aborted) throw this.signal.reason; if (Date.now() >= this.deadline) throw new Error('night deadline has passed'); }
  async all(route, body, signal = this.signal) {
    // Await both requests even when one fails: callers must release every acquired host.
    const results = await Promise.allSettled(MANAGERS.map((host) => request(host, route, { body, signal })));
    if (results.some((result) => result.status === 'rejected')) throw new Error(`GPU manager ${route} failed`);
    return results.map((result) => result.value);
  }
  async heartbeat() {
    if (this.heartbeatBusy || this.signal.aborted) return;
    this.heartbeatBusy = true;
    try { await this.all('/heartbeat', { lease: this.lease }); }
    catch { this.abort(new Error('GPU lease heartbeat failed')); }
    finally { this.heartbeatBusy = false; }
  }
  validateStatus(states) {
    for (const status of states) {
      if ((status.lease ?? status.leaseId) !== this.lease) throw new Error('GPU lease ownership changed');
      if (status.error_type || status.error || ['failed', 'error', 'restoring', 'releasing', 'idle'].includes(status.phase)) throw new Error('GPU manager ended the night');
    }
  }
  async prepare() {
    this.check();
    const until = Math.min(this.deadline, Date.now() + 20 * 60_000);
    this.acquired = true; // Even a partial acquire must be released.
    await this.all('/acquire', { lease: this.lease });
    this.heartbeatTimer = setInterval(() => void this.heartbeat(), 15_000);
    for (;;) {
      this.check();
      const states = await this.all('/status');
      this.validateStatus(states);
      if (states.every((status) => status.phase === 'prepared')) break;
      if (Date.now() >= until) throw new Error('GPU preparation exceeded loading budget');
      await delay(2_000, undefined, { signal: this.signal });
    }
    // The worker must be started before the coordinator joins distributed inference.
    await request(MANAGERS[1], '/start', { body: { lease: this.lease }, signal: this.signal });
    for (;;) {
      this.check();
      const worker = await request(MANAGERS[1], '/status', { signal: this.signal });
      this.validateStatus([worker]);
      if (worker.phase === 'running') break;
      if (Date.now() >= until) throw new Error('GLM worker exceeded loading budget');
      await delay(2_000, undefined, { signal: this.signal });
    }
    await request(MANAGERS[0], '/start', { body: { lease: this.lease }, signal: this.signal });
    for (;;) {
      this.check();
      const states = await this.all('/status');
      this.validateStatus(states);
      let ready = false;
      try {
        await request(API, '/health', { signal: this.signal });
        const models = await request(API, '/v1/models', { signal: this.signal });
        ready = Array.isArray(models.data) && models.data.some((model) => model.id === LOCAL_MODEL);
      } catch { /* Loading has no ready API yet. The independent lease guards remain active. */ }
      if (ready && states.every((status) => status.phase === 'running')) { log('local GLM is ready'); return; }
      if (Date.now() >= until) throw new Error('GLM exceeded 20 minute loading budget');
      await delay(2_000, undefined, { signal: this.signal });
    }
  }
  async release() {
    clearTimeout(this.deadlineTimer);
    clearInterval(this.heartbeatTimer);
    if (!this.acquired) return;
    // Release is independent of the cancelled inference signal. A lost client also expires after 120s.
    const releases = await Promise.allSettled(MANAGERS.map((host) => request(host, '/release', { body: { lease: this.lease } })));
    if (releases.some((result) => result.status === 'rejected')) log('one or more release acknowledgements missing; checking independent host recovery');
    const until = Math.min(this.deadline + 30 * 60_000, Date.now() + 20 * 60_000);
    while (Date.now() < until) {
      let states;
      try { states = await this.all('/status', undefined, null); }
      catch { await delay(2_000); continue; }
      if (states.every((status) => status.phase === 'idle' && !(status.lease ?? status.leaseId))) {
        log('both GPU managers restored daytime services');
        return;
      }
      if (states.some((status) => ['failed', 'error'].includes(status.phase))) throw new Error('GPU daytime restoration failed');
      await delay(2_000);
    }
    throw new Error('daytime restoration was not confirmed before recovery deadline');
  }
}

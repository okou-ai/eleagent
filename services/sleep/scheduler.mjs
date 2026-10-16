// One local-GLM GPU lease covers all due days in one local night. Failures are not retried that night.
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { localDate, localParts, previousDay, scheduledStart, shiftDay, zonedDateTime } from './lib/util.mjs';
import { NightRuntime, signalGroup } from './lib/runtime.mjs';

const AT = (process.env.SLEEP_AT || '00:30').split(':').map(Number);
if (AT.length !== 2 || AT.some((n) => !Number.isInteger(n)) || AT[0] < 0 || AT[0] > 4 || AT[1] < 0 || AT[1] > 59) throw new Error('SLEEP_AT must be in the permitted night window');
const START_MINUTE = Math.max(30, AT[0] * 60 + AT[1]);
const TICK_MS = Number(process.env.SLEEP_TICK_MINUTES || 15) * 60_000;
const PORT = Number(process.env.METRICS_PORT || 9206);
const DATA = process.env.SLEEP_DATA || '/data';
const STATE = path.join(DATA, 'scheduler.json');
const HERE = path.dirname(new URL(import.meta.url).pathname);
const m = { runs: {}, durationSum: 0, costTotal: 0, lastSuccess: 0, running: 0, last: {} };
let stopping = false, currentRuntime, currentChild, wake;
const log = (message) => console.log(`${new Date().toISOString()} ${message}`);

function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return {}; throw error; }
}
function saveState(state) {
  const tmp = `${STATE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state), { mode: 0o600 });
  fs.renameSync(tmp, STATE);
}
function windowNow() {
  const now = new Date(), p = localParts(now), today = localDate(now);
  const minute = Number(p.hour) * 60 + Number(p.minute);
  return { today, yesterday: previousDay(today), permitted: minute >= START_MINUTE && minute < 300,
    deadline: zonedDateTime(today, 5, 30).getTime() };
}

function nextWakeMs() {
  const now = Date.now(), today = localDate(new Date(now));
  let start = scheduledStart(today, START_MINUTE)?.getTime();
  if (start === undefined || start <= now) start = scheduledStart(shiftDay(today, 1), START_MINUTE)?.getTime();
  // An entirely skipped local window waits for the next normal tick; admission
  // still checks the wall clock and never acquires at or after 05:00.
  return Math.max(1, Math.min(TICK_MS, start === undefined ? TICK_MS : start - now));
}

function run(args, deadline, signal) {
  return new Promise((resolve) => {
    if (stopping || signal?.aborted || Date.now() >= deadline) { resolve({ ok: false, error: 'night stopped before run' }); return; }
    // Pi inherits this group. It must never detach into a group invisible to this scheduler.
    const child = spawn(process.execPath, [path.join(HERE, 'run.mjs'), ...args], {
      detached: true, env: { ...process.env, SLEEP_NIGHT_DEADLINE_EPOCH_MS: String(deadline), SLEEP_MANAGED_PROCESS_GROUP: '1' },
      stdio: ['ignore', 'pipe', 'inherit'],
    });
    currentChild = child;
    let out = '', cancelled = false, killTimer, settled = false;
    const stop = () => {
      if (cancelled) return;
      cancelled = true;
      signalGroup(child.pid, 'SIGTERM');
      killTimer = setTimeout(() => signalGroup(child.pid, 'SIGKILL'), 10_000);
    };
    child.stopNight = stop;
    signal?.addEventListener('abort', stop, { once: true });
    const timeLeft = Math.max(0, deadline - Date.now());
    const timer = setTimeout(stop, Math.min(timeLeft, args[0] === 'due' ? 60_000 : timeLeft));
    child.stdout.on('data', (data) => { out += data; if (out.length > 1_000_000) { out = ''; stop(); } });
    const finish = (code, spawnError = false) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer); clearTimeout(killTimer);
      signal?.removeEventListener('abort', stop);
      // Even if run exited early, a descendant must not retain an inference socket or GPU request.
      signalGroup(child.pid, 'SIGKILL');
      if (currentChild === child) currentChild = null;
      let summary;
      try { summary = JSON.parse(out.trim().split('\n').pop()); }
      catch { summary = { ok: false, error: 'no summary' }; }
      if (cancelled || spawnError || code !== 0) summary = { ...summary, ok: false, error: cancelled ? 'run interrupted or deadline reached' : (summary.error || 'run process failed') };
      const key = `${args[0]}:${summary.ok ? 'ok' : 'error'}`;
      m.runs[key] = (m.runs[key] || 0) + 1;
      if (summary.ok) m.lastSuccess = Date.now() / 1000;
      m.durationSum += summary.seconds || 0;
      m.costTotal += summary.cost_usd || 0;
      if (summary.ok && args[0] === 'sleep') m.last = summary;
      log(`${args.join(' ')} ${JSON.stringify(summary)}`);
      resolve(summary);
    };
    child.once('error', () => finish(null, true));
    child.once('close', (code) => finish(code));
  });
}

async function night(window, state) {
  // Persist before any work: scheduler/container restarts must not repeatedly reload GLM tonight.
  state = { ...state, attemptedNight: window.today, attemptedAt: new Date().toISOString() };
  saveState(state);
  m.running = 1;
  let runtime;
  try {
    const plan = await run(['due'], window.deadline);
    if (!plan.ok || !Array.isArray(plan.days)) throw new Error('could not determine due sleep dates');
    if (stopping || !windowNow().permitted) throw new Error('night acquisition window closed');
    runtime = new NightRuntime(window.deadline);
    currentRuntime = runtime;
    await runtime.prepare();
    for (const day of plan.days) {
      runtime.check();
      if (stopping) throw new Error('scheduler stopping');
      const result = await run(['sleep', day], window.deadline, runtime.signal);
      if (!result.ok) throw new Error(`sleep ${day} failed`);
    }
    runtime.check();
    saveState({ ...state, slept: window.yesterday, completedAt: new Date().toISOString(), lastError: null });
  } catch (error) {
    log(`night failed: ${error.message}`);
    saveState({ ...loadState(), lastError: String(error.message), failedAt: new Date().toISOString() });
  } finally {
    if (runtime) {
      try {
        await runtime.release();
        saveState({ ...loadState(), restoreError: null, restoredAt: new Date().toISOString() });
      }
      catch (error) {
        log(`night restore not confirmed: ${error.message}; host lease guards remain responsible for restoration`);
        saveState({ ...loadState(), restoreError: String(error.message), restoreCheckedAt: new Date().toISOString() });
      }
    }
    currentRuntime = null;
    m.running = 0;
  }
}

const server = http.createServer((req, res) => {
  if (req.url !== '/metrics') { res.writeHead(404).end(); return; }
  const lines = ['# TYPE scene_jobs_total counter'];
  for (const [key, value] of Object.entries(m.runs)) { const [job, status] = key.split(':'); lines.push(`scene_jobs_total{service="sleep",job="${job}",status="${status}"} ${value}`); }
  lines.push('# TYPE scene_sleep_cost_usd_total counter', `scene_sleep_cost_usd_total ${m.costTotal.toFixed(4)}`,
    '# TYPE scene_sleep_last_success_timestamp_seconds gauge', `scene_sleep_last_success_timestamp_seconds ${m.lastSuccess}`,
    '# TYPE scene_sleep_running gauge', `scene_sleep_running ${m.running}`,
    '# TYPE scene_sleep_last_run gauge',
    ...['captures', 'deleted', 'memories_written', 'conversations'].map((what) => `scene_sleep_last_run{what="${what}"} ${Number(m.last[what] || 0)}`));
  res.writeHead(200, { 'Content-Type': 'text/plain; version=0.0.4' }).end(lines.join('\n') + '\n');
}).listen(PORT, '127.0.0.1');

function stop() {
  if (stopping) return;
  stopping = true;
  currentRuntime?.abort(new Error('scheduler interrupted'));
  currentChild?.stopNight();
  wake?.();
}
process.on('SIGTERM', stop);
process.on('SIGINT', stop);

try {
  while (!stopping) {
    try {
      const window = windowNow(), state = loadState();
      const slept = state.slept ?? state.integrated;
      if (window.permitted && slept !== window.yesterday && state.attemptedNight !== window.today) await night(window, state);
    } catch (error) { log(`scheduler failed closed: ${error.message}`); }
    if (!stopping) await new Promise((resolve) => {
      const timer = setTimeout(resolve, nextWakeMs());
      wake = () => { clearTimeout(timer); resolve(); };
    });
    wake = null;
  }
} finally {
  await new Promise((resolve) => server.close(resolve));
}

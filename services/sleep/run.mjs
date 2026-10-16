// Sleep for one local (configured local) day (prints one JSON summary line on stdout, read by scheduler.mjs):
//   node run.mjs sleep [YYYY-MM-DD]   consolidate the day's new fragments into memories, tidy the day's memories
//                                     and rewrite its diary (default: yesterday)
//   node run.mjs due                  print the days that need a sleep: yesterday plus older days with new fragments
// The same day can be revisited after late clips arrive. One expiring snapshot claim protects
// the current run while the minute coordinator continues processing other entities.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { connect, sleepState, pendingCaptures, loadWorkingSet, loadMemoryLayer, applyNight, releaseSleep } from './lib/graph.mjs';
import { buildCandidates, crop } from './lib/candidates.mjs';
import { J, localDate, previousDay, TIME_ZONE } from './lib/util.mjs';
import { LOCAL_MODEL, LOCAL_PROVIDER, localPiEnv, signalGroup } from './lib/runtime.mjs';

const DATA = process.env.SLEEP_DATA || '/data';
const DRY = process.env.SLEEP_DRY_RUN === '1';
// A capture that received clips this recently is still being recorded; it waits for a later sleep.
const IDLE_MS = Number(process.env.SLEEP_IDLE_MINUTES || 10) * 60_000;
const MODE = process.argv[2] || 'sleep';
const DAY = process.argv[3] || previousDay(localDate());
const AGENT_MODEL = LOCAL_MODEL;
const AGENT_TIMEOUT_MS = Number(process.env.SLEEP_AGENT_TIMEOUT_MIN || 60) * 60_000;
// Long days are slept in batches of about this much capture time, then one final integration run.
const BATCH_MINUTES = Number(process.env.SLEEP_BATCH_MINUTES || 60);
// The whole night must be done by this configured local time (the morning brief reads the diary); the final run keeps a reserve.
const NIGHT_DEADLINE = Number(process.env.SLEEP_NIGHT_DEADLINE_EPOCH_MS);
const MANAGED_GROUP = process.env.SLEEP_MANAGED_PROCESS_GROUP === '1';
const FINAL_RESERVE_MS = Number(process.env.SLEEP_FINAL_RESERVE_MIN || 45) * 60_000;
// No backups: a successful run's directory is deleted; failed runs stay a day for diagnosis.
const KEEP_FAILED_RUNS_DAYS = Number(process.env.SLEEP_KEEP_FAILED_RUNS_DAYS || 1);
// Conversation summaries get shorter with age; transcripts are kept.
const HERE = path.dirname(new URL(import.meta.url).pathname);
const ownerName = process.env.ELEAGENT_OWNER_NAME || 'Me';
const OWNER = { id: 'person:owner', kind: 'person', layer: 'memory', name: ownerName, summary: ownerName,
  description: 'The person who owns this personal memory system. Camera orientation alone does not establish identity.' };
OWNER.text = OWNER.description;

const log = (msg) => process.stderr.write(`${new Date().toISOString()} ${msg}\n`);

const VIEWS = 'recall_day,view_episode,view_candidate,view_memory,search_memory,consolidate,remember_conversation,remember_event,forget,link,revise';
const TOOLS = `${VIEWS},write_diary,finish`;
const BATCH_TOOLS = `${VIEWS},note_period,finish_batch`;

let interrupted = false, terminationTimer, activePi;
function abortRun(reason) {
  if (interrupted) return;
  interrupted = true;
  log(reason);
  if (MANAGED_GROUP) signalGroup(process.pid, 'SIGTERM');
  else activePi?.kill('SIGTERM');
  terminationTimer = setTimeout(() => {
    if (MANAGED_GROUP) signalGroup(process.pid, 'SIGKILL');
    else activePi?.kill('SIGKILL');
  }, 10_000);
  terminationTimer.unref();
}
process.on('SIGTERM', () => abortRun('run interrupted'));
process.on('SIGINT', () => abortRun('run interrupted'));
function assertNight() {
  if (!MANAGED_GROUP || !Number.isFinite(NIGHT_DEADLINE)) throw new Error('sleep requires a scheduler-managed GPU lease and absolute deadline');
  if (interrupted || Date.now() >= NIGHT_DEADLINE) throw new Error('sleep stopped or night deadline reached');
}

function runAgent(runDir, { tag = 'night', tools = TOOLS, message = `Sleep date (${TIME_ZONE}): ${DAY}. Run mode: whole-day. recall_day lists the available recorded material and prior memories for this run.`, timeoutMs = AGENT_TIMEOUT_MS } = {}) {
  assertNight();
  return new Promise((resolve, reject) => {
    const args = ['--print', '--mode', 'json', '--no-session', '--no-skills', '--no-context-files', '--no-mcp', '--no-extensions', '-e', path.join(HERE, 'extensions/memory.ts'),
      '--tools', tools,
      '--provider', LOCAL_PROVIDER, '--model', AGENT_MODEL, '--thinking', 'high', '--system-prompt', fs.readFileSync(path.join(HERE, 'prompts/sleep.md'), 'utf8'),
      message];
    const out = fs.openSync(path.join(runDir, `events-${tag}.jsonl`), 'w'), err = fs.openSync(path.join(runDir, `pi-${tag}.stderr`), 'w');
    // Inherit run's process group so scheduler deadline/exit cleanup always includes Pi and its descendants.
    const child = spawn(path.join(HERE, 'node_modules/.bin/pi'), args, { env: localPiEnv(runDir), detached: false, stdio: ['ignore', out, err] });
    activePi = child;
    const timer = setTimeout(() => abortRun(`agent ${tag} timeout`), Math.max(1, Math.min(timeoutMs, NIGHT_DEADLINE - Date.now())));
    let settled = false;
    const finish = (code, error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      activePi = null;
      fs.closeSync(out); fs.closeSync(err);
      if (error || interrupted || code !== 0 || Date.now() >= NIGHT_DEADLINE) reject(new Error(`agent ${tag} did not complete successfully`));
      else resolve(code);
    };
    child.once('error', (error) => finish(null, error));
    child.once('close', (code) => finish(code));
  });
}

function agentCost(runDir, tag = 'night') {
  let cost = 0;
  const file = path.join(runDir, `events-${tag}.jsonl`);
  if (!fs.existsSync(file)) return 0;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line) continue;
    try {
      const e = JSON.parse(line);
      if (e.type === 'message_end' && e.message?.role === 'assistant') cost += e.message.usage?.cost?.total || 0;
    } catch { /* partial line */ }
  }
  return cost;
}

function pruneRuns() {
  const dir = path.join(DATA, 'runs');
  if (!fs.existsSync(dir)) return;
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name);
    if (Date.now() - fs.statSync(p).mtimeMs > KEEP_FAILED_RUNS_DAYS * 86_400_000) fs.rmSync(p, { recursive: true, force: true });
  }
}



function newRunDir(tag) {
  const runDir = path.join(DATA, 'runs', `${new Date().toISOString().replace(/[:.]/g, '-')}-${tag}`);
  fs.mkdirSync(path.join(runDir, 'img'), { recursive: true });
  return runDir;
}

/** The scheduler supplies this night's absolute cutoff; it never rolls forward to tomorrow. */
function msUntilDeadline() {
  return Math.max(0, NIGHT_DEADLINE - Date.now());
}

/** Consecutive episodes grouped into stretches of about BATCH_MINUTES of capture. */
function planBatches(ws) {
  const eps = Object.values(ws.nodes).filter((n) => n.kind === 'episode').sort((a, b) => String(a.t_start).localeCompare(String(b.t_start)));
  const total = eps.reduce((s, e) => s + Number(e.duration_s || 0), 0);
  if (total <= BATCH_MINUTES * 60 * 1.5) return [];
  const batches = [];
  let cur = null;
  for (const e of eps) {
    if (!cur || cur.seconds >= BATCH_MINUTES * 60) batches.push((cur = { episodes: [], seconds: 0, t_from: e.t_start }));
    cur.episodes.push(e.id);
    cur.seconds += Number(e.duration_s || 0);
  }
  batches.forEach((b, i) => { b.index = i; b.total = batches.length; b.t_to = batches[i + 1]?.t_from || '9999'; });
  batches[0].t_from = '0000';
  return batches;
}

async function runBatches(runDir, ws, summary, startedAt) {
  const batches = planBatches(ws);
  summary.batches_planned = batches.length;
  summary.batches_done = 0;
  for (const b of batches) {
    const left = msUntilDeadline(startedAt) - FINAL_RESERVE_MS;
    if (left < 10 * 60_000) { log(`deadline: skipping batches ${b.index + 1}..${b.total}`); break; }
    fs.writeFileSync(path.join(runDir, 'batch.json'), JSON.stringify(b));
    const t0 = Date.now();
    await runAgent(runDir, { tag: `batch-${b.index}`, tools: BATCH_TOOLS, timeoutMs: Math.min(AGENT_TIMEOUT_MS, left),
      message: `Sleep date (${TIME_ZONE}): ${DAY}. Run mode: batch ${b.index + 1}/${b.total}. Shared memory includes earlier batches. Archive bounds: ${b.t_from} to ${b.t_to}, retaining their original timezone when present; 0000/9999 are open bounds. recall_day lists this batch's available fragments and memories.` });
    summary.cost_usd += agentCost(runDir, `batch-${b.index}`);
    const done = fs.existsSync(path.join(runDir, `batch-${b.index}.done`));
    if (done) summary.batches_done++;
    log(`batch ${b.index + 1}/${b.total} ${done ? 'done' : 'FAILED (its work is lost; the final run still sees its conversations)'} in ${Math.round((Date.now() - t0) / 1000)} s`);
  }
  if (batches.length) {
    fs.writeFileSync(path.join(runDir, 'batch.json'), JSON.stringify({ final: true, total: batches.length }));
    return { tag: 'final', message: `Sleep date (${TIME_ZONE}): ${DAY}. Run mode: final integration. ${summary.batches_done} of ${batches.length} planned batches completed. Shared memories and period notes contain the retained batch work; recall_day also lists any pending conversations. The whole-day diary replaces the earlier diary, with the source limitations of each recorded period preserved.`,
      timeoutMs: Math.min(2 * AGENT_TIMEOUT_MS, msUntilDeadline()) };
  }
  return {};
}

async function waitForGraphMaintenance(operation) {
  const until = Math.min(Date.now() + 120_000, NIGHT_DEADLINE);
  for (;;) {
    assertNight();
    try {
      return await operation();
    } catch (error) {
      if (error.code !== 'MAINTENANCE_PENDING' || Date.now() >= until) throw error;
      await new Promise((resolve) => setTimeout(resolve, Math.min(1000, until - Date.now())));
    }
  }
}

async function agentAndApply(session, runDir, summary, opts = {}) {
  const code = await runAgent(runDir, opts);
  summary.cost_usd += agentCost(runDir, opts.tag);
  const resultFile = path.join(runDir, 'result.json');
  if (!fs.existsSync(resultFile)) throw new Error(`agent did not finish (exit ${code}); graph unchanged`);
  const result = JSON.parse(fs.readFileSync(resultFile, 'utf8'));
  Object.assign(summary, result.stats);
  assertNight();
  if (!DRY) {
    const working = JSON.parse(fs.readFileSync(path.join(runDir, 'working.json'), 'utf8'));
    const observedSync = Object.fromEntries(Object.values(working.nodes).map((n) => [n.id, n.synced_at || null]));
    await waitForGraphMaintenance(() => applyNight(session, {
      ...result, observedSync, sleepToken: working.sleep_claim?.token,
    }));
    log(`applied: deleted ${result.deleted.length}, wrote ${result.upserts.length} memories, ${result.links.length} links`);
  }
}

async function sleep(session, summary) {
  assertNight();
  const startedAt = Date.now();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(DAY)) throw new Error('day must be YYYY-MM-DD');
  summary.day = DAY;
  const state = await sleepState(session);
  const captures = (await pendingCaptures(session, state, IDLE_MS))[DAY] || [];
  summary.captures = captures.length;
  const runDir = newRunDir(`sleep-${DAY}`);
  summary.run_dir = runDir;
  // The day's new fragments (if any) plus the whole memory layer; with no new fragments this only tidies memories.
  const claimOptions = { expiresAt: new Date(NIGHT_DEADLINE + 120_000).toISOString() };
  const ws = await waitForGraphMaintenance(() => captures.length
    ? loadWorkingSet(session, captures, claimOptions) : loadMemoryLayer(session, claimOptions));
  summary.sleep_token = ws.sleep_claim.token;
  ws.captures = captures;
  ws.day = DAY;
  // Establish the configured owner record without assigning a face or voice identity.
  ws.nodes[OWNER.id] ??= { ...OWNER, created_by: 'owner', occurrences: 0 };
  // Vectors at 4 decimals: a 12-hour day stays far below Node's maximum string length (~512 MB) in working/state files.
  const round = (_k, v) => (typeof v === 'number' && !Number.isInteger(v) ? Math.round(v * 1e4) / 1e4 : v);
  for (const n of Object.values(ws.nodes)) for (const k of ['object_vec', 'face_vec', 'voice_vec']) if (typeof n[k] === 'string') n[k] = JSON.stringify(JSON.parse(n[k]), round);
  fs.writeFileSync(path.join(runDir, 'working.json'), JSON.stringify(ws, (k, v) => (/_vec$/.test(k) && Array.isArray(v) ? v.map((x) => Math.round(x * 1e4) / 1e4) : v))); // the agent's input
  for (const m of Object.values(ws.nodes).filter((n) => n.layer === 'memory')) {
    for (const c of (J(m.covers) || []).slice(0, 4)) await crop(c, path.join(runDir, 'img'));
  }
  log(`sleep ${DAY}: ${captures.length} new captures, ${Object.keys(ws.nodes).length} nodes in ${runDir}`);
  if (captures.length) {
    const { candidates, fastCost } = await buildCandidates(ws, runDir, { log });
    fs.writeFileSync(path.join(runDir, 'candidates.json'), JSON.stringify(candidates.map(({ vec, ...c }) => c)));
    summary.cost_usd += fastCost;
  }
  const finalRun = captures.length ? await runBatches(runDir, ws, summary, startedAt) : {};
  await agentAndApply(session, runDir, summary, finalRun);

}

/** Yesterday plus every older day that still has new fragments (e.g. clips uploaded late), oldest first. */
async function due(session, summary) {
  const today = localDate(new Date()), yesterday = previousDay(localDate());
  const pending = await pendingCaptures(session, await sleepState(session), IDLE_MS);
  summary.days = [...new Set([...Object.keys(pending).filter((d) => d < today), yesterday])].sort();
}

async function main() {
  const started = Date.now();
  const summary = { ok: false, mode: MODE, dry_run: DRY, captures: 0, cost_usd: 0 };
  const cutoff = MODE === 'sleep' && Number.isFinite(NIGHT_DEADLINE) ? setTimeout(() => abortRun('absolute night deadline reached'), Math.max(1, NIGHT_DEADLINE - Date.now())) : null;
  const driver = connect();
  const session = driver.session();
  try {
    if (MODE === 'due') await due(session, summary);
    else if (MODE === 'sleep') await sleep(session, summary);
    else throw new Error(`unknown mode ${MODE}; use: sleep [YYYY-MM-DD] | due`);
    if (interrupted) throw new Error('run interrupted');
    summary.ok = true;
  } catch (e) {
    summary.error = String(e.message || e);
    log(`${MODE} failed: ${summary.error}`);
  } finally {
    if (summary.sleep_token) {
      try { await releaseSleep(session, summary.sleep_token); }
      catch (error) { log(`sleep claim release failed; expires automatically: ${error.message}`); }
      delete summary.sleep_token;
    }
    await session.close();
    await driver.close();
    if (summary.ok && summary.run_dir && !DRY) fs.rmSync(summary.run_dir, { recursive: true, force: true });
    pruneRuns();
  }
  clearTimeout(cutoff);
  summary.seconds = Math.round((Date.now() - started) / 1000);
  summary.cost_usd = +summary.cost_usd.toFixed(4);
  process.stdout.write(JSON.stringify(summary) + '\n');
  process.exitCode = summary.ok ? 0 : 1;
}

main();

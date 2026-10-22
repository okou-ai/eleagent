import { createHash, randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Sandbox } from '@vercel/sandbox';
import { appOrigin } from './auth-server';
import { sql } from './db';
import { TEXT_MODEL } from './sleep';
import { SLEEP_TOOLS } from './sleep-tools';
import { ownerTimeZone } from './sleep-server';

// One night of sleep: Pi (the agent the self-hosted Eleagent used) runs in a Vercel Sandbox with the tools in
// sandbox/sleep/extension.ts. Once Pi is installed, the sandbox can reach only this deployment, and its firewall adds
// the run's token to every request there; the tools (/api/sleep/tools) and the model (/api/sleep/model, which holds
// the OpenRouter key and requires zero-data-retention providers) both check it. Only the token's hash is stored.

export const SLEEP_MODEL = process.env.SLEEP_MODEL || TEXT_MODEL;
const PI_PACKAGE = '@earendil-works/pi-coding-agent@1.1.0';
// The longest sandbox session on Vercel's Hobby plan.
const SESSION_MS = 45 * 60_000;

const digest = (token: string) => createHash('sha256').update(token).digest('hex');

export interface ActiveRun { day: string; timeZone: string; startedAt: string; sandbox: string | null }

// The run a sandbox's token belongs to while it is running. `finished` also accepts a run that finished in the last
// ten minutes, so the agent's last model turn after finish (and the sandbox's exit report) still go through.
export async function activeRun(token: string | null, { finished = false } = {}): Promise<ActiveRun | null> {
  if (!token) return null;
  const [row] = await sql()`SELECT day::text AS day, timezone, started_at, sandbox FROM sleep_days WHERE run_token_hash = ${digest(token)}
    AND (status = 'running' OR (${finished} AND status = 'done' AND finished_at > now() - interval '10 minutes'))`;
  return row ? { day: row.day, timeZone: row.timezone, startedAt: new Date(row.started_at).toISOString(), sandbox: row.sandbox } : null;
}

export async function stopSandbox(name: string | null) {
  if (!name) return;
  try { await (await Sandbox.get({ name })).stop(); } catch { /* already gone */ }
}

const models = (origin: string) => ({
  providers: {
    eleagent: {
      baseUrl: `${origin}/api/sleep/model/v1`, api: 'openai-completions', apiKey: 'from-the-sandbox-firewall',
      // An alias: the model route pins the real one (SLEEP_MODEL), whose id has a slash Pi would read as a provider.
      models: [{ id: 'eleagent-sleep', name: 'Eleagent sleep', reasoning: true, input: ['text', 'image'], contextWindow: 1_000_000,
        maxTokens: 16_384, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, compat: { supportsReasoningEffort: false } }],
    },
  },
});

// Starts sleeping `day` unless a run of it is already going (`force` replaces one that may be stuck).
export async function startSleep(day: string, { force = false } = {}): Promise<'started' | 'running'> {
  const timeZone = await ownerTimeZone();
  const token = randomBytes(32).toString('base64url');
  const claimed = await sql().query(`INSERT INTO sleep_days (day, timezone, status, attempts, claimed_at, started_at, run_token_hash, talks)
    VALUES ($1, $2, 'running', 1, now(), now(), $3, '{}')
    ON CONFLICT (day) DO UPDATE SET timezone = EXCLUDED.timezone, status = 'running', claimed_at = now(), started_at = now(),
      run_token_hash = EXCLUDED.run_token_hash, talks = '{}', error = NULL, sandbox = NULL, updated_at = now(),
      attempts = sleep_days.attempts + 1
    WHERE sleep_days.status <> 'running' OR sleep_days.claimed_at < now() - interval '60 minutes' OR $4
    RETURNING day`, [day, timeZone, digest(token), force]);
  if (!claimed.length) return 'running';
  let sandbox: Sandbox | undefined;
  try {
    sandbox = await Sandbox.create({ runtime: 'node24', timeout: SESSION_MS, resources: { vcpus: 1 }, persistent: false, tags: { purpose: 'sleep' } });
    await sql()`UPDATE sleep_days SET sandbox = ${sandbox.name} WHERE day = ${day}`;
    const install = await sandbox.runCommand('bash', ['-lc', `mkdir -p /tmp/sleep/agent /tmp/sleep/home && cd /tmp/sleep && npm init -y > /dev/null && npm install --no-audit --no-fund ${PI_PACKAGE}`]);
    if (install.exitCode !== 0) throw new Error(`Installing Pi failed: ${(await install.stderr()).slice(-300)}`);
    const origin = appOrigin();
    const files = join(process.cwd(), 'sandbox/sleep');
    await sandbox.writeFiles([
      { path: '/tmp/sleep/extension.ts', content: await readFile(join(files, 'extension.ts')) },
      { path: '/tmp/sleep/sleep.md', content: await readFile(join(files, 'sleep.md')) },
      { path: '/tmp/sleep/run.sh', content: await readFile(join(files, 'run.sh')) },
      { path: '/tmp/sleep/agent/models.json', content: Buffer.from(JSON.stringify(models(origin))) },
    ]);
    await sandbox.updateNetworkPolicy({ allow: { [new URL(origin).host]: [{ transform: [{ headers: { 'x-eleagent-run': token } }] }] } });
    const language = process.env.MEMORY_LANGUAGE || 'English';
    await sandbox.runCommand({ cmd: 'bash', args: ['/tmp/sleep/run.sh'], detached: true, env: {
      ELEAGENT_URL: origin, SLEEP_TOOLS: SLEEP_TOOLS.join(','), SLEEP_MODEL: 'eleagent-sleep', SLEEP_THINKING: 'medium',
      SLEEP_MESSAGE: `Sleep date (${timeZone}): ${day}. Write memories, conversation summaries and the diary in ${language}. ` +
        'recall_day lists the day\'s material and the existing memories.',
      PI_CODING_AGENT_DIR: '/tmp/sleep/agent', HOME: '/tmp/sleep/home', PI_OFFLINE: '1', PI_SKIP_VERSION_CHECK: '1', PI_TELEMETRY: '0',
      TZ: timeZone, LANG: 'C.UTF-8',
    } });
    return 'started';
  } catch (error) {
    await sql()`UPDATE sleep_days SET status = 'failed', error = ${String((error as Error).message ?? error).slice(0, 500)},
      run_token_hash = NULL, claimed_at = NULL, updated_at = now() WHERE day = ${day}`;
    await sandbox?.stop().catch(() => {});
    throw error;
  }
}

// After a run ends, the next due day (if any) is started by asking the cron route again.
export async function sleepNext() {
  const secret = process.env.CRON_SECRET;
  await fetch(`${appOrigin()}/api/sleep`, { headers: secret ? { Authorization: `Bearer ${secret}` } : {} }).catch(() => {});
}

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, writeFile, stat, rm, symlink, mkdir, copyFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { createAuthService } from './auth.mjs';

test('flattened container-layout CLI permits a private data volume outside /app', async t => {
  const f = await fixture(t), app = join(f.dir, 'image', 'app');
  await mkdir(app, { recursive: true });
  for (const name of ['init-owner.mjs', 'auth.mjs']) await copyFile(fileURLToPath(new URL(`./${name}`, import.meta.url)), join(app, name));
  await symlink(fileURLToPath(new URL('./node_modules', import.meta.url)), join(app, 'node_modules'), 'dir');
  const result = await exec(process.execPath, [join(app, 'init-owner.mjs'), '--email', 'container-owner@example.net'], { env: f.env, cwd: app, timeout: 20000 });
  const credentials = JSON.parse(await readFile(f.env.AUTH_INITIAL_CREDENTIALS_FILE, 'utf8'));
  assert.equal(credentials.email, 'container-owner@example.net');
  assert.equal((await stat(f.env.AUTH_INITIAL_CREDENTIALS_FILE)).mode & 0o777, 0o600);
  assert.ok(!(result.stdout + result.stderr).includes(credentials.password));
});

const exec = promisify(execFile);
const cli = fileURLToPath(new URL('./init-owner.mjs', import.meta.url));
const secret = 'cli-test-persistent-secret-at-least-thirty-two-characters';
async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'graph-owner-cli-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const env = { ...process.env, AUTH_PUBLIC_URL: 'http://127.0.0.1:9080', AUTH_DB_PATH: join(dir, 'auth.sqlite'),
    AUTH_SECRET_FILE: join(dir, 'secret'), AUTH_INITIAL_CREDENTIALS_FILE: join(dir, 'private', 'initial-owner.txt') };
  await writeFile(env.AUTH_SECRET_FILE, secret, { mode: 0o600 });
  const run = (args = ['--email', 'operator-chosen@example.net'], overrides = {}) => exec(process.execPath, [cli, ...args], { env: { ...env, ...overrides }, timeout: 20000 });
  const service = () => createAuthService({ publicUrl: env.AUTH_PUBLIC_URL, databasePath: env.AUTH_DB_PATH, secret });
  return { dir, env, run, service };
}

async function failed(run) {
  try { await run(); assert.fail('CLI must refuse'); }
  catch (error) {
    assert.equal(error.code, 1);
    assert.equal(error.stdout, '');
    assert.match(error.stderr, /Owner initialization refused or failed/);
    return error;
  }
}

test('real offline CLI persists private random credentials, login works, and reruns never reset owner', async t => {
  const f = await fixture(t);
  const result = await f.run();
  const bytes = await readFile(f.env.AUTH_INITIAL_CREDENTIALS_FILE);
  const credentials = JSON.parse(bytes);
  assert.equal(credentials.email, 'operator-chosen@example.net');
  assert.equal(credentials.signinURL, `${f.env.AUTH_PUBLIC_URL}/auth/sign-in`);
  assert.match(credentials.password, /^[A-Za-z0-9_-]{43}$/);
  assert.equal((await stat(f.env.AUTH_INITIAL_CREDENTIALS_FILE)).mode & 0o777, 0o600);
  assert.equal(result.stdout, `Owner initialized. Credentials file: ${f.env.AUTH_INITIAL_CREDENTIALS_FILE}\n`);
  assert.ok(!(result.stdout + result.stderr).includes(credentials.password));
  const service = await f.service();
  let owner;
  try {
    assert.equal(service.getSetupStatus().configured, true);
    const response = await service.handler(new Request(`${f.env.AUTH_PUBLIC_URL}/api/auth/sign-in/email`, {
      method: 'POST', headers: { 'content-type': 'application/json', origin: f.env.AUTH_PUBLIC_URL },
      body: JSON.stringify({ email: credentials.email, password: credentials.password }),
    }));
    assert.equal(response.status, 200);
    owner = (await response.json()).user.id;
  } finally { await service.close(); }
  const failure = await failed(() => f.run(['--email', 'different@example.org']));
  assert.ok(!(failure.stdout + failure.stderr).includes(credentials.password));
  assert.deepEqual(await readFile(f.env.AUTH_INITIAL_CREDENTIALS_FILE), bytes);
  const db = new DatabaseSync(f.env.AUTH_DB_PATH);
  try {
    assert.equal(db.prepare('SELECT count(*) AS n FROM user').get().n, 1);
    assert.equal(db.prepare('SELECT user_id FROM graph_auth_owner').get().user_id, owner);
  } finally { db.close(); }
  // Even removing the file does not reopen initialization for an existing owner.
  await rm(f.env.AUTH_INITIAL_CREDENTIALS_FILE);
  await failed(() => f.run());
  await assert.rejects(readFile(f.env.AUTH_INITIAL_CREDENTIALS_FILE), { code: 'ENOENT' });
  const other = await fixture(t);
  await other.run();
  assert.notEqual(JSON.parse(await readFile(other.env.AUTH_INITIAL_CREDENTIALS_FILE)).password, credentials.password);
});

test('requires explicit valid email, persistent DB and private secret; never invents an owner', async t => {
  const f = await fixture(t);
  for (const args of [[], ['--email'], ['--email', 'bad'], ['--email', 'a@example.net', '--reset']]) {
    await failed(() => f.run(args));
  }
  await failed(() => f.run(undefined, { AUTH_DB_PATH: ':memory:' }));
  await assert.rejects(stat(f.env.AUTH_DB_PATH), { code: 'ENOENT' });
  await writeFile(join(f.dir, 'public-secret'), secret, { mode: 0o644 });
  await failed(() => f.run(undefined, { AUTH_SECRET_FILE: join(f.dir, 'public-secret') }));
  await assert.rejects(stat(f.env.AUTH_DB_PATH), { code: 'ENOENT' });
});

test('existing credential and symlink refuse without overwrite or owner creation', async t => {
  const f = await fixture(t);
  const existing = join(f.dir, 'recovery.txt');
  await writeFile(existing, 'preserve this recovery credential', { mode: 0o600 });
  await failed(() => f.run(undefined, { AUTH_INITIAL_CREDENTIALS_FILE: existing }));
  assert.equal(await readFile(existing, 'utf8'), 'preserve this recovery credential');
  const link = join(f.dir, 'link.txt');
  await symlink(existing, link);
  await failed(() => f.run(undefined, { AUTH_INITIAL_CREDENTIALS_FILE: link }));
  const service = await f.service();
  try { assert.deepEqual(service.getSetupStatus(), { configured: false, setupClaimed: false }); }
  finally { await service.close(); }
  await failed(() => f.run(undefined, { AUTH_INITIAL_CREDENTIALS_FILE: cli }));
  await failed(() => f.run(undefined, { AUTH_INITIAL_CREDENTIALS_FILE: join(f.dir, 'logs', 'credentials.txt') }));
});

test('DB creation failure preserves durable recovery credentials and singleton latch; no automatic retry', async t => {
  const f = await fixture(t);
  const service = await f.service();
  await service.close();
  const db = new DatabaseSync(f.env.AUTH_DB_PATH);
  db.exec(`CREATE TRIGGER fail_owner_account BEFORE INSERT ON account BEGIN SELECT RAISE(ABORT, 'injected account failure'); END;`);
  db.close();
  await failed(() => f.run());
  const bytes = await readFile(f.env.AUTH_INITIAL_CREDENTIALS_FILE);
  assert.match(JSON.parse(bytes).password, /^[A-Za-z0-9_-]{43}$/);
  assert.equal((await stat(f.env.AUTH_INITIAL_CREDENTIALS_FILE)).mode & 0o777, 0o600);
  const recovery = await f.service();
  try { assert.equal(recovery.getSetupStatus().setupClaimed, true); }
  finally { await recovery.close(); }
  await failed(() => f.run());
  assert.deepEqual(await readFile(f.env.AUTH_INITIAL_CREDENTIALS_FILE), bytes);
});

test('credential write failure cannot create an owner or claim the latch', async t => {
  const f = await fixture(t);
  const blocker = join(f.dir, 'not-a-directory');
  await writeFile(blocker, 'blocker');
  await failed(() => f.run(undefined, { AUTH_INITIAL_CREDENTIALS_FILE: join(blocker, 'owner.txt') }));
  const service = await f.service();
  try { assert.deepEqual(service.getSetupStatus(), { configured: false, setupClaimed: false }); }
  finally { await service.close(); }
});

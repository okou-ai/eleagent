#!/usr/bin/env node
// Offline operator command. Stop graph-api before running: the auth DB has one writer.
import { randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { mkdir, open, realpath } from 'node:fs/promises';
import { basename, dirname, isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createAuthService } from './auth.mjs';

const moduleDirectory = dirname(fileURLToPath(import.meta.url));
// The runtime image flattens these modules into /app; ../../ would incorrectly
// become / and reject every private volume. In a checkout protect the whole repo.
const sourceRoot = basename(moduleDirectory) === 'graph-api' && basename(dirname(moduleDirectory)) === 'services'
  ? resolve(moduleDirectory, '../..') : moduleDirectory;
const within = (root, path) => {
  const rel = relative(root, path);
  return rel === '' || (rel !== '..' && !rel.startsWith('../') && !isAbsolute(rel));
};

async function syncDirectories(path) {
  // Also persist newly created parent directories, not only the file entry.
  for (;;) {
    const directory = await open(path, constants.O_RDONLY | constants.O_DIRECTORY);
    try { await directory.sync(); } finally { await directory.close(); }
    const parent = dirname(path);
    if (parent === path) return;
    path = parent;
  }
}

export async function initializeOwner({ args = process.argv.slice(2), env = process.env } = {}) {
  if (args.length !== 2 || args[0] !== '--email' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(args[1])) {
    throw new Error('Usage: node init-owner.mjs --email EMAIL (stop graph-api first)');
  }
  const email = args[1].trim().toLowerCase();
  if (!env.AUTH_PUBLIC_URL || !env.AUTH_DB_PATH || env.AUTH_DB_PATH === ':memory:' || !env.AUTH_SECRET_FILE) {
    throw new Error('AUTH_PUBLIC_URL, AUTH_DB_PATH and AUTH_SECRET_FILE are required');
  }
  const secretFile = await open(env.AUTH_SECRET_FILE, constants.O_RDONLY | constants.O_NOFOLLOW);
  let secret;
  try {
    const info = await secretFile.stat();
    if (!info.isFile() || (info.mode & 0o777) !== 0o600 && (info.mode & 0o777) !== 0o400) {
      throw new Error('AUTH_SECRET_FILE must be a private regular file');
    }
    secret = (await secretFile.readFile('utf8')).trim();
  } finally { await secretFile.close(); }

  const credentialsPath = resolve(env.AUTH_INITIAL_CREDENTIALS_FILE || '/data/auth/initial-owner.txt');
  // Keep the recovery secret outside the checkout and conventional log directories,
  // including paths whose parents resolve through symlinks into the checkout.
  const checkPath = path => {
    if (within(sourceRoot, path) || path.split('/').some(part => /^(logs?|.*\.log)$/i.test(part))) {
      throw new Error('Credentials must be stored outside source and logs');
    }
  };
  checkPath(credentialsPath);
  let service;
  try {
    service = await createAuthService({ publicUrl: env.AUTH_PUBLIC_URL, databasePath: env.AUTH_DB_PATH, secret });
    const status = service.getSetupStatus();
    if (status.configured || status.setupClaimed) throw new Error('Owner exists or initialization is claimed; operator recovery required');
    await mkdir(dirname(credentialsPath), { recursive: true, mode: 0o700 });
    checkPath(resolve(await realpath(dirname(credentialsPath)), credentialsPath.split('/').at(-1)));
    const password = randomBytes(32).toString('base64url');
    // Exclusive create refuses existing files/symlinks, including an earlier
    // recovery credential. Never remove or replace this file, even on failure.
    const file = await open(credentialsPath, 'wx', 0o600);
    try {
      await file.chmod(0o600);
      await file.writeFile(`${JSON.stringify({ email, password, signinURL: `${service.publicUrl}/auth/sign-in` }, null, 2)}\n`, 'utf8');
      await file.sync();
    } finally { await file.close(); }
    await syncDirectories(dirname(credentialsPath));
    // Only after both contents and directory entries are durable may the DB
    // acquire its singleton latch. Partial DB failures keep latch + credential.
    await service.setupOwner({ email, password });
    return credentialsPath;
  } finally { await service?.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const path = await initializeOwner();
    process.stdout.write(`Owner initialized. Credentials file: ${path}\n`);
  } catch {
    // Never print provider exceptions, input values, passwords or file contents.
    process.stderr.write('Owner initialization refused or failed. Stop graph-api and check configuration; preserve any credentials file for operator recovery.\n');
    process.exitCode = 1;
  }
}

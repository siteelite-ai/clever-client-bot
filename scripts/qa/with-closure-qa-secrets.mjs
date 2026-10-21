#!/usr/bin/env node
/**
 * Short-lived credentials for a single, trusted, private closure-preview QA command.
 *
 * Supabase Management API:
 * GET/POST/DELETE https://api.supabase.com/v1/projects/{ref}/secrets
 * POST body: [{ name, value }]; DELETE body: [name]. Never log GET bodies:
 * the API documents a `value` field in its list response.
 *
 * Usage:
 *   node scripts/qa/with-closure-qa-secrets.mjs \
 *     --project-ref=yngoixmvmxdfxokuafjp -- node scripts/qa/run-customer-acceptance.mjs \
 *     --endpoint=https://yngoixmvmxdfxokuafjp.supabase.co/functions/v1/chat-consultant-v3-closure-preview \
 *     --case=customer-new-heat-shrink-12mm --compact
 *
 * The Management PAT comes from SUPABASE_ACCESS_TOKEN in the parent environment
 * or the existing Supabase CLI token file. It is never passed to the child.
 * Use only with a trusted QA command: no wrapper can prevent arbitrary child code
 * from writing its own environment to disk. SIGKILL or machine failure can also
 * bypass finally; in that case list project secrets and delete ONLY the two
 * names with the same V3_CLOSURE_{ACCESS,CATALOG}_<runId> suffix. The preview
 * gate also expires each runId after 20 minutes, but expiry does not delete it.
 */

import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

export const PROJECT_REF = 'yngoixmvmxdfxokuafjp';
export const ACCESS_PREFIX = 'V3_CLOSURE_ACCESS_';
export const CATALOG_PREFIX = 'V3_CLOSURE_CATALOG_';
const RUN_ID_PATTERN = /^\d{10}_[a-f0-9]{32}$/;
const VALUE_SUFFIX_PATTERN = /^[A-Za-z0-9_-]{64}$/;
const API_ORIGIN = 'https://api.supabase.com';
const REQUEST_TIMEOUT_MS = 15_000;
const CHILD_TIMEOUT_MS = 5 * 60_000;
const CHILD_MAX_TIMEOUT_MS = 15 * 60_000;
// Checkpoints after the first cleanup when POST may still finish server-side.
const UNCERTAIN_POST_RECHECK_MS = Object.freeze([2_000, 5_000, 15_000]);

function defaultDelay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

class SafeQaError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SafeQaError';
  }
}

function assertSecret(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{32,256}$/.test(value)) {
    throw new SafeQaError('Temporary secret generator returned an invalid value');
  }
  return value;
}

/** The name and header value carry the same unguessable, time-bounded runId. */
export function createClosureQaCredentials({
  nowMs = Date.now(),
  randomBytesImpl = randomBytes,
} = {}) {
  const epochSeconds = Math.floor(nowMs / 1_000);
  if (!Number.isSafeInteger(epochSeconds) || !/^\d{10}$/.test(String(epochSeconds))) {
    throw new SafeQaError('QA clock is outside the supported range');
  }
  let idBytes;
  let accessBytes;
  let catalogBytes;
  try {
    idBytes = randomBytesImpl(16);
    accessBytes = randomBytesImpl(48);
    catalogBytes = randomBytesImpl(48);
  } catch {
    throw new SafeQaError('Temporary secret generator failed');
  }
  if (!Buffer.isBuffer(idBytes) || idBytes.length !== 16 ||
    !Buffer.isBuffer(accessBytes) || accessBytes.length !== 48 ||
    !Buffer.isBuffer(catalogBytes) || catalogBytes.length !== 48) {
    throw new SafeQaError('Temporary secret generator returned invalid bytes');
  }
  const runId = `${epochSeconds}_${idBytes.toString('hex')}`;
  return {
    runId,
    names: [`${ACCESS_PREFIX}${runId}`, `${CATALOG_PREFIX}${runId}`],
    access: `${runId}_${accessBytes.toString('base64url')}`,
    catalog: `${runId}_${catalogBytes.toString('base64url')}`,
  };
}

function assertCredentials(credentials) {
  const { runId, names, access, catalog } = credentials ?? {};
  if (!RUN_ID_PATTERN.test(runId) || !Array.isArray(names) || names.length !== 2 ||
    names[0] !== `${ACCESS_PREFIX}${runId}` || names[1] !== `${CATALOG_PREFIX}${runId}` ||
    !assertSecret(access).startsWith(`${runId}_`) ||
    !assertSecret(catalog).startsWith(`${runId}_`) ||
    !VALUE_SUFFIX_PATTERN.test(access.slice(runId.length + 1)) ||
    !VALUE_SUFFIX_PATTERN.test(catalog.slice(runId.length + 1)) ||
    access === catalog) {
    throw new SafeQaError('Temporary QA credentials do not match the closure protocol');
  }
  return credentials;
}

function urlFor(projectRef) {
  if (projectRef !== PROJECT_REF) {
    throw new SafeQaError('This QA harness is restricted to the configured Supabase project');
  }
  return `${API_ORIGIN}/v1/projects/${projectRef}/secrets`;
}

function requestSignal(abortSignal) {
  return abortSignal
    ? AbortSignal.any([abortSignal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)])
    : AbortSignal.timeout(REQUEST_TIMEOUT_MS);
}

/** Values, response bodies, and caught transport errors are never returned. */
async function request(fetchImpl, url, token, method, body, abortSignal) {
  let response;
  try {
    response = await fetchImpl(url, {
      method,
      redirect: 'error',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: requestSignal(abortSignal),
    });
  } catch {
    throw new SafeQaError(`Management API ${method} transport failed`);
  }
  const expected = method === 'POST' ? 201 : 200;
  if (response?.status !== expected) {
    const status = Number.isInteger(response?.status) ? ` (HTTP ${response.status})` : '';
    throw new SafeQaError(`Management API ${method} failed${status}`);
  }
  return response;
}

async function listNames(fetchImpl, url, token, abortSignal) {
  const response = await request(fetchImpl, url, token, 'GET', undefined, abortSignal);
  let rows;
  try {
    rows = await response.json();
  } catch {
    throw new SafeQaError('Management API secret list was unreadable');
  }
  if (!Array.isArray(rows) || rows.some((row) => typeof row?.name !== 'string')) {
    throw new SafeQaError('Management API secret list had an unexpected shape');
  }
  // Do not retain or inspect row.value: Supabase may return secret values here.
  return new Set(rows.map((row) => row.name));
}

/** Start a shell-free child with a deliberately small environment. */
export async function runTrustedChild(command, args, qaEnv, {
  abortSignal,
  timeoutMs = CHILD_TIMEOUT_MS,
} = {}) {
  if (typeof command !== 'string' || !command || !Array.isArray(args) ||
    args.some((arg) => typeof arg !== 'string') ||
    !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > CHILD_MAX_TIMEOUT_MS) {
    throw new SafeQaError('Invalid child QA command or timeout');
  }
  const access = assertSecret(qaEnv?.VOLT220_V3_QA_SECRET);
  const catalog = assertSecret(qaEnv?.VOLT220_V3_CATALOG_QA_SECRET);
  const childEnv = {
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    LANG: process.env.LANG ?? 'C.UTF-8',
    TMPDIR: process.env.TMPDIR ?? '/tmp',
    VOLT220_V3_QA_SECRET: access,
    VOLT220_V3_CATALOG_QA_SECRET: catalog,
  };
  // No SUPABASE_ACCESS_TOKEN, CLI token path, inherited env bag, or remote
  // secret names reach the child. Never use shell=true or put values in args.
  return await new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(command, args, {
        env: childEnv,
        shell: false,
        // Do not forward or buffer the child output. A trusted QA script may
        // accidentally print a credential in any encoding or chunk pattern.
        stdio: ['inherit', 'ignore', 'ignore'],
      });
    } catch {
      reject(new SafeQaError('Child QA process could not start'));
      return;
    }
    let hardTimer;
    const stop = () => {
      child.kill('SIGTERM');
      // A stubborn child must not leave temporary project secrets live for
      // the full QA timeout after a user interrupt.
      hardTimer ??= setTimeout(() => child.kill('SIGKILL'), 5_000);
    };
    abortSignal?.addEventListener('abort', stop, { once: true });
    if (abortSignal?.aborted) stop();
    const timer = setTimeout(stop, timeoutMs);
    let spawnFailed = false;
    child.on('error', () => { spawnFailed = true; });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (hardTimer) clearTimeout(hardTimer);
      abortSignal?.removeEventListener('abort', stop);
      if (spawnFailed || code !== 0 || abortSignal?.aborted) {
        reject(new SafeQaError('Child QA command failed or was interrupted'));
      } else {
        resolve();
      }
    });
  });
}

/**
 * All state transitions are explicit. After any attempted POST, finally deletes
 * exactly the two names and independently verifies their absence.
 */
export async function runWithClosureQaSecrets({
  projectRef,
  token,
  command,
  args = [],
  fetchImpl = fetch,
  createCredentials = createClosureQaCredentials,
  runChild = runTrustedChild,
  delay = defaultDelay,
  abortSignal,
  childTimeoutMs = CHILD_TIMEOUT_MS,
} = {}) {
  const url = urlFor(projectRef);
  if (typeof token !== 'string' || !token.trim()) {
    throw new SafeQaError('Supabase Management access token is unavailable');
  }
  if (typeof command !== 'string' || !command || !Array.isArray(args)) {
    throw new SafeQaError('A child QA command is required');
  }
  let credentials;
  try {
    credentials = assertCredentials(createCredentials());
  } catch {
    throw new SafeQaError('Temporary QA credential generation failed');
  }
  const { names, access, catalog } = credentials;
  const before = await listNames(fetchImpl, url, token, abortSignal);
  if (names.some((name) => before.has(name))) {
    throw new SafeQaError('Temporary QA secret name already exists; nothing was changed');
  }

  let attemptedCreate = false;
  let postConfirmed = false;
  let operationError = null;
  let cleanupUncertain = false;
  try {
    attemptedCreate = true;
    await request(fetchImpl, url, token, 'POST', [
      { name: names[0], value: access },
      { name: names[1], value: catalog },
    ], abortSignal);
    postConfirmed = true;
    const afterCreate = await listNames(fetchImpl, url, token, abortSignal);
    if (names.some((name) => !afterCreate.has(name))) {
      throw new SafeQaError('Temporary QA secrets were not both confirmed after creation');
    }
    try {
      await runChild(command, args, {
        VOLT220_V3_QA_SECRET: access,
        VOLT220_V3_CATALOG_QA_SECRET: catalog,
      }, { abortSignal, timeoutMs: childTimeoutMs });
    } catch {
      throw new SafeQaError('Child QA command failed or was interrupted');
    }
  } catch (error) {
    operationError = error instanceof SafeQaError
      ? error : new SafeQaError('Temporary QA orchestration failed');
  } finally {
    if (attemptedCreate) {
      try {
        // Cleanup uses an independent deadline even after SIGINT/SIGTERM.
        await request(fetchImpl, url, token, 'DELETE', names);
      } catch {
        cleanupUncertain = true;
      }
      try {
        const afterDelete = await listNames(fetchImpl, url, token);
        if (names.some((name) => afterDelete.has(name))) {
          cleanupUncertain = true;
        }
      } catch {
        cleanupUncertain = true;
      }

      if (!postConfirmed) {
        // A timed-out POST can keep running on Supabase after our first DELETE.
        // The delayed reads are restricted to this runId pair; only a detected
        // reappearance triggers another exact-pair DELETE. No delay is imposed
        // when POST returned 201.
        const recheckStartedAt = Date.now();
        for (const checkpointMs of UNCERTAIN_POST_RECHECK_MS) {
          try {
            await delay(Math.max(0, checkpointMs - (Date.now() - recheckStartedAt)));
            const observed = await listNames(fetchImpl, url, token);
            if (!names.some((name) => observed.has(name))) continue;
            await request(fetchImpl, url, token, 'DELETE', names);
            const afterLateDelete = await listNames(fetchImpl, url, token);
            if (names.some((name) => afterLateDelete.has(name))) cleanupUncertain = true;
          } catch {
            // Continue bounded checks even if one read or re-delete fails.
            cleanupUncertain = true;
          }
        }
      }
    }
  }
  const safeNames = names.join(' and ');
  if (cleanupUncertain || !postConfirmed) {
    throw new SafeQaError(`Temporary QA secret state uncertain; inspect or remove exactly ${safeNames}`);
  }
  if (operationError) {
    throw new SafeQaError(`QA step failed; temporary secrets were verified removed: ${safeNames}`);
  }
}

function parseCli(argv) {
  const separator = argv.indexOf('--');
  if (separator < 0 || separator === argv.length - 1) {
    throw new SafeQaError('Usage: --project-ref=... [--child-timeout-ms=...] -- command [args...]');
  }
  const flags = argv.slice(0, separator);
  if (flags.some((flag) => !/^--(project-ref|child-timeout-ms)=/.test(flag))) {
    throw new SafeQaError('Unknown QA harness option');
  }
  const projectRef = flags.find((flag) => flag.startsWith('--project-ref='))?.split('=')[1];
  const timeoutRaw = flags.find((flag) => flag.startsWith('--child-timeout-ms='))?.split('=')[1];
  const childTimeoutMs = timeoutRaw === undefined ? CHILD_TIMEOUT_MS : Number(timeoutRaw);
  if (!Number.isSafeInteger(childTimeoutMs) || childTimeoutMs < 1 || childTimeoutMs > CHILD_MAX_TIMEOUT_MS) {
    throw new SafeQaError('Child QA timeout must be between 1 ms and 15 minutes');
  }
  return { projectRef, childTimeoutMs, command: argv[separator + 1], args: argv.slice(separator + 2) };
}

async function readManagementToken() {
  if (process.env.SUPABASE_ACCESS_TOKEN) return process.env.SUPABASE_ACCESS_TOKEN.trim();
  try {
    return (await readFile(join(homedir(), '.supabase', 'access-token'), 'utf8')).trim();
  } catch {
    throw new SafeQaError('Supabase Management access token is unavailable');
  }
}

async function main() {
  let interrupted = false;
  const controller = new AbortController();
  const onSignal = () => {
    interrupted = true;
    controller.abort();
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);
  try {
    const cli = parseCli(process.argv.slice(2));
    const token = await readManagementToken();
    await runWithClosureQaSecrets({ ...cli, token, abortSignal: controller.signal });
    if (interrupted) throw new SafeQaError('QA was interrupted; temporary secret cleanup completed');
    process.stdout.write('QA completed; both temporary Supabase secrets were removed.\n');
  } catch (error) {
    const message = error instanceof SafeQaError ? error.message : 'QA harness failed unexpectedly';
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  } finally {
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  await main();
}

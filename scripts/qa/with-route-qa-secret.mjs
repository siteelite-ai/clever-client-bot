#!/usr/bin/env node
/**
 * One run of the fixed, free 15-probe legacy/search closure smoke.
 *
 * This script creates VOLT220_ROUTE_QA_SECRET only when it is absent, runs
 * run-route-closure-smoke.mjs with a minimal environment, then deletes and
 * verifies that exact name. It never forwards a Management PAT to the child
 * or prints secret values, Management response bodies, or raw child output.
 *
 * Usage: node scripts/qa/with-route-qa-secret.mjs --project-ref=yngoixmvmxdfxokuafjp
 * SIGKILL, power loss, and an arbitrarily late server-side POST can defeat
 * finally. In that case manually inspect/delete only VOLT220_ROUTE_QA_SECRET.
 * The route gate expires the credential after 20 minutes, but expiry does not
 * delete the Management secret. This API has no conditional create; a remote
 * writer racing between our preflight GET and POST is not preventable here.
 * A second writer racing between ownership GET and DELETE likewise cannot
 * be excluded without a conditional DELETE operation.
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { managementHttpsRequest } from './with-closure-qa-secrets.mjs';
import {
  ROUTE_CLOSURE_PROJECT_REF,
  ROUTE_CLOSURE_FUNCTIONS,
  ROUTE_CLOSURE_SECRET_ENV,
  ROUTE_CLOSURE_MAX_AGE_SECONDS,
} from './run-route-closure-smoke.mjs';

export const PROJECT_REF = ROUTE_CLOSURE_PROJECT_REF;
export const SECRET_NAME = ROUTE_CLOSURE_SECRET_ENV;
export const CHILD_TIMEOUT_MS = 120_000;
const MANAGEMENT_ORIGIN = 'https://api.supabase.com';
const MANAGEMENT_TIMEOUT_MS = 15_000;
const POST_UNCERTAIN_RECHECK_MS = Object.freeze([2_000, 5_000, 15_000]);
const CHILD_MAX_OUTPUT_BYTES = 16 * 1_024;
const SECRET_PATTERN = /^(\d{10})_[a-f0-9]{32}_[A-Za-z0-9_-]{64}$/;
const CHILD_PATH = fileURLToPath(new URL('./run-route-closure-smoke.mjs', import.meta.url));
const PROBE_CASES = Object.freeze([
  ['missing_secret', 403],
  ['wrong_secret', 403],
  ['invalid_bearer_jwt', 401],
  ['authorized_get', 405],
  ['authorized_malformed_json', 400],
]);
const FAILURE_CLASSIFICATIONS = new Set(['transport', 'invalid_response', 'unexpected_status']);

class SafeQaError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SafeQaError';
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function managementUrl(projectRef) {
  if (projectRef !== PROJECT_REF) {
    throw new SafeQaError('Route QA is restricted to the configured Supabase project');
  }
  return `${MANAGEMENT_ORIGIN}/v1/projects/${projectRef}/secrets`;
}

function assertCredential(value, nowSeconds = Math.floor(Date.now() / 1_000)) {
  const match = typeof value === 'string' ? SECRET_PATTERN.exec(value) : null;
  if (!match || !Number.isSafeInteger(nowSeconds)) {
    throw new SafeQaError('Temporary route QA credential is invalid');
  }
  const issuedSeconds = Number(match[1]);
  if (issuedSeconds > nowSeconds || nowSeconds - issuedSeconds > ROUTE_CLOSURE_MAX_AGE_SECONDS) {
    throw new SafeQaError('Temporary route QA credential is outside its validity window');
  }
  return value;
}

export function createRouteQaCredential({
  nowMs = Date.now(),
  randomBytesImpl = randomBytes,
} = {}) {
  const issuedSeconds = Math.floor(nowMs / 1_000);
  if (!Number.isSafeInteger(issuedSeconds) || !/^\d{10}$/.test(String(issuedSeconds))) {
    throw new SafeQaError('QA clock is outside the supported range');
  }
  let runBytes;
  let valueBytes;
  try {
    runBytes = randomBytesImpl(16);
    valueBytes = randomBytesImpl(48);
  } catch {
    throw new SafeQaError('Temporary route QA credential generation failed');
  }
  if (!Buffer.isBuffer(runBytes) || runBytes.length !== 16 ||
    !Buffer.isBuffer(valueBytes) || valueBytes.length !== 48) {
    throw new SafeQaError('Temporary route QA credential generation failed');
  }
  return `${issuedSeconds}_${runBytes.toString('hex')}_${valueBytes.toString('base64url')}`;
}

function boundedSignal(abortSignal) {
  const timeout = AbortSignal.timeout(MANAGEMENT_TIMEOUT_MS);
  return abortSignal ? AbortSignal.any([abortSignal, timeout]) : timeout;
}

async function managementRequest(fetchImpl, url, token, method, body, abortSignal) {
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
      signal: boundedSignal(abortSignal),
    });
  } catch {
    throw new SafeQaError(`Management API ${method} transport failed`);
  }
  const expected = method === 'POST' ? 201 : 200;
  if (response?.status !== expected) {
    const status = Number.isInteger(response?.status) ? ` (HTTP ${response.status})` : '';
    const error = new SafeQaError(`Management API ${method} failed${status}`);
    error.httpStatus = Number.isInteger(response?.status) ? response.status : null;
    throw error;
  }
  return response;
}

/** Management GET returns SHA-256 hex digests, not original secret values. */
async function inspectSecret(fetchImpl, url, token, secret, abortSignal) {
  const response = await managementRequest(fetchImpl, url, token, 'GET', undefined, abortSignal);
  let rows;
  try {
    rows = await response.json();
  } catch {
    throw new SafeQaError('Management API secret list was unreadable');
  }
  if (!Array.isArray(rows) || rows.some((row) => typeof row?.name !== 'string')) {
    throw new SafeQaError('Management API secret list had an unexpected shape');
  }
  const matching = rows.filter((row) => row.name === SECRET_NAME);
  if (matching.length > 1) {
    throw new SafeQaError('Management API secret list had duplicate route QA entries');
  }
  if (matching.length === 0) return { present: false, owned: false };
  const digestHex = matching[0].value;
  if (typeof digestHex !== 'string' || !/^[a-f0-9]{64}$/.test(digestHex)) {
    return { present: true, owned: false };
  }
  const expected = createHash('sha256').update(secret, 'utf8').digest();
  const actual = Buffer.from(digestHex, 'hex');
  return { present: true, owned: timingSafeEqual(actual, expected) };
}

function sameKeys(value, expectedKeys, optionalKeys = []) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  return expectedKeys.every((key) => keys.includes(key)) &&
    keys.every((key) => expectedKeys.includes(key) || optionalKeys.includes(key));
}

/** Rebuild a strict allowlist; do not return any child-owned string unchecked. */
export function sanitizeRouteSmokeSummary(candidate) {
  if (!sameKeys(candidate, ['ok', 'status', 'checks'], ['classification']) ||
    !Array.isArray(candidate.checks) || candidate.checks.length < 1 ||
    candidate.checks.length > ROUTE_CLOSURE_FUNCTIONS.length * PROBE_CASES.length ||
    typeof candidate.ok !== 'boolean' ||
    !['passed', 'failed'].includes(candidate.status)) {
    throw new SafeQaError('Route QA child output was invalid');
  }
  const checks = candidate.checks.map((check, index) => {
    const functionName = ROUTE_CLOSURE_FUNCTIONS[Math.floor(index / PROBE_CASES.length)];
    const [name, expected] = PROBE_CASES[index % PROBE_CASES.length];
    if (!sameKeys(check, ['function', 'check', 'expected_status'], ['http_status']) ||
      check.function !== functionName || check.check !== name ||
      check.expected_status !== expected ||
      (check.http_status !== undefined &&
        (!Number.isSafeInteger(check.http_status) || check.http_status < 100 || check.http_status > 599))) {
      throw new SafeQaError('Route QA child output was invalid');
    }
    return {
      function: functionName,
      check: name,
      expected_status: expected,
      ...(check.http_status === undefined ? {} : { http_status: check.http_status }),
    };
  });
  if (candidate.ok) {
    if (candidate.status !== 'passed' || candidate.classification !== undefined ||
      checks.length !== ROUTE_CLOSURE_FUNCTIONS.length * PROBE_CASES.length ||
      checks.some((check) => check.http_status !== check.expected_status)) {
      throw new SafeQaError('Route QA child output was invalid');
    }
    return { ok: true, status: 'passed', checks };
  }
  if (candidate.status !== 'failed' || !FAILURE_CLASSIFICATIONS.has(candidate.classification) ||
    checks.slice(0, -1).some((check) => check.http_status !== check.expected_status) ||
    (candidate.classification === 'unexpected_status' &&
      (checks.at(-1).http_status === undefined ||
        checks.at(-1).http_status === checks.at(-1).expected_status)) ||
    (candidate.classification !== 'unexpected_status' && checks.at(-1).http_status !== undefined)) {
    throw new SafeQaError('Route QA child output was invalid');
  }
  return { ok: false, status: 'failed', classification: candidate.classification, checks };
}

/** No CLI-supplied command or URL can receive the secret. */
export async function runTrustedRouteSmoke(secret, {
  abortSignal,
  timeoutMs = CHILD_TIMEOUT_MS,
  spawnImpl = spawn,
} = {}) {
  assertCredential(secret);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > CHILD_TIMEOUT_MS) {
    throw new SafeQaError('Route QA child timeout is invalid');
  }
  return await new Promise((resolve, reject) => {
    let child;
    try {
      child = spawnImpl(process.execPath, [CHILD_PATH, `--project-ref=${PROJECT_REF}`], {
        shell: false,
        stdio: ['ignore', 'pipe', 'ignore'],
        env: {
          PATH: process.env.PATH ?? '/usr/bin:/bin',
          LANG: process.env.LANG ?? 'C.UTF-8',
          TMPDIR: process.env.TMPDIR ?? '/tmp',
          [SECRET_NAME]: secret,
        },
      });
    } catch {
      reject(new SafeQaError('Route QA child could not start'));
      return;
    }
    let stopped = false;
    let spawnFailed = false;
    let outputInvalid = false;
    let outputBytes = 0;
    const outputChunks = [];
    let hardTimer;
    const stop = () => {
      stopped = true;
      child.kill('SIGTERM');
      hardTimer ??= setTimeout(() => child.kill('SIGKILL'), 5_000);
    };
    abortSignal?.addEventListener('abort', stop, { once: true });
    if (abortSignal?.aborted) stop();
    const timer = setTimeout(stop, timeoutMs);
    if (!child.stdout || typeof child.stdout.on !== 'function') {
      outputInvalid = true;
      stop();
    } else {
      child.stdout.on('data', (chunk) => {
        if (outputInvalid) return;
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        outputBytes += bytes.length;
        if (outputBytes > CHILD_MAX_OUTPUT_BYTES) {
          outputInvalid = true;
          stop();
        } else {
          outputChunks.push(bytes);
        }
      });
      child.stdout.on('error', () => { outputInvalid = true; stop(); });
    }
    child.on('error', () => { spawnFailed = true; });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (hardTimer) clearTimeout(hardTimer);
      abortSignal?.removeEventListener('abort', stop);
      if (stopped || spawnFailed || outputInvalid) {
        reject(new SafeQaError('Route QA smoke failed or timed out'));
        return;
      }
      let summary;
      try {
        const raw = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(outputChunks));
        summary = sanitizeRouteSmokeSummary(JSON.parse(raw));
      } catch {
        reject(new SafeQaError('Route QA child output was invalid'));
        return;
      }
      if (code !== 0 || !summary.ok) {
        reject(new SafeQaError('Route QA smoke failed'));
      } else {
        resolve(summary);
      }
    });
  });
}

/** Cleanup targets this fixed name only after its digest proves ownership. */
export async function runWithRouteQaSecret({
  projectRef,
  token,
  fetchImpl = managementHttpsRequest,
  createCredential = createRouteQaCredential,
  runChild = runTrustedRouteSmoke,
  sleep = delay,
  abortSignal,
  childTimeoutMs = CHILD_TIMEOUT_MS,
} = {}) {
  const url = managementUrl(projectRef);
  if (typeof token !== 'string' || !/^[\x21-\x7e]{20,512}$/.test(token)) {
    throw new SafeQaError('Supabase Management access token is unavailable');
  }
  if (typeof runChild !== 'function' || !Number.isSafeInteger(childTimeoutMs) ||
    childTimeoutMs < 1 || childTimeoutMs > CHILD_TIMEOUT_MS) {
    throw new SafeQaError('Route QA child configuration is invalid');
  }
  let secret;
  try {
    secret = assertCredential(createCredential());
  } catch {
    throw new SafeQaError('Temporary route QA credential generation failed');
  }
  const before = await inspectSecret(fetchImpl, url, token, secret, abortSignal);
  if (before.present) {
    throw new SafeQaError('Route QA secret already exists; nothing was changed');
  }
  if (abortSignal?.aborted) {
    throw new SafeQaError('Route QA was interrupted before secret creation');
  }

  let attemptedCreate = false;
  let postConfirmed = false;
  let postRejected = false;
  let operationError = null;
  let cleanupUncertain = false;
  let summary;
  try {
    attemptedCreate = true;
    await managementRequest(fetchImpl, url, token, 'POST', [{ name: SECRET_NAME, value: secret }], abortSignal);
    postConfirmed = true;
    const afterCreate = await inspectSecret(fetchImpl, url, token, secret, abortSignal);
    if (!afterCreate.present || !afterCreate.owned) {
      throw new SafeQaError('Route QA secret ownership was not confirmed after creation');
    }
    summary = await runChild(secret, { abortSignal, timeoutMs: childTimeoutMs });
  } catch (error) {
    // A definitive client rejection never proves that a same-name secret is
    // ours. Another administrator may have created it after our first GET.
    postRejected = !postConfirmed && error?.httpStatus >= 400 && error.httpStatus < 500;
    operationError = error instanceof SafeQaError ? error : new SafeQaError('Route QA orchestration failed');
  } finally {
    if (attemptedCreate) {
      const removeOnlyIfOwned = async () => {
        // Independent deadlines: an interrupt cannot cancel cleanup.
        const observed = await inspectSecret(fetchImpl, url, token, secret);
        if (!observed.present) return;
        if (!observed.owned) {
          cleanupUncertain = true;
          return;
        }
        await managementRequest(fetchImpl, url, token, 'DELETE', [SECRET_NAME]);
        const afterDelete = await inspectSecret(fetchImpl, url, token, secret);
        if (afterDelete.present) cleanupUncertain = true;
      };
      if (postRejected) {
        try {
          const afterRejection = await inspectSecret(fetchImpl, url, token, secret);
          if (afterRejection.present) cleanupUncertain = true;
        } catch {
          cleanupUncertain = true;
        }
      } else {
        try {
          await removeOnlyIfOwned();
        } catch {
          cleanupUncertain = true;
        }
      }
      if (!postConfirmed && !postRejected) {
        // A timed-out POST may finish server-side after our first check.
        const startedAt = Date.now();
        for (const checkpointMs of POST_UNCERTAIN_RECHECK_MS) {
          try {
            await sleep(Math.max(0, checkpointMs - (Date.now() - startedAt)));
            await removeOnlyIfOwned();
          } catch {
            cleanupUncertain = true;
          }
        }
      }
    }
  }
  if (cleanupUncertain || (!postConfirmed && !postRejected)) {
    throw new SafeQaError(`Route QA secret state uncertain; inspect or delete only ${SECRET_NAME}`);
  }
  if (postRejected) {
    throw new SafeQaError('Route QA was not run: Management POST refused; no secret was deleted');
  }
  if (operationError) {
    throw new SafeQaError(`Route QA failed; ${SECRET_NAME} was verified removed`);
  }
  return summary;
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
  const controller = new AbortController();
  let interrupted = false;
  const onSignal = () => { interrupted = true; controller.abort(); };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);
  try {
    const argv = process.argv.slice(2);
    if (argv.length !== 1 || argv[0] !== `--project-ref=${PROJECT_REF}`) {
      throw new SafeQaError(`Usage: node scripts/qa/with-route-qa-secret.mjs --project-ref=${PROJECT_REF}`);
    }
    const token = await readManagementToken();
    const summary = await runWithRouteQaSecret({
      projectRef: PROJECT_REF, token, abortSignal: controller.signal,
    });
    if (interrupted) throw new SafeQaError('Route QA was interrupted; secret cleanup completed');
    // Only a strict, bounded allowlist from the fixed child is emitted, and
    // only after the Management secret is verified absent.
    process.stdout.write(`${JSON.stringify({ ...summary, secret_cleanup: 'verified' })}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof SafeQaError ? error.message : 'Route QA harness failed unexpectedly'}\n`);
    process.exitCode = 1;
  } finally {
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  await main();
}

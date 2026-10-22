#!/usr/bin/env node
/**
 * Free, routing-only smoke for the three isolated legacy/search closures.
 * No valid chat/search payload is ever sent; no response body is read or logged.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const ROUTE_CLOSURE_PROJECT_REF = 'yngoixmvmxdfxokuafjp';
export const ROUTE_CLOSURE_FUNCTIONS = Object.freeze([
  'chat-consultant-closure-preview',
  'chat-consultant-v2-closure-preview',
  'search-products-closure-preview',
]);
export const ROUTE_CLOSURE_SECRET_ENV = 'VOLT220_ROUTE_QA_SECRET';
export const ROUTE_CLOSURE_SECRET_HEADER = 'x-volt220-route-qa-secret';
export const ROUTE_CLOSURE_TIMEOUT_MS = 5_000;

const secretPattern = /^[A-Za-z0-9_-]{32,256}$/;
const jwtPattern = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

function publicAnonKey(widgetSource) {
  const key = widgetSource.match(/supabaseKey:\s*'([^']+)'/)?.[1];
  if (typeof key !== 'string' || key.length > 2_000 || !jwtPattern.test(key)) return null;
  try {
    const payload = JSON.parse(Buffer.from(key.split('.')[1], 'base64url').toString('utf8'));
    return payload?.role === 'anon' ? key : null;
  } catch {
    return null;
  }
}

function endpointFor(functionName) {
  // The caller can select neither the destination nor the path. In particular,
  // never attach the QA credential to a URL supplied on the command line.
  return `https://${ROUTE_CLOSURE_PROJECT_REF}.supabase.co/functions/v1/${functionName}`;
}

function wrongSecret(secret) {
  return `${secret[0] === 'A' ? 'B' : 'A'}${secret.slice(1)}`;
}

const probeCases = Object.freeze([
  { name: 'missing_secret', method: 'POST', credential: 'none', expected: 403 },
  { name: 'wrong_secret', method: 'POST', credential: 'wrong', expected: 403 },
  { name: 'invalid_bearer_jwt', method: 'GET', credential: 'valid', invalidJwt: true, expected: 401 },
  { name: 'authorized_get', method: 'GET', credential: 'valid', expected: 405 },
  { name: 'authorized_malformed_json', method: 'POST', credential: 'valid', expected: 400 },
]);

async function probe({ functionName, probeCase, anonKey, secret, fetchImpl, timeoutMs }) {
  const controller = new AbortController();
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error('deadline'));
    }, timeoutMs);
  });
  // Supabase can accept a valid API key in `apikey` as a substitute for JWT
  // verification. Omit it in this negative probe: an invalid Bearer must be
  // stopped by verify_jwt before the valid QA secret reaches our handler.
  const headers = probeCase.invalidJwt
    ? { Authorization: 'Bearer invalid-route-qa-jwt' }
    : { Authorization: `Bearer ${anonKey}`, apikey: anonKey };
  if (probeCase.method === 'POST') headers['Content-Type'] = 'application/json';
  if (probeCase.credential !== 'none') {
    headers[ROUTE_CLOSURE_SECRET_HEADER] = probeCase.credential === 'valid'
      ? secret
      : wrongSecret(secret);
  }
  let response;
  try {
    response = await Promise.race([
      fetchImpl(endpointFor(functionName), {
        method: probeCase.method,
        redirect: 'error',
        headers,
        // The only POST payload is intentionally invalid. It cannot reach a
        // paid AI or catalog branch even if admission is accidentally bypassed.
        ...(probeCase.method === 'POST' ? { body: '{' } : {}),
        signal: controller.signal,
      }),
      deadline,
    ]);
    const status = response?.status;
    if (!Number.isSafeInteger(status) || status < 100 || status > 599) {
      return { ok: false, classification: 'invalid_response' };
    }
    if (status !== probeCase.expected) {
      return { ok: false, classification: 'unexpected_status', http_status: status };
    }
    return { ok: true, http_status: status };
  } catch {
    // Fetch exceptions may contain request headers or a reflected secret.
    return { ok: false, classification: 'transport' };
  } finally {
    clearTimeout(timer);
    controller.abort();
    // Never read an untrusted body. Cancel best-effort without waiting on an
    // unexpectedly streaming endpoint or allowing it to hold the smoke open.
    try { void response?.body?.cancel()?.catch(() => {}); } catch { /* no output */ }
  }
}

/** Returns 0 pass, 1 failed probe, 2 invalid configuration. */
export async function main({
  argv = process.argv.slice(2),
  env = process.env,
  widgetSource,
  fetchImpl = fetch,
  timeoutMs = ROUTE_CLOSURE_TIMEOUT_MS,
  emit = (summary) => process.stdout.write(`${JSON.stringify(summary)}\n`),
} = {}) {
  const configFailure = () => {
    emit({ ok: false, status: 'not_run', classification: 'config' });
    return 2;
  };
  if (!Array.isArray(argv) || argv.length !== 1 ||
    argv[0] !== `--project-ref=${ROUTE_CLOSURE_PROJECT_REF}` ||
    !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 ||
    timeoutMs > ROUTE_CLOSURE_TIMEOUT_MS) return configFailure();

  const secret = env?.[ROUTE_CLOSURE_SECRET_ENV];
  if (typeof secret !== 'string' || !secretPattern.test(secret)) return configFailure();

  let anonKey;
  try {
    const source = widgetSource ?? readFileSync(
      new URL('../../public/widget.js', import.meta.url), 'utf8',
    );
    anonKey = typeof source === 'string' ? publicAnonKey(source) : null;
  } catch {
    return configFailure();
  }
  if (!anonKey) return configFailure();

  const checks = [];
  for (const functionName of ROUTE_CLOSURE_FUNCTIONS) {
    for (const probeCase of probeCases) {
      const outcome = await probe({
        functionName, probeCase, anonKey, secret, fetchImpl, timeoutMs,
      });
      const check = {
        function: functionName,
        check: probeCase.name,
        expected_status: probeCase.expected,
        ...(outcome.http_status ? { http_status: outcome.http_status } : {}),
      };
      checks.push(check);
      if (!outcome.ok) {
        emit({
          ok: false,
          status: 'failed',
          classification: outcome.classification,
          checks,
        });
        return 1;
      }
    }
  }
  emit({ ok: true, status: 'passed', checks });
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    process.exitCode = await main();
  } catch {
    process.stderr.write('{"ok":false,"status":"failed","classification":"unexpected"}\n');
    process.exitCode = 1;
  }
}

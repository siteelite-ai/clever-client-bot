#!/usr/bin/env node
// Enter two newly issued, dedicated test credentials on server3 through a TTY.
// No secret is accepted in argv/env or returned by the REST query/CLI output.
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import readline from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { EXPECTED_SETTINGS, parseEnv } from './validate-compose.mjs';

export const BOUNDARY = Object.freeze({
  gateway: 'http://127.0.0.1:18081',
  envFile: '/var/lib/volt220-test-supabase/upstream/docker/.env',
  project: 'volt220test',
  mode: 'selfhost-test',
  confirm: 'set-two-isolated-server3-service-keys',
});

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PATH = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';

export class KeyEntryError extends Error {
  constructor(code) { super(code); this.name = 'KeyEntryError'; this.code = code; }
}

function insist(ok, code) {
  if (!ok) throw new KeyEntryError(code);
}

export function parseArgs(args) {
  insist(args.length === 4 && args[0] === '--mode' && args[1] === BOUNDARY.mode &&
    args[2] === '--confirm' && args[3] === BOUNDARY.confirm, 'INVALID_ARGUMENTS');
  return BOUNDARY;
}

export function validateDedicatedKeys(keys) {
  // The formats are controlled by different issuers and may change. Enforce
  // the same replacement envelope as the cabinet, not a brittle key prefix.
  for (const key of [keys?.openrouter, keys?.catalog]) {
    insist(typeof key === 'string' && key.length > 0 && key.length <= 2048 &&
      key === key.trim() && !/\s|[\u0000-\u001f\u007f]/.test(key), 'INVALID_KEY_INPUT');
  }
  insist(keys.openrouter !== keys.catalog, 'INVALID_KEY_INPUT');
  return keys;
}

function inspectContainer(name, service) {
  const result = spawnSync('/usr/bin/docker', ['inspect', name], {
    encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, env: { PATH },
  });
  // Docker inspect may contain credentials; never print stdout or stderr.
  insist(result.status === 0, 'CONTAINER_NOT_FOUND');
  let container;
  try { [container] = JSON.parse(result.stdout); }
  catch { throw new KeyEntryError('CONTAINER_INSPECT_FAILED'); }
  insist(container?.Name === `/${name}` && container.State?.Running === true &&
    container.Config?.Labels?.['com.docker.compose.project'] === BOUNDARY.project &&
    container.Config?.Labels?.['com.docker.compose.service'] === service &&
    JSON.stringify(Object.keys(container.NetworkSettings?.Networks ?? {})) ===
      JSON.stringify(['volt220test_internal']),
  'CONTAINER_BOUNDARY_MISMATCH');
  return container;
}

function checkLocalBoundary() {
  insist(process.platform === 'linux' && process.getuid?.() === 0, 'ROOT_LINUX_REQUIRED');
  insist(process.stdin.isTTY === true && process.stdout.isTTY === true, 'INTERACTIVE_TTY_REQUIRED');

  const db = inspectContainer('volt220test-db', 'db');
  insist(Object.keys(db.HostConfig?.PortBindings ?? {}).length === 0,
    'DATABASE_PORT_EXPOSED');
  const gateway = inspectContainer('volt220test-api-gw', 'api-gw');
  const binding = gateway.HostConfig?.PortBindings?.['8000/tcp'];
  insist(Array.isArray(binding) && binding.length === 1 &&
    binding[0].HostIp === '127.0.0.1' && binding[0].HostPort === '18081' &&
    Object.keys(gateway.HostConfig.PortBindings).length === 1,
  'GATEWAY_BOUNDARY_MISMATCH');

  let env;
  try {
    const stat = lstatSync(BOUNDARY.envFile);
    const parent = dirname(BOUNDARY.envFile);
    const parentStat = lstatSync(parent);
    insist(stat.isFile() && !stat.isSymbolicLink() && stat.uid === 0 &&
      (stat.mode & 0o777) === 0o600 && stat.size <= 64 * 1024 &&
      realpathSync(BOUNDARY.envFile) === BOUNDARY.envFile &&
      parentStat.isDirectory() && parentStat.uid === 0 &&
      (parentStat.mode & 0o022) === 0 && realpathSync(parent) === parent,
    'PRIVATE_ENV_BOUNDARY_MISMATCH');
    env = parseEnv(readFileSync(BOUNDARY.envFile, 'utf8'));
  } catch { throw new KeyEntryError('PRIVATE_ENV_BOUNDARY_MISMATCH'); }
  for (const [name, expected] of Object.entries(EXPECTED_SETTINGS)) {
    insist(env.get(name) === expected, 'PRIVATE_ENV_BOUNDARY_MISMATCH');
  }
  insist(['LOVABLE_API_KEY', 'OPENROUTER_API_KEY', 'VOLT220_API_TOKEN',
    'CATALOG_API_TOKEN'].every((name) => !env.has(name)),
  'PRIVATE_ENV_BOUNDARY_MISMATCH');
  const secret = env.get('SUPABASE_SECRET_KEY');
  const serviceJwt = env.get('SERVICE_ROLE_KEY_ASYMMETRIC');
  insist(secret?.startsWith('sb_secret_') && serviceJwt?.split('.').length === 3,
    'INVALID_TEST_KEYS');
  return { secret, serviceJwt };
}

function adminHeaders(auth, extras = {}) {
  return {
    apikey: auth.secret,
    Authorization: `Bearer ${auth.serviceJwt}`,
    Accept: 'application/json',
    'Cache-Control': 'no-store',
    ...extras,
  };
}

async function request(fetchImpl, method, path, auth, body, extraHeaders = {}) {
  let response;
  try {
    response = await fetchImpl(`${BOUNDARY.gateway}${path}`, {
      method,
      headers: adminHeaders(auth, {
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...extraHeaders,
      }),
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: 'error',
      signal: AbortSignal.timeout(10_000),
    });
  } catch { throw new KeyEntryError('NETWORK_FAILURE'); }
  return response;
}

async function idOnly(fetchImpl, path, auth) {
  const response = await request(fetchImpl, 'GET', path, auth);
  insist(response.status === 200, 'READ_BOUNDARY_FAILED');
  const length = Number(response.headers.get('content-length') ?? '0');
  insist(!Number.isFinite(length) || length <= 4096, 'UNSAFE_RESPONSE');
  let text;
  try { text = await response.text(); }
  catch { throw new KeyEntryError('READ_BOUNDARY_FAILED'); }
  insist(text.length <= 4096, 'UNSAFE_RESPONSE');
  let value;
  try { value = JSON.parse(text); }
  catch { throw new KeyEntryError('UNSAFE_RESPONSE'); }
  insist(Array.isArray(value) && value.every((item) =>
    item && typeof item === 'object' && !Array.isArray(item) &&
    Object.keys(item).length === 1 && UUID.test(item.id ?? '')),
  'UNSAFE_RESPONSE');
  return value.map((item) => item.id);
}

async function hasOne(fetchImpl, path, auth, id) {
  const rows = await idOnly(fetchImpl, path, auth);
  return rows.length === 1 && rows[0] === id;
}

/** Pure, injectable network workflow for offline tests. One conditional SQL row update. */
export async function setIsolatedServiceKeys({ keys, auth, fetchImpl }) {
  validateDedicatedKeys(keys);
  insist(typeof fetchImpl === 'function' && auth?.secret?.startsWith('sb_secret_') &&
    auth?.serviceJwt?.split('.').length === 3, 'INVALID_DEPENDENCY');
  const rows = await idOnly(fetchImpl, '/rest/v1/app_settings?select=id&limit=2', auth);
  insist(rows.length === 1, 'SETTINGS_ROW_BOUNDARY_MISMATCH');
  const [id] = rows;
  const base = `/rest/v1/app_settings?id=eq.${id}`;
  for (const column of ['openrouter_api_key', 'volt220_api_token']) {
    insist(await hasOne(fetchImpl,
      `${base}&${column}=is.null&select=id`, auth, id),
    'EXISTING_KEY_OR_CHANGED_ROW');
  }

  // Both predicates are on the same SQL UPDATE: never replace existing keys.
  // Exact count gives proof that the conditional update affected one row even
  // when PostgREST is asked to return no representation.
  let response;
  try {
    response = await request(fetchImpl, 'PATCH',
      `${base}&openrouter_api_key=is.null&volt220_api_token=is.null`, auth,
      { openrouter_api_key: keys.openrouter, volt220_api_token: keys.catalog },
      { Prefer: 'return=minimal,count=exact' });
  } catch { throw new KeyEntryError('WRITE_OUTCOME_UNKNOWN'); }
  // Do not read or print any error response; some gateways include request
  // fragments in diagnostics. A failed or missing count is never retried.
  const affected = response.headers.get('content-range');
  // PostgREST has emitted both range forms across releases; either proves
  // exactly one affected row, whereas a missing or wildcard count does not.
  insist(response.status === 204 && (affected === '*/1' || affected === '0-0/1'),
    'WRITE_OUTCOME_UNKNOWN');
  try { await response.body?.cancel(); }
  catch { throw new KeyEntryError('WRITE_OUTCOME_UNKNOWN'); }

  // Presence is checked using WHERE filters and SELECT id only. No request
  // asks PostgREST to return a stored credential, even for verification.
  for (const column of ['openrouter_api_key', 'volt220_api_token']) {
    let present;
    try {
      present = await hasOne(fetchImpl,
        `${base}&${column}=not.is.null&select=id`, auth, id);
    } catch { throw new KeyEntryError('VERIFICATION_OUTCOME_UNKNOWN'); }
    insist(present, 'PARTIAL_OR_UNKNOWN_OUTCOME');
  }
  return { updatedRows: 1, bothPresent: true };
}

/** Visible attestation, then hidden TTY prompts. stty receives no key args. */
export async function promptDedicatedKeys({
  input = process.stdin,
  output = process.stdout,
  runStty = (args) => spawnSync('/usr/bin/stty', args,
    { stdio: 'inherit', env: { PATH } }),
  makeReadline = () => readline.createInterface({ input, output, terminal: false }),
} = {}) {
  insist(input.isTTY === true && output.isTTY === true, 'INTERACTIVE_TTY_REQUIRED');
  const rl = makeReadline();
  let echoDisabled = false;
  const restore = () => {
    if (!echoDisabled) return;
    const result = runStty(['echo']);
    echoDisabled = false;
    insist(result.status === 0, 'TTY_ECHO_RESTORE_FAILED');
  };
  const interrupted = () => {
    try { restore(); }
    catch { process.stderr.write('FAIL TTY_ECHO_RESTORE_FAILED\n'); }
    output.write('\n');
    process.exit(130);
  };
  process.once('SIGINT', interrupted);
  process.once('SIGTERM', interrupted);
  try {
    const affirmation = await rl.question(
      'Подтвердите, что ОБА ключа новые и выделены только server3 (введите SERVER3): ');
    insist(affirmation === 'SERVER3', 'DEDICATED_KEY_CONFIRMATION_REQUIRED');
    echoDisabled = true;
    const disabled = runStty(['-echo']);
    insist(disabled.status === 0, 'TTY_ECHO_CONTROL_FAILED');
    const openrouter = await rl.question('Новый тестовый OpenRouter key (ввод скрыт): ');
    output.write('\n');
    const catalog = await rl.question('Новый тестовый catalog token (ввод скрыт): ');
    output.write('\n');
    return validateDedicatedKeys({ openrouter, catalog });
  } finally {
    rl.close();
    restore();
    process.removeListener('SIGINT', interrupted);
    process.removeListener('SIGTERM', interrupted);
  }
}

async function main() {
  parseArgs(process.argv.slice(2));
  const auth = checkLocalBoundary();
  const keys = await promptDedicatedKeys();
  const result = await setIsolatedServiceKeys({ keys, auth, fetchImpl: fetch });
  process.stdout.write(`PASS ${result.updatedRows} isolated settings row updated; both credentials present.\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    // Never stringify fetch, PostgREST, filesystem, or validation errors.
    process.stderr.write(`FAIL ${error instanceof KeyEntryError ? error.code : 'KEY_ENTRY_FAILED'}\n`);
    process.exitCode = 1;
  });
}

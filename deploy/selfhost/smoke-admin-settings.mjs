#!/usr/bin/env node
// Bounded, no-paid-API authorization smoke for the isolated server3 cabinet.
// The only PATCHes target an independently confirmed absent UUID. No key,
// password, token, response body, or Docker inspect output is ever logged.
import { spawnSync } from 'node:child_process';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EXPECTED_SETTINGS, parseEnv } from './validate-compose.mjs';

export const BOUNDARY = Object.freeze({
  gateway: 'http://127.0.0.1:18081',
  env: '/var/lib/volt220-test-supabase/upstream/docker/.env',
  credentials: '/var/lib/volt220-test-supabase/private/qa-admin-20261014.json',
  project: 'volt220test',
  dbContainer: 'volt220test-db',
  email: 'qa-admin-20261014@volt220.test',
  mode: 'selfhost-test',
  confirm: 'probe-isolated-admin-settings',
});

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ABSENT_ID = '00000000-0000-4000-8000-000000000000';
const SECRET_COLUMNS = Object.freeze([
  'volt220_api_token', 'openrouter_api_key', 'google_api_key',
]);
const PUBLIC_FIELDS = Object.freeze([
  'id', 'hasVolt220ApiToken', 'hasOpenrouterKey', 'hasGoogleApiKey',
  'ai_provider', 'ai_model', 'classifier_provider', 'classifier_model',
  'classifier_prompt', 'active_pipeline',
]);

export class SmokeError extends Error {
  constructor(code) { super(code); this.name = 'SmokeError'; this.code = code; }
}

function insist(ok, code) {
  if (!ok) throw new SmokeError(code);
}

export function parseExactArgs(args) {
  const flags = ['--gateway', '--env', '--credentials', '--project',
    '--db-container', '--email', '--mode', '--confirm'];
  insist(args.length === flags.length * 2, 'INVALID_ARGUMENTS');
  const received = new Map();
  for (let i = 0; i < args.length; i += 2) {
    insist(flags.includes(args[i]) && !received.has(args[i]), 'INVALID_ARGUMENTS');
    received.set(args[i], args[i + 1]);
  }
  for (const [name, value] of Object.entries(BOUNDARY)) {
    const flag = name === 'dbContainer' ? '--db-container' : `--${name}`;
    insist(received.get(flag) === value, 'BOUNDARY_MISMATCH');
  }
  return BOUNDARY;
}

function inspectContainer(name, service) {
  // The JSON may contain environment secrets: deliberately suppress it.
  const child = spawnSync('/usr/bin/docker', ['inspect', name], {
    encoding: 'utf8', maxBuffer: 8 * 1024 * 1024,
    env: { PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin' },
  });
  insist(child.status === 0, 'CONTAINER_NOT_FOUND');
  let container;
  try { [container] = JSON.parse(child.stdout); }
  catch { throw new SmokeError('CONTAINER_INSPECT_FAILED'); }
  insist(container?.Name === `/${name}` && container.State?.Running === true &&
    container.Config?.Labels?.['com.docker.compose.project'] === BOUNDARY.project &&
    container.Config?.Labels?.['com.docker.compose.service'] === service,
  'CONTAINER_BOUNDARY_MISMATCH');
  return container;
}

function verifyLocalRuntime() {
  insist(process.platform === 'linux' && process.getuid?.() === 0,
    'ROOT_LINUX_REQUIRED');
  const db = inspectContainer(BOUNDARY.dbContainer, 'db');
  insist(Object.keys(db.HostConfig?.PortBindings ?? {}).length === 0,
    'DATABASE_PORT_EXPOSED');
  const gateway = inspectContainer('volt220test-api-gw', 'api-gw');
  const binding = gateway.HostConfig?.PortBindings?.['8000/tcp'];
  insist(Array.isArray(binding) && binding.length === 1 &&
    binding[0].HostIp === '127.0.0.1' && binding[0].HostPort === '18081' &&
    Object.keys(gateway.HostConfig.PortBindings).length === 1,
  'GATEWAY_BOUNDARY_MISMATCH');
}

function readPrivateFile(path, parentMode, maxBytes) {
  const stat = lstatSync(path);
  const parent = dirname(path);
  const parentStat = lstatSync(parent);
  insist(stat.isFile() && !stat.isSymbolicLink() && stat.uid === 0 &&
    (stat.mode & 0o777) === 0o600 && stat.size <= maxBytes &&
    realpathSync(path) === path && parentStat.isDirectory() &&
    parentStat.uid === 0 && realpathSync(parent) === parent &&
    (parentStat.mode & 0o022) === 0 &&
    (parentMode === null || (parentStat.mode & 0o777) === parentMode),
  'PRIVATE_FILE_BOUNDARY_MISMATCH');
  return readFileSync(path, 'utf8');
}

function readPrivateInputs() {
  let settings;
  let credential;
  try {
    settings = parseEnv(readPrivateFile(BOUNDARY.env, null, 64 * 1024));
    credential = JSON.parse(readPrivateFile(BOUNDARY.credentials, 0o700, 4096));
  } catch { throw new SmokeError('PRIVATE_FILE_BOUNDARY_MISMATCH'); }
  for (const [key, value] of Object.entries(EXPECTED_SETTINGS)) {
    insist(settings.get(key) === value, 'PRIVATE_ENV_BOUNDARY_MISMATCH');
  }
  insist(!settings.has('LOVABLE_API_KEY') &&
    settings.get('SUPABASE_PUBLISHABLE_KEY')?.startsWith('sb_publishable_'),
  'PRIVATE_ENV_BOUNDARY_MISMATCH');
  insist(credential?.email === BOUNDARY.email &&
    typeof credential?.password === 'string' && credential.password.length >= 40,
  'ADMIN_CREDENTIAL_BOUNDARY_MISMATCH');
  return { publicKey: settings.get('SUPABASE_PUBLISHABLE_KEY'), credential };
}

async function request(fetchImpl, method, path, headers, body) {
  let response;
  try {
    response = await fetchImpl(`${BOUNDARY.gateway}${path}`, {
      method,
      headers: {
        Accept: 'application/json', ...headers,
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: 'error',
      signal: AbortSignal.timeout(10_000),
    });
  } catch { throw new SmokeError('NETWORK_FAILURE'); }
  const length = Number(response.headers.get('content-length') ?? '0');
  insist(!Number.isFinite(length) || length <= 64 * 1024, 'RESPONSE_TOO_LARGE');
  let text;
  try { text = await response.text(); }
  catch { throw new SmokeError('RESPONSE_READ_FAILED'); }
  insist(text.length <= 64 * 1024, 'RESPONSE_TOO_LARGE');
  let value = null;
  if (text) {
    try { value = JSON.parse(text); }
    catch { throw new SmokeError('INVALID_RESPONSE'); }
  }
  return { status: response.status, value, headers: response.headers };
}

function assertPublicSettings(value) {
  insist(value && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).length === 1 &&
    value.settings && typeof value.settings === 'object' &&
    !Array.isArray(value.settings), 'UNSAFE_SETTINGS_RESPONSE');
  const settings = value.settings;
  insist(JSON.stringify(Object.keys(settings).sort()) ===
    JSON.stringify([...PUBLIC_FIELDS].sort()), 'UNSAFE_SETTINGS_RESPONSE');
  insist(UUID.test(settings.id ?? '') &&
    typeof settings.hasVolt220ApiToken === 'boolean' &&
    typeof settings.hasOpenrouterKey === 'boolean' &&
    typeof settings.hasGoogleApiKey === 'boolean' &&
    typeof settings.ai_provider === 'string' &&
    typeof settings.ai_model === 'string' &&
    typeof settings.classifier_provider === 'string' &&
    typeof settings.classifier_model === 'string' &&
    (settings.classifier_prompt === null || typeof settings.classifier_prompt === 'string') &&
    typeof settings.active_pipeline === 'string', 'UNSAFE_SETTINGS_RESPONSE');
}

// Injectable for offline unit tests. The only possible destination is fixed
// loopback. A real run additionally checks root/Docker/private-file boundaries.
export async function smokeAdminSettings({ gateway, publicKey, credential, fetchImpl }) {
  insist(gateway === BOUNDARY.gateway, 'BOUNDARY_MISMATCH');
  insist(publicKey?.startsWith('sb_publishable_') &&
    credential?.email === BOUNDARY.email &&
    typeof credential?.password === 'string' && credential.password.length >= 40 &&
    typeof fetchImpl === 'function', 'INVALID_DEPENDENCY');
  const anon = { apikey: publicKey };
  const functionPath = '/functions/v1/admin-settings';

  const noToken = await request(fetchImpl, 'POST', functionPath,
    anon, { action: 'read' });
  insist(noToken.status === 401, 'NO_TOKEN_GATE_FAILED');

  const login = await request(fetchImpl, 'POST', '/auth/v1/token?grant_type=password',
    { ...anon, Authorization: `Bearer ${publicKey}` }, credential);
  insist(login.status === 200 && login.value?.user?.email === BOUNDARY.email &&
    UUID.test(login.value?.user?.id ?? '') &&
    typeof login.value?.access_token === 'string' &&
    login.value.access_token.length > 20, 'ADMIN_LOGIN_FAILED');
  const admin = { ...anon, Authorization: `Bearer ${login.value.access_token}` };

  const foreign = await request(fetchImpl, 'POST', functionPath,
    { ...admin, Origin: 'https://foreign.invalid' }, { action: 'read' });
  insist(foreign.status === 403, 'FOREIGN_ORIGIN_GATE_FAILED');

  const allowedOrigin = 'https://chat-volt-next.testdevops.ru';
  const read = await request(fetchImpl, 'POST', functionPath,
    { ...admin, Origin: allowedOrigin }, { action: 'read' });
  insist(read.status === 200 &&
    read.headers.get('access-control-allow-origin') === allowedOrigin,
  'ADMIN_SETTINGS_GATE_FAILED');
  assertPublicSettings(read.value);

  const existing = await request(fetchImpl, 'GET',
    '/rest/v1/app_settings?select=id&limit=1', admin);
  insist(existing.status === 200 && Array.isArray(existing.value) &&
    existing.value.length === 1 && UUID.test(existing.value[0]?.id ?? ''),
  'REST_POSITIVE_CONTROL_FAILED');
  const missing = await request(fetchImpl, 'GET',
    `/rest/v1/app_settings?id=eq.${ABSENT_ID}&select=id`, admin);
  insist(missing.status === 200 && Array.isArray(missing.value) &&
    missing.value.length === 0, 'PATCH_SENTINEL_NOT_EMPTY');

  for (const column of SECRET_COLUMNS) {
    const readSecret = await request(fetchImpl, 'GET',
      `/rest/v1/app_settings?select=${column}&limit=1`, admin);
    insist(readSecret.status === 403, 'REST_SECRET_READ_NOT_DENIED');

    // Exact UUID was just proven absent; if an UPDATE grant accidentally
    // exists, the empty filter still cannot change a stored credential.
    const writeSecret = await request(fetchImpl, 'PATCH',
      `/rest/v1/app_settings?id=eq.${ABSENT_ID}`,
      { ...admin, Prefer: 'return=minimal' },
      { [column]: '__smoke_absent_row_no_change__' });
    insist(writeSecret.status === 403, 'REST_SECRET_WRITE_NOT_DENIED');
  }

  return [
    'admin-settings no-token 401',
    'synthetic admin sign-in 200',
    'foreign Origin 403',
    'admin-settings read 200 and presence-only payload',
    'REST non-secret positive control 200',
    'REST secret SELECT/PATCH 403 (3 columns)',
  ];
}

async function main() {
  parseExactArgs(process.argv.slice(2));
  verifyLocalRuntime();
  const { publicKey, credential } = readPrivateInputs();
  const labels = await smokeAdminSettings({
    gateway: BOUNDARY.gateway, publicKey, credential, fetchImpl: fetch,
  });
  for (const label of labels) process.stdout.write(`PASS ${label}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    // Errors from Fetch, Auth, REST, Docker, and the filesystem may contain
    // credentials. Show only fixed error codes from this file.
    process.stderr.write(`FAIL ${error instanceof SmokeError ? error.code : 'SMOKE_FAILED'}\n`);
    process.exitCode = 1;
  });
}

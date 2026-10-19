#!/usr/bin/env node
// Interactive, one-account provisioning for the isolated server3 cabinet.
// Do not run this against the production Supabase or over a public gateway.
import { spawnSync } from 'node:child_process';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import readline from 'node:readline/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EXPECTED_SETTINGS, parseEnv } from './validate-compose.mjs';

export const BOUNDARY = Object.freeze({
  gateway: 'http://127.0.0.1:18081',
  env: '/var/lib/volt220-test-supabase/upstream/docker/.env',
  project: 'volt220test',
  dbContainer: 'volt220test-db',
  qaEmail: 'qa-admin-20261014@volt220.test',
  mode: 'selfhost-test',
  confirm: 'create-one-isolated-server3-admin',
});

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PATH = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';

export class ProvisionError extends Error {
  constructor(code) { super(code); this.name = 'ProvisionError'; this.code = code; }
}

function requireSafe(condition, code) {
  if (!condition) throw new ProvisionError(code);
}

export function validateEmail(value) {
  requireSafe(typeof value === 'string' && value.length <= 254 &&
    value === value.toLowerCase() && /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]{1,64}@[a-z0-9.-]{1,189}$/.test(value),
  'INVALID_EMAIL');
  const domain = value.split('@')[1];
  requireSafe(domain.includes('.') && domain.split('.').every((label) =>
    label.length > 0 && label.length <= 63 && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label)) &&
    value !== BOUNDARY.qaEmail && !domain.endsWith('.test'), 'INVALID_EMAIL');
  return value;
}

export function validatePassword(value, email) {
  requireSafe(typeof value === 'string' && value.length >= 20 && value.length <= 128 &&
    value === value.trim() && !/[\u0000-\u001f\u007f]/.test(value) &&
    value.toLowerCase() !== email.toLowerCase(), 'WEAK_PASSWORD');
  return value;
}

export function parseArgs(args) {
  requireSafe(args.length === 6 && args[0] === '--email' &&
    args[2] === '--mode' && args[3] === BOUNDARY.mode &&
    args[4] === '--confirm' && args[5] === BOUNDARY.confirm,
  'INVALID_ARGUMENTS');
  return validateEmail(args[1]);
}

function inspectContainer(name, service) {
  const child = spawnSync('/usr/bin/docker', ['inspect', name], {
    encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, env: { PATH },
  });
  requireSafe(child.status === 0, 'CONTAINER_NOT_FOUND');
  let container;
  try { [container] = JSON.parse(child.stdout); }
  catch { throw new ProvisionError('CONTAINER_INSPECT_FAILED'); }
  requireSafe(container?.Name === `/${name}` && container.State?.Running === true &&
    container.Config?.Labels?.['com.docker.compose.project'] === BOUNDARY.project &&
    container.Config?.Labels?.['com.docker.compose.service'] === service,
  'CONTAINER_BOUNDARY_MISMATCH');
  return container;
}

function verifyLocalRuntime() {
  requireSafe(process.platform === 'linux' && process.getuid?.() === 0,
    'ROOT_LINUX_REQUIRED');
  requireSafe(process.stdin.isTTY === true && process.stdout.isTTY === true,
    'INTERACTIVE_TTY_REQUIRED');
  const db = inspectContainer(BOUNDARY.dbContainer, 'db');
  requireSafe(Object.keys(db.HostConfig?.PortBindings ?? {}).length === 0,
    'DATABASE_PORT_EXPOSED');
  const gateway = inspectContainer('volt220test-api-gw', 'api-gw');
  const binding = gateway.HostConfig?.PortBindings?.['8000/tcp'];
  requireSafe(Array.isArray(binding) && binding.length === 1 &&
    binding[0].HostIp === '127.0.0.1' && binding[0].HostPort === '18081' &&
    Object.keys(gateway.HostConfig.PortBindings).length === 1,
  'GATEWAY_BOUNDARY_MISMATCH');
}

function readPrivateKeys() {
  const file = BOUNDARY.env;
  const stat = lstatSync(file);
  requireSafe(stat.isFile() && !stat.isSymbolicLink() && stat.uid === 0 &&
    (stat.mode & 0o777) === 0o600 && realpathSync(file) === file,
  'PRIVATE_ENV_BOUNDARY_MISMATCH');
  const env = parseEnv(readFileSync(file, 'utf8'));
  for (const [key, value] of Object.entries(EXPECTED_SETTINGS)) {
    requireSafe(env.get(key) === value, 'PRIVATE_ENV_BOUNDARY_MISMATCH');
  }
  requireSafe(['LOVABLE_API_KEY', 'OPENROUTER_API_KEY', 'VOLT220_API_TOKEN',
    'CATALOG_API_TOKEN'].every((key) => !env.has(key)),
  'PRIVATE_ENV_BOUNDARY_MISMATCH');
  const keys = {
    secret: env.get('SUPABASE_SECRET_KEY'),
    serviceJwt: env.get('SERVICE_ROLE_KEY_ASYMMETRIC'),
    public: env.get('SUPABASE_PUBLISHABLE_KEY'),
  };
  requireSafe(keys.secret?.startsWith('sb_secret_') &&
    keys.public?.startsWith('sb_publishable_') &&
    keys.serviceJwt?.split('.').length === 3, 'INVALID_TEST_KEYS');
  return keys;
}

function adminHeaders(keys) {
  return { apikey: keys.secret, Authorization: `Bearer ${keys.serviceJwt}` };
}

async function requestJson(fetchImpl, method, path, headers, payload, allowedStatuses) {
  let response;
  try {
    response = await fetchImpl(`${BOUNDARY.gateway}${path}`, {
      method,
      headers: { Accept: 'application/json', ...headers,
        ...(payload === undefined ? {} : { 'Content-Type': 'application/json' }) },
      body: payload === undefined ? undefined : JSON.stringify(payload),
      redirect: 'error',
      signal: AbortSignal.timeout(10_000),
    });
  } catch { throw new ProvisionError('NETWORK_FAILURE'); }
  requireSafe(allowedStatuses.includes(response.status), 'UNEXPECTED_HTTP_STATUS');
  if (response.status === 204) return null;
  const length = Number(response.headers.get('content-length') ?? '0');
  requireSafe(!Number.isFinite(length) || length <= 131_072, 'RESPONSE_TOO_LARGE');
  let body;
  try { body = await response.text(); }
  catch { throw new ProvisionError('RESPONSE_READ_FAILED'); }
  requireSafe(body.length <= 131_072, 'RESPONSE_TOO_LARGE');
  if (!body) return null;
  try { return JSON.parse(body); }
  catch { throw new ProvisionError('INVALID_RESPONSE'); }
}

function exactlyOneRole(value, userId, role) {
  requireSafe(Array.isArray(value) && value.length === 1 &&
    UUID.test(value[0]?.id ?? '') && value[0].user_id === userId &&
    value[0].role === role, 'ROLE_MISMATCH');
  return value[0];
}

function authUser(value, id, email) {
  const user = value?.user ?? value;
  requireSafe(user?.id === id && user?.email === email, 'AUTH_USER_MISMATCH');
  return user;
}

/** Pure network workflow. A create with unknown outcome is never retried/deleted blindly. */
export async function provisionIsolatedAdmin({ email, password, keys, fetchImpl }) {
  validateEmail(email);
  validatePassword(password, email);
  requireSafe(typeof fetchImpl === 'function' &&
    keys?.secret?.startsWith('sb_secret_') &&
    keys?.public?.startsWith('sb_publishable_') &&
    keys?.serviceJwt?.split('.').length === 3, 'INVALID_DEPENDENCY');
  const rootHeaders = adminHeaders(keys);
  const publicHeaders = { apikey: keys.public };
  await requestJson(fetchImpl, 'POST', '/functions/v1/admin-users',
    publicHeaders, { action: 'list' }, [401]);
  const existing = await requestJson(fetchImpl, 'GET',
    '/auth/v1/admin/users?page=1&per_page=1000', rootHeaders, undefined, [200]);
  requireSafe(Array.isArray(existing?.users) && existing.users.length <= 1 &&
    (existing.total === undefined || existing.total === existing.users.length) &&
    (existing.users.length === 0 ||
      (UUID.test(existing.users[0]?.id ?? '') &&
        existing.users[0].email === BOUNDARY.qaEmail)),
  'AUTH_STORE_BOUNDARY_MISMATCH');
  if (existing.total === undefined) {
    // Older Auth versions may omit the count. A second page prevents a
    // truncated first page from being mistaken for an empty/QA-only store.
    const nextPage = await requestJson(fetchImpl, 'GET',
      '/auth/v1/admin/users?page=2&per_page=1000', rootHeaders, undefined, [200]);
    requireSafe(Array.isArray(nextPage?.users) && nextPage.users.length === 0,
      'AUTH_STORE_BOUNDARY_MISMATCH');
  }
  if (existing.users.length === 1) {
    const qaId = existing.users[0].id;
    exactlyOneRole(await requestJson(fetchImpl, 'GET',
      `/rest/v1/user_roles?user_id=eq.${qaId}&select=id,user_id,role`,
      rootHeaders, undefined, [200]), qaId, 'admin');
  }

  let createdId = null;
  let attemptedCreate = false;
  try {
    attemptedCreate = true;
    const created = await requestJson(fetchImpl, 'POST', '/auth/v1/admin/users',
      rootHeaders, { email, password, email_confirm: true,
        user_metadata: { display_name: email } }, [200, 201]);
    const newUser = created?.user ?? created;
    requireSafe(UUID.test(newUser?.id ?? '') && newUser.email === email,
      'CREATED_USER_MISMATCH');
    createdId = newUser.id;
    authUser(await requestJson(fetchImpl, 'GET',
      `/auth/v1/admin/users/${createdId}`, rootHeaders, undefined, [200]),
    createdId, email);
    const profilePath = `/rest/v1/profiles?user_id=eq.${createdId}&select=id,user_id,display_name`;
    const profiles = await requestJson(fetchImpl, 'GET', profilePath,
      rootHeaders, undefined, [200]);
    requireSafe(Array.isArray(profiles) && profiles.length === 1 &&
      UUID.test(profiles[0]?.id ?? '') && profiles[0].user_id === createdId &&
      profiles[0].display_name === email, 'PROFILE_MISMATCH');
    const rolePath = `/rest/v1/user_roles?user_id=eq.${createdId}&select=id,user_id,role`;
    const viewer = exactlyOneRole(await requestJson(fetchImpl, 'GET',
      rolePath, rootHeaders, undefined, [200]), createdId, 'viewer');
    const promoted = exactlyOneRole(await requestJson(fetchImpl, 'PATCH',
      `/rest/v1/user_roles?id=eq.${viewer.id}&user_id=eq.${createdId}&role=eq.viewer`,
      { ...rootHeaders, Prefer: 'return=representation' },
      { role: 'admin' }, [200]), createdId, 'admin');
    requireSafe(promoted.id === viewer.id, 'ROLE_MISMATCH');
    const verified = exactlyOneRole(await requestJson(fetchImpl, 'GET',
      rolePath, rootHeaders, undefined, [200]), createdId, 'admin');
    requireSafe(verified.id === viewer.id, 'ROLE_MISMATCH');
    const session = await requestJson(fetchImpl, 'POST',
      '/auth/v1/token?grant_type=password',
      { ...publicHeaders, Authorization: `Bearer ${keys.public}` },
      { email, password }, [200]);
    requireSafe(session?.user?.id === createdId && session.user.email === email &&
      typeof session.access_token === 'string' && session.access_token.length > 20,
    'LOGIN_VERIFICATION_FAILED');
    const adminResult = await requestJson(fetchImpl, 'POST',
      '/functions/v1/admin-users',
      { ...publicHeaders, Authorization: `Bearer ${session.access_token}` },
      { action: 'list' }, [200]);
    requireSafe(Array.isArray(adminResult?.users) &&
      adminResult.users.some((entry) => entry.id === createdId &&
        entry.email === email && entry.role === 'admin'),
    'ADMIN_FUNCTION_VERIFICATION_FAILED');
    return { userId: createdId, email };
  } catch (error) {
    if (createdId) {
      try {
        await requestJson(fetchImpl, 'DELETE',
          `/auth/v1/admin/users/${createdId}`, rootHeaders, undefined, [200, 204]);
      } catch { throw new ProvisionError('ROLLBACK_REQUIRED'); }
    } else if (attemptedCreate) {
      // The Auth request may have committed before a timeout/error. The operator
      // must inspect the exact email locally; never guess a UUID or retry.
      throw new ProvisionError('CREATE_OUTCOME_UNKNOWN');
    }
    throw error instanceof ProvisionError ? error : new ProvisionError('PROVISION_FAILED');
  }
}

async function interactiveInput(email) {
  // stty receives no secret arguments. Both stdin and stdout must be a real
  // terminal; neither a pipe nor shell argv/environment can carry a password.
  // Keep the email confirmation visible; disable echo only for passwords.
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout,
    terminal: false });
  let echoDisabled = false;
  const restore = () => {
    if (!echoDisabled) return;
    const restored = spawnSync('/usr/bin/stty', ['echo'],
      { stdio: 'inherit', env: { PATH } });
    echoDisabled = false;
    requireSafe(restored.status === 0, 'TTY_ECHO_RESTORE_FAILED');
  };
  const interrupted = () => {
    try { restore(); }
    catch { process.stderr.write('FAIL: TTY_ECHO_RESTORE_FAILED\n'); }
    process.stdout.write('\n');
    process.exitCode = 130;
    process.exit();
  };
  process.once('SIGINT', interrupted);
  process.once('SIGTERM', interrupted);
  try {
    const repeatedEmail = await rl.question(`Подтвердите адрес ${email}, введя его ещё раз: `);
    requireSafe(repeatedEmail === email, 'EMAIL_CONFIRMATION_MISMATCH');
    echoDisabled = true;
    const off = spawnSync('/usr/bin/stty', ['-echo'], { stdio: 'inherit', env: { PATH } });
    requireSafe(off.status === 0, 'TTY_ECHO_CONTROL_FAILED');
    const password = await rl.question('Новый пароль (не показывается, 20–128 символов): ');
    process.stdout.write('\n');
    validatePassword(password, email);
    const repeat = await rl.question('Повторите пароль: ');
    process.stdout.write('\n');
    requireSafe(repeat === password, 'PASSWORD_CONFIRMATION_MISMATCH');
    return password;
  } finally {
    rl.close();
    restore();
    process.removeListener('SIGINT', interrupted);
    process.removeListener('SIGTERM', interrupted);
  }
}

async function main() {
  const email = parseArgs(process.argv.slice(2));
  verifyLocalRuntime();
  const keys = readPrivateKeys();
  const password = await interactiveInput(email);
  const result = await provisionIsolatedAdmin({ email, password, keys, fetchImpl: fetch });
  process.stdout.write(`PASS: isolated admin ${result.email} (${result.userId}) created; password was not stored.\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    // Do not stringify network errors, HTTP bodies, tokens or passwords.
    process.stderr.write(`FAIL: ${error instanceof ProvisionError ? error.code : 'PROVISION_FAILED'}\n`);
    process.exitCode = 1;
  });
}

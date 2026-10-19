#!/usr/bin/env node
// One-time bootstrap for the *isolated* server3 QA database. Never use this
// against a public URL, production Supabase, or a database with existing users.
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  closeSync, existsSync, fchmodSync, fsyncSync, lstatSync, mkdirSync,
  openSync, readFileSync, realpathSync, unlinkSync, writeFileSync,
} from 'node:fs';
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
  confirm: 'create-isolated-synthetic-admin',
});

const DISPLAY_NAME = 'Test QA Admin (isolated)';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class BootstrapError extends Error {
  constructor(code) { super(code); this.name = 'BootstrapError'; this.code = code; }
}

function requireSafe(condition, code) {
  if (!condition) throw new BootstrapError(code);
}

export function parseExactArgs(args) {
  const flags = ['--gateway', '--env', '--credentials', '--project',
    '--db-container', '--email', '--mode', '--confirm'];
  requireSafe(args.length === flags.length * 2, 'INVALID_ARGUMENTS');
  const got = new Map();
  for (let i = 0; i < args.length; i += 2) {
    requireSafe(flags.includes(args[i]) && !got.has(args[i]), 'INVALID_ARGUMENTS');
    got.set(args[i], args[i + 1]);
  }
  requireSafe(flags.every((flag) => got.has(flag)), 'INVALID_ARGUMENTS');
  for (const [field, value] of Object.entries(BOUNDARY)) {
    const flag = field === 'dbContainer' ? '--db-container' : `--${field}`;
    requireSafe(got.get(flag) === value, 'BOUNDARY_MISMATCH');
  }
  return BOUNDARY;
}

function inspectContainer(name, service) {
  // Docker inspect is read-only. It receives no secrets and its JSON is never
  // written to stdout/stderr (it may include environment values).
  const child = spawnSync('/usr/bin/docker', ['inspect', name], {
    encoding: 'utf8', maxBuffer: 8 * 1024 * 1024,
    env: { PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin' },
  });
  requireSafe(child.status === 0, 'CONTAINER_NOT_FOUND');
  let container;
  try { [container] = JSON.parse(child.stdout); } catch { throw new BootstrapError('CONTAINER_INSPECT_FAILED'); }
  requireSafe(container?.Name === `/${name}` && container.State?.Running === true &&
    container.Config?.Labels?.['com.docker.compose.project'] === BOUNDARY.project &&
    container.Config?.Labels?.['com.docker.compose.service'] === service,
  'CONTAINER_BOUNDARY_MISMATCH');
  return container;
}

function verifyLocalRuntime() {
  requireSafe(process.platform === 'linux' && process.getuid?.() === 0,
    'ROOT_LINUX_REQUIRED');
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

function readPrivateConfig() {
  const file = BOUNDARY.env;
  const stat = lstatSync(file);
  requireSafe(stat.isFile() && !stat.isSymbolicLink() && stat.uid === 0 &&
    (stat.mode & 0o777) === 0o600 && realpathSync(file) === file,
  'PRIVATE_ENV_BOUNDARY_MISMATCH');
  const env = parseEnv(readFileSync(file, 'utf8'));
  for (const [key, value] of Object.entries(EXPECTED_SETTINGS)) {
    requireSafe(env.get(key) === value, 'PRIVATE_ENV_BOUNDARY_MISMATCH');
  }
  requireSafe(!env.has('LOVABLE_API_KEY'), 'PRIVATE_ENV_BOUNDARY_MISMATCH');
  const keys = {
    secret: env.get('SUPABASE_SECRET_KEY'),
    serviceJwt: env.get('SERVICE_ROLE_KEY_ASYMMETRIC'),
    public: env.get('SUPABASE_PUBLISHABLE_KEY'),
  };
  requireSafe(keys.secret?.startsWith('sb_secret_') &&
    keys.public?.startsWith('sb_publishable_') &&
    (keys.serviceJwt?.split('.').length === 3), 'PRIVATE_ENV_BOUNDARY_MISMATCH');
  return keys;
}

function privateCredentialStore(path) {
  const parent = dirname(path);
  const base = dirname(parent);
  const baseStat = lstatSync(base);
  requireSafe(baseStat.isDirectory() && baseStat.uid === 0 &&
    (baseStat.mode & 0o022) === 0 && realpathSync(base) === base,
  'CREDENTIAL_DIRECTORY_UNSAFE');
  if (!existsSync(parent)) mkdirSync(parent, { mode: 0o700 });
  const stat = lstatSync(parent);
  requireSafe(stat.isDirectory() && stat.uid === 0 &&
    (stat.mode & 0o777) === 0o700 && realpathSync(parent) === parent,
  'CREDENTIAL_DIRECTORY_UNSAFE');
  return {
    save(password) {
      // Exclusive create before making the Auth request. Never overwrite an
      // existing credential, even if an earlier run only partially succeeded.
      const fd = openSync(path, 'wx', 0o600);
      try {
        fchmodSync(fd, 0o600);
        writeFileSync(fd, JSON.stringify({ email: BOUNDARY.email, password }) + '\n');
        fsyncSync(fd);
      } catch (error) {
        closeSync(fd);
        unlinkSync(path);
        throw error;
      }
      closeSync(fd);
    },
    remove() { unlinkSync(path); },
  };
}

function assertKeys(keys) {
  requireSafe(keys?.secret?.startsWith('sb_secret_') &&
    keys?.public?.startsWith('sb_publishable_') &&
    typeof keys?.serviceJwt === 'string' && keys.serviceJwt.split('.').length === 3,
  'INVALID_TEST_KEYS');
}

function adminHeaders(keys) {
  return { apikey: keys.secret, Authorization: `Bearer ${keys.serviceJwt}` };
}

async function requestJson(fetchImpl, gateway, method, path, headers, payload, allowedStatuses) {
  let response;
  try {
    response = await fetchImpl(`${gateway}${path}`, {
      method,
      headers: { Accept: 'application/json', ...headers,
        ...(payload === undefined ? {} : { 'Content-Type': 'application/json' }) },
      body: payload === undefined ? undefined : JSON.stringify(payload),
      redirect: 'error',
      signal: AbortSignal.timeout(10_000),
    });
  } catch { throw new BootstrapError('NETWORK_FAILURE'); }
  requireSafe(allowedStatuses.includes(response.status), 'UNEXPECTED_HTTP_STATUS');
  if (response.status === 204) return null;
  const length = Number(response.headers.get('content-length') ?? '0');
  requireSafe(!Number.isFinite(length) || length <= 131_072, 'RESPONSE_TOO_LARGE');
  let body;
  try { body = await response.text(); } catch { throw new BootstrapError('RESPONSE_READ_FAILED'); }
  requireSafe(body.length <= 131_072, 'RESPONSE_TOO_LARGE');
  if (!body) return null;
  try { return JSON.parse(body); } catch { throw new BootstrapError('INVALID_RESPONSE'); }
}

function oneRow(value, id, expectedRole) {
  requireSafe(Array.isArray(value) && value.length === 1 &&
    UUID.test(value[0]?.id ?? '') && value[0].user_id === id &&
    (expectedRole === undefined || value[0].role === expectedRole),
  'PROFILE_OR_ROLE_MISMATCH');
  return value[0];
}

/**
 * Pure workflow with injected HTTP/credential storage for offline tests.
 * This function still rejects a non-loopback gateway and wrong synthetic ID.
 */
export async function bootstrapTestAdmin({ gateway, email, keys, fetchImpl,
  credentialStore, password = randomBytes(36).toString('base64url') }) {
  requireSafe(gateway === BOUNDARY.gateway && email === BOUNDARY.email,
    'BOUNDARY_MISMATCH');
  requireSafe(typeof fetchImpl === 'function' &&
    typeof credentialStore?.save === 'function' &&
    typeof credentialStore?.remove === 'function' &&
    typeof password === 'string' && password.length >= 40,
  'INVALID_DEPENDENCY');
  assertKeys(keys);
  const rootHeaders = adminHeaders(keys);
  const publicHeaders = { apikey: keys.public };
  // Probe the function's unauthenticated gate and the *empty* isolated Auth
  // store before creating a file or user. A nonempty store requires review.
  await requestJson(fetchImpl, gateway, 'POST', '/functions/v1/admin-users',
    publicHeaders, { action: 'list' }, [401]);
  const existing = await requestJson(fetchImpl, gateway, 'GET',
    '/auth/v1/admin/users?page=1&per_page=1000', rootHeaders, undefined, [200]);
  requireSafe(Array.isArray(existing?.users) && existing.users.length === 0 &&
    (existing.total === undefined || existing.total === 0),
  'AUTH_STORE_NOT_EMPTY');

  let createdId = null;
  let attemptedCreate = false;
  let saved = false;
  try {
    credentialStore.save(password);
    saved = true;
    attemptedCreate = true;
    const created = await requestJson(fetchImpl, gateway, 'POST',
      '/auth/v1/admin/users', rootHeaders,
      { email, password, email_confirm: true,
        user_metadata: { display_name: DISPLAY_NAME } }, [200, 201]);
    const user = created?.user ?? created;
    requireSafe(UUID.test(user?.id ?? '') && user.email === email,
      'CREATED_USER_MISMATCH');
    createdId = user.id;

    const confirmed = await requestJson(fetchImpl, gateway, 'GET',
      `/auth/v1/admin/users/${createdId}`, rootHeaders, undefined, [200]);
    const confirmedUser = confirmed?.user ?? confirmed;
    requireSafe(confirmedUser?.id === createdId && confirmedUser.email === email,
      'CREATED_USER_MISMATCH');

    const profilePath = `/rest/v1/profiles?user_id=eq.${createdId}&select=id,user_id,display_name`;
    const rolePath = `/rest/v1/user_roles?user_id=eq.${createdId}&select=id,user_id,role`;
    const profile = oneRow(await requestJson(fetchImpl, gateway, 'GET',
      profilePath, rootHeaders, undefined, [200]), createdId);
    requireSafe(profile.display_name === DISPLAY_NAME, 'PROFILE_OR_ROLE_MISMATCH');
    const viewer = oneRow(await requestJson(fetchImpl, gateway, 'GET',
      rolePath, rootHeaders, undefined, [200]), createdId, 'viewer');

    // The Auth trigger has already inserted viewer. Update *that exact row*;
    // inserting an admin row would leave two roles and break least privilege.
    const promoted = await requestJson(fetchImpl, gateway, 'PATCH',
      `/rest/v1/user_roles?id=eq.${viewer.id}&user_id=eq.${createdId}&role=eq.viewer`,
      { ...rootHeaders, Prefer: 'return=representation' }, { role: 'admin' }, [200]);
    const admin = oneRow(promoted, createdId, 'admin');
    requireSafe(admin.id === viewer.id, 'PROFILE_OR_ROLE_MISMATCH');
    const verifyRole = oneRow(await requestJson(fetchImpl, gateway, 'GET',
      rolePath, rootHeaders, undefined, [200]), createdId, 'admin');
    requireSafe(verifyRole.id === viewer.id, 'PROFILE_OR_ROLE_MISMATCH');

    const session = await requestJson(fetchImpl, gateway, 'POST',
      '/auth/v1/token?grant_type=password',
      { ...publicHeaders, Authorization: `Bearer ${keys.public}` },
      { email, password }, [200]);
    requireSafe(session?.user?.id === createdId && session?.user?.email === email &&
      typeof session.access_token === 'string' && session.access_token.length > 20,
    'LOGIN_VERIFICATION_FAILED');
    const listed = await requestJson(fetchImpl, gateway, 'POST',
      '/functions/v1/admin-users',
      { ...publicHeaders, Authorization: `Bearer ${session.access_token}` },
      { action: 'list' }, [200]);
    requireSafe(Array.isArray(listed?.users) && listed.users.some((entry) =>
      entry.id === createdId && entry.email === email && entry.role === 'admin'),
    'ADMIN_FUNCTION_VERIFICATION_FAILED');
    return { userId: createdId, credentialPath: BOUNDARY.credentials };
  } catch (error) {
    if (createdId) {
      try {
        await requestJson(fetchImpl, gateway, 'DELETE',
          `/auth/v1/admin/users/${createdId}`, rootHeaders, undefined, [200, 204]);
      } catch { throw new BootstrapError('ROLLBACK_REQUIRED'); }
      try { if (saved) credentialStore.remove(); }
      catch { throw new BootstrapError('CREDENTIAL_CLEANUP_REQUIRED'); }
    } else if (saved && !attemptedCreate) {
      try { credentialStore.remove(); }
      catch { throw new BootstrapError('CREDENTIAL_CLEANUP_REQUIRED'); }
    } else if (saved) {
      // A timed-out create may have committed remotely. Keep the private
      // password for an operator to reconcile the exact synthetic account.
      throw new BootstrapError('CREATE_OUTCOME_UNKNOWN');
    }
    throw error instanceof BootstrapError ? error : new BootstrapError('BOOTSTRAP_FAILED');
  }
}

async function main() {
  parseExactArgs(process.argv.slice(2));
  verifyLocalRuntime();
  const keys = readPrivateConfig();
  process.umask(0o077);
  const result = await bootstrapTestAdmin({
    gateway: BOUNDARY.gateway, email: BOUNDARY.email, keys,
    fetchImpl: fetch, credentialStore: privateCredentialStore(BOUNDARY.credentials),
  });
  process.stdout.write(`PASS: isolated synthetic admin ${result.userId}; credentials remain in root-only server file ${result.credentialPath}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    // Never stringify Fetch/Auth/REST response bodies, tokens, or passwords.
    process.stderr.write(`FAIL: ${error instanceof BootstrapError ? error.code : 'BOOTSTRAP_FAILED'}\n`);
    process.exitCode = 1;
  });
}

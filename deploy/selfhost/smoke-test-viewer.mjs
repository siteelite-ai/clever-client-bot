#!/usr/bin/env node
// One-time authorization smoke for the isolated server3 QA Supabase only.
// It creates one synthetic viewer through Auth Admin and deletes that exact
// verified UUID before returning. Never point this at a public gateway.
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  closeSync, fchmodSync, fsyncSync, lstatSync, openSync, readFileSync,
  realpathSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EXPECTED_SETTINGS, parseEnv } from './validate-compose.mjs';

export const BOUNDARY = Object.freeze({
  gateway: 'http://127.0.0.1:18081',
  env: '/var/lib/volt220-test-supabase/upstream/docker/.env',
  journal: '/var/lib/volt220-test-supabase/private/qa-viewer-smoke-20261014.json',
  adminCredentials: '/var/lib/volt220-test-supabase/private/qa-admin-20261014.json',
  project: 'volt220test',
  dbContainer: 'volt220test-db',
  adminEmail: 'qa-admin-20261014@volt220.test',
  viewerEmail: 'qa-viewer-20261014@volt220.test',
  mode: 'selfhost-test',
  confirm: 'probe-isolated-viewer-and-delete',
});

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PROTECTED_TABLES = Object.freeze([
  { name: 'app_settings', column: 'id', seeded: true },
  { name: 'knowledge_entries', column: 'id' },
  { name: 'knowledge_chunks', column: 'id' },
  { name: 'ai_usage_logs', column: 'id' },
  { name: 'chat_request_logs', column: 'id' },
  { name: 'classifier_evals', column: 'id' },
  { name: 'classifier_eval_runs', column: 'id' },
  { name: 'classifier_cache', column: 'query_hash' },
  { name: 'chat_cache_v2', column: 'cache_key' },
  { name: 'chat_v3_admission_buckets', column: 'mode', seeded: true },
  { name: 'chat_v3_admission_decisions', column: 'log_id' },
]);

export class SmokeError extends Error {
  constructor(code) { super(code); this.name = 'SmokeError'; this.code = code; }
}

function requireSafe(condition, code) {
  if (!condition) throw new SmokeError(code);
}

export function parseExactArgs(args) {
  const flags = ['--gateway', '--env', '--journal', '--admin-credentials', '--project', '--db-container',
    '--admin-email', '--viewer-email', '--mode', '--confirm'];
  requireSafe(args.length === flags.length * 2, 'INVALID_ARGUMENTS');
  const got = new Map();
  for (let i = 0; i < args.length; i += 2) {
    requireSafe(flags.includes(args[i]) && !got.has(args[i]), 'INVALID_ARGUMENTS');
    got.set(args[i], args[i + 1]);
  }
  requireSafe(flags.every((flag) => got.has(flag)), 'INVALID_ARGUMENTS');
  for (const [field, value] of Object.entries(BOUNDARY)) {
    const flag = `--${field.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}`;
    requireSafe(got.get(flag) === value, 'BOUNDARY_MISMATCH');
  }
  return BOUNDARY;
}

function inspectContainer(name, service) {
  // Docker inspect may include secrets. Neither its stdout nor stderr is shown.
  const child = spawnSync('/usr/bin/docker', ['inspect', name], {
    encoding: 'utf8', maxBuffer: 8 * 1024 * 1024,
    env: { PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin' },
  });
  requireSafe(child.status === 0, 'CONTAINER_NOT_FOUND');
  let container;
  try { [container] = JSON.parse(child.stdout); }
  catch { throw new SmokeError('CONTAINER_INSPECT_FAILED'); }
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
  assertKeys(keys);
  return keys;
}

function privateJournalStore(path) {
  const parent = dirname(path);
  const base = dirname(parent);
  const baseStat = lstatSync(base);
  const parentStat = lstatSync(parent);
  requireSafe(baseStat.isDirectory() && baseStat.uid === 0 &&
    (baseStat.mode & 0o022) === 0 && realpathSync(base) === base &&
    parentStat.isDirectory() && parentStat.uid === 0 &&
    (parentStat.mode & 0o777) === 0o700 && realpathSync(parent) === parent,
  'JOURNAL_DIRECTORY_UNSAFE');
  return {
    save({ email, nonce }) {
      let fd;
      try { fd = openSync(path, 'wx', 0o600); }
      catch (error) {
        throw new SmokeError(error?.code === 'EEXIST' ? 'PENDING_JOURNAL' : 'JOURNAL_WRITE_FAILED');
      }
      try {
        fchmodSync(fd, 0o600);
        writeFileSync(fd, JSON.stringify({ version: 1, email, nonce }) + '\n');
        fsyncSync(fd);
      } catch {
        closeSync(fd);
        // No Auth create has yet been attempted; a partial journal is safe to
        // remove. If the process was killed, the file instead remains visible.
        try { unlinkSync(path); } catch { /* operator will reconcile */ }
        throw new SmokeError('JOURNAL_WRITE_FAILED');
      }
      closeSync(fd);
    },
    remove() { unlinkSync(path); },
  };
}

function readAdminCredentials() {
  const file = BOUNDARY.adminCredentials;
  const stat = lstatSync(file);
  const parent = dirname(file);
  const parentStat = lstatSync(parent);
  requireSafe(stat.isFile() && !stat.isSymbolicLink() && stat.uid === 0 &&
    (stat.mode & 0o777) === 0o600 && stat.size <= 4096 &&
    realpathSync(file) === file && parentStat.isDirectory() &&
    parentStat.uid === 0 && (parentStat.mode & 0o777) === 0o700 &&
    realpathSync(parent) === parent,
  'ADMIN_CREDENTIAL_BOUNDARY_MISMATCH');
  let value;
  try { value = JSON.parse(readFileSync(file, 'utf8')); }
  catch { throw new SmokeError('ADMIN_CREDENTIAL_BOUNDARY_MISMATCH'); }
  requireSafe(value?.email === BOUNDARY.adminEmail &&
    typeof value?.password === 'string' && value.password.length >= 40,
  'ADMIN_CREDENTIAL_BOUNDARY_MISMATCH');
  return { email: value.email, password: value.password };
}

function assertKeys(keys) {
  requireSafe(keys?.secret?.startsWith('sb_secret_') &&
    keys?.public?.startsWith('sb_publishable_') &&
    typeof keys?.serviceJwt === 'string' && keys.serviceJwt.split('.').length === 3,
  'INVALID_TEST_KEYS');
}

function rootHeaders(keys) {
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
  } catch { throw new SmokeError('NETWORK_FAILURE'); }
  requireSafe(allowedStatuses.includes(response.status), 'UNEXPECTED_HTTP_STATUS');
  if (response.status === 204) return { status: 204, value: null };
  const length = Number(response.headers.get('content-length') ?? '0');
  requireSafe(!Number.isFinite(length) || length <= 131_072, 'RESPONSE_TOO_LARGE');
  let body;
  try { body = await response.text(); } catch { throw new SmokeError('RESPONSE_READ_FAILED'); }
  requireSafe(body.length <= 131_072, 'RESPONSE_TOO_LARGE');
  if (!body) return { status: response.status, value: null };
  try { return { status: response.status, value: JSON.parse(body) }; }
  catch { throw new SmokeError('INVALID_RESPONSE'); }
}

function authUser(payload) { return payload?.user ?? payload; }

function oneRow(value, userId, role) {
  requireSafe(Array.isArray(value) && value.length === 1 &&
    UUID.test(value[0]?.id ?? '') && value[0].user_id === userId &&
    (role === undefined || value[0].role === role), 'ROLE_OR_PROFILE_MISMATCH');
  return value[0];
}

async function listAuth(fetchImpl, root) {
  const { value } = await requestJson(fetchImpl, 'GET',
    '/auth/v1/admin/users?page=1&per_page=1000', root, undefined, [200]);
  requireSafe(Array.isArray(value?.users) && value.users.length <= 1000 &&
    (value.total === undefined || value.total === value.users.length),
  'AUTH_STORE_MISMATCH');
  return value.users;
}

function verifiedIdentity(user, email, nonce) {
  return UUID.test(user?.id ?? '') && user.email === email &&
    user.user_metadata?.smoke_nonce === nonce;
}

async function resolveCreatedViewer(fetchImpl, root, nonce) {
  try {
    const users = await listAuth(fetchImpl, root);
    const matches = users.filter((user) =>
      verifiedIdentity(user, BOUNDARY.viewerEmail, nonce));
    // Ambiguous, missing, or a changed Auth store is for manual reconciliation.
    return users.length === 2 && matches.length === 1 &&
      users.some((user) => user.email === BOUNDARY.adminEmail) ? matches[0].id : null;
  } catch { return null; }
}

async function verifyDeletion(fetchImpl, root, id) {
  const users = await listAuth(fetchImpl, root);
  requireSafe(users.length === 1 && users[0].email === BOUNDARY.adminEmail &&
    !users.some((user) => user.id === id || user.email === BOUNDARY.viewerEmail),
  'ROLLBACK_REQUIRED');
  for (const table of ['profiles', 'user_roles']) {
    const { value } = await requestJson(fetchImpl, 'GET',
      `/rest/v1/${table}?user_id=eq.${id}&select=id`, root, undefined, [200]);
    requireSafe(Array.isArray(value) && value.length === 0, 'ROLLBACK_REQUIRED');
  }
}

async function assertViewerDenied(fetchImpl, headers, method, path, payload) {
  const { status, value } = await requestJson(fetchImpl, method, path,
    headers, payload, [200, 403]);
  requireSafe(status === 403 || (Array.isArray(value) && value.length === 0),
    'ACCESS_BOUNDARY_FAILED');
  return status;
}

/**
 * Injectable workflow for offline tests. Only the fixed loopback gateway and
 * fixed synthetic identities are reachable; no remote imports or AI actions.
 */
export async function smokeTestViewer({ gateway, keys, adminCredentials,
  fetchImpl, journalStore,
  nonce = randomBytes(24).toString('hex'),
  password = randomBytes(36).toString('base64url') }) {
  requireSafe(gateway === BOUNDARY.gateway, 'BOUNDARY_MISMATCH');
  requireSafe(typeof fetchImpl === 'function' &&
    typeof journalStore?.save === 'function' &&
    typeof journalStore?.remove === 'function' &&
    adminCredentials?.email === BOUNDARY.adminEmail &&
    typeof adminCredentials?.password === 'string' &&
    adminCredentials.password.length >= 40 &&
    typeof nonce === 'string' && /^[0-9a-f]{48}$/i.test(nonce) &&
    typeof password === 'string' && password.length >= 40,
  'INVALID_DEPENDENCY');
  assertKeys(keys);

  const root = rootHeaders(keys);
  const publicHeaders = { apikey: keys.public };
  const existing = await listAuth(fetchImpl, root);
  requireSafe(existing.length === 1 && existing[0].email === BOUNDARY.adminEmail &&
    UUID.test(existing[0].id), 'AUTH_STORE_MISMATCH');
  const adminId = existing[0].id;
  for (const [table, role] of [['user_roles', 'admin'], ['profiles', undefined]]) {
    const { value } = await requestJson(fetchImpl, 'GET',
      `/rest/v1/${table}?user_id=eq.${adminId}&select=id,user_id${role ? ',role' : ''}`,
      root, undefined, [200]);
    oneRow(value, adminId, role);
  }

  const rootTableHasRow = new Map();
  for (const table of PROTECTED_TABLES) {
    const { value } = await requestJson(fetchImpl, 'GET',
      `/rest/v1/${table.name}?select=${table.column}&limit=1`, root, undefined, [200]);
    requireSafe(Array.isArray(value) && value.length <= 1,
      'PROTECTED_TABLE_PREFLIGHT_FAILED');
    requireSafe(!table.seeded || value.length === 1, 'SEEDED_CONTROL_MISSING');
    rootTableHasRow.set(table.name, value.length === 1);
  }
  // A successful knowledge list schedules background self-healing of orphan
  // entries. On a non-empty KB that could invoke a paid embedding API. Refuse
  // this positive control unless the isolated KB is empty.
  requireSafe(!rootTableHasRow.get('knowledge_entries'), 'KNOWLEDGE_NOT_EMPTY');
  const { value: adminSession } = await requestJson(fetchImpl, 'POST',
    '/auth/v1/token?grant_type=password',
    { ...publicHeaders, Authorization: `Bearer ${keys.public}` },
    adminCredentials, [200]);
  requireSafe(adminSession?.user?.id === adminId &&
    adminSession?.user?.email === BOUNDARY.adminEmail &&
    typeof adminSession.access_token === 'string' &&
    adminSession.access_token.length > 20, 'ADMIN_LOGIN_FAILED');
  const { value: knowledgeList } = await requestJson(fetchImpl, 'POST',
    '/functions/v1/knowledge-process',
    { ...publicHeaders, Authorization: `Bearer ${adminSession.access_token}` },
    { action: 'list' }, [200]);
  requireSafe(knowledgeList?.success === true &&
    Array.isArray(knowledgeList.entries) && knowledgeList.entries.length === 0 &&
    knowledgeList.totalEntries === 0, 'ADMIN_KNOWLEDGE_FAILED');

  let journalSaved = false;
  let createAttempted = false;
  let confirmedId = null;
  let primaryError = null;
  try {
    journalStore.save({ email: BOUNDARY.viewerEmail, nonce });
    journalSaved = true;
    createAttempted = true;
    const { value: created } = await requestJson(fetchImpl, 'POST',
      '/auth/v1/admin/users', root,
      { email: BOUNDARY.viewerEmail, password, email_confirm: true,
        user_metadata: { display_name: 'Test QA Viewer (isolated)', smoke_nonce: nonce } },
      [200, 201]);
    const returned = authUser(created);
    requireSafe(verifiedIdentity(returned, BOUNDARY.viewerEmail, nonce),
      'CREATE_OUTCOME_UNKNOWN');
    const { value: confirmation } = await requestJson(fetchImpl, 'GET',
      `/auth/v1/admin/users/${returned.id}`, root, undefined, [200]);
    requireSafe(verifiedIdentity(authUser(confirmation), BOUNDARY.viewerEmail, nonce) &&
      authUser(confirmation).id === returned.id, 'CREATE_OUTCOME_UNKNOWN');
    confirmedId = returned.id;

    const { value: roles } = await requestJson(fetchImpl, 'GET',
      `/rest/v1/user_roles?user_id=eq.${confirmedId}&select=id,user_id,role`,
      root, undefined, [200]);
    oneRow(roles, confirmedId, 'viewer');
    const { value: profiles } = await requestJson(fetchImpl, 'GET',
      `/rest/v1/profiles?user_id=eq.${confirmedId}&select=id,user_id`,
      root, undefined, [200]);
    oneRow(profiles, confirmedId);

    const { value: session } = await requestJson(fetchImpl, 'POST',
      '/auth/v1/token?grant_type=password',
      { ...publicHeaders, Authorization: `Bearer ${keys.public}` },
      { email: BOUNDARY.viewerEmail, password }, [200]);
    requireSafe(session?.user?.id === confirmedId &&
      session?.user?.email === BOUNDARY.viewerEmail &&
      typeof session.access_token === 'string' && session.access_token.length > 20,
    'VIEWER_LOGIN_FAILED');
    const viewer = { ...publicHeaders, Authorization: `Bearer ${session.access_token}` };

    // Both function gates must reject this *valid* signed-in viewer before
    // any service-role work. The knowledge list request is denied before its
    // self-healing branch, so this smoke makes no paid embedding calls.
    for (const path of ['/functions/v1/admin-users', '/functions/v1/knowledge-process']) {
      const { status } = await requestJson(fetchImpl, 'POST', path,
        viewer, { action: 'list' }, [403]);
      requireSafe(status === 403, 'ACCESS_BOUNDARY_FAILED');
    }

    for (const [table, role] of [['profiles', undefined], ['user_roles', 'viewer']]) {
      const columns = `id,user_id${role ? ',role' : ''}`;
      const { value: own } = await requestJson(fetchImpl, 'GET',
        `/rest/v1/${table}?user_id=eq.${confirmedId}&select=${columns}`,
        viewer, undefined, [200]);
      oneRow(own, confirmedId, role);
      await assertViewerDenied(fetchImpl, viewer, 'GET',
        `/rest/v1/${table}?user_id=eq.${adminId}&select=${columns}`);
    }

    const visibleControls = [];
    const emptyControls = [];
    for (const table of PROTECTED_TABLES) {
      await assertViewerDenied(fetchImpl, viewer, 'GET',
        `/rest/v1/${table.name}?select=${table.column}&limit=1`);
      (rootTableHasRow.get(table.name) ? visibleControls : emptyControls).push(table.name);
    }

    const { status: ownRoleStatus, value: ownRole } = await requestJson(fetchImpl,
      'POST', '/rest/v1/rpc/has_role', viewer,
      { _user_id: confirmedId, _role: 'viewer' }, [200]);
    requireSafe(ownRoleStatus === 200 && ownRole === true, 'ROLE_LOOKUP_FAILED');
    const { status: foreignRoleStatus, value: foreignRole } = await requestJson(fetchImpl,
      'POST', '/rest/v1/rpc/has_role', viewer,
      { _user_id: adminId, _role: 'admin' }, [200]);
    requireSafe(foreignRoleStatus === 200 && foreignRole === false, 'ROLE_LOOKUP_FAILED');

    return { userId: confirmedId, provenTables: visibleControls,
      emptyTableProbes: emptyControls };
  } catch (error) {
    primaryError = error instanceof SmokeError ? error : new SmokeError('SMOKE_FAILED');
  } finally {
    if (journalSaved && createAttempted && !confirmedId) {
      confirmedId = await resolveCreatedViewer(fetchImpl, root, nonce);
      if (!confirmedId) primaryError = new SmokeError('CREATE_OUTCOME_UNKNOWN');
      else primaryError = new SmokeError('CREATE_OUTCOME_RECONCILED');
    }
    if (confirmedId) {
      try {
        // A timed-out delete may have committed. Verify exact absence even if
        // the HTTP response was lost, never delete a different UUID.
        try {
          await requestJson(fetchImpl, 'DELETE',
            `/auth/v1/admin/users/${confirmedId}`, root, undefined, [200, 204]);
        } catch { /* verify exact postcondition below */ }
        await verifyDeletion(fetchImpl, root, confirmedId);
      } catch {
        throw new SmokeError('ROLLBACK_REQUIRED');
      }
      try { journalStore.remove(); }
      catch { throw new SmokeError('JOURNAL_CLEANUP_REQUIRED'); }
    }
  }
  throw primaryError ?? new SmokeError('SMOKE_FAILED');
}

async function main() {
  parseExactArgs(process.argv.slice(2));
  verifyLocalRuntime();
  const keys = readPrivateConfig();
  const adminCredentials = readAdminCredentials();
  process.umask(0o077);
  const result = await smokeTestViewer({
    gateway: BOUNDARY.gateway, keys, adminCredentials, fetchImpl: fetch,
    journalStore: privateJournalStore(BOUNDARY.journal),
  });
  process.stdout.write(`PASS: isolated viewer ${result.userId} denied admin access and was deleted; non-empty protected controls: ${result.provenTables.join(', ')}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    // Never print Fetch/Auth/REST bodies, keys, tokens, passwords, or nonce.
    process.stderr.write(`FAIL: ${error instanceof SmokeError ? error.code : 'SMOKE_FAILED'}\n`);
    process.exitCode = 1;
  });
}

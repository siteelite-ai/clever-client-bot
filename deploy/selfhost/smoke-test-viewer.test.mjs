import assert from 'node:assert/strict';
import test from 'node:test';
import {
  BOUNDARY, SmokeError, parseExactArgs, smokeTestViewer,
} from './smoke-test-viewer.mjs';

const ADMIN_ID = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const VIEWER_ID = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb';
const ADMIN_PROFILE_ID = 'cccccccc-3333-4333-8333-cccccccccccc';
const VIEWER_PROFILE_ID = 'dddddddd-4444-4444-8444-dddddddddddd';
const ADMIN_ROLE_ID = 'eeeeeeee-5555-4555-8555-eeeeeeeeeeee';
const VIEWER_ROLE_ID = 'ffffffff-6666-4666-8666-ffffffffffff';
const ADMIN_TOKEN = 'test-admin-access-token-123456789';
const VIEWER_TOKEN = 'test-viewer-access-token-123456789';
const NONCE = 'c'.repeat(48);
const PASSWORD = 'D'.repeat(48);
const KEYS = {
  secret: 'sb_secret_test_123',
  serviceJwt: 'header.body.signature',
  public: 'sb_publishable_test_123',
};
const ADMIN_CREDENTIALS = {
  email: BOUNDARY.adminEmail,
  password: 'A'.repeat(48),
};

function response(status, value) {
  return new Response(value === null ? null : JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function makeHarness({ adminUsers, reconcileUsers, viewerAdminStatus = 403,
  viewerKnowledgeStatus = 403, createFailure = false, deleteStatus = 204,
  knowledgeEntriesHasRow = false } = {}) {
  const calls = [];
  const saved = [];
  let removed = 0;
  let created = false;
  let deleted = false;
  const admin = { id: ADMIN_ID, email: BOUNDARY.adminEmail };
  const viewer = {
    id: VIEWER_ID, email: BOUNDARY.viewerEmail,
    user_metadata: { smoke_nonce: NONCE, display_name: 'Test QA Viewer (isolated)' },
  };
  const adminProfile = {
    id: ADMIN_PROFILE_ID, user_id: ADMIN_ID,
    display_name: 'Test QA Admin (isolated)',
  };
  const viewerProfile = {
    id: VIEWER_PROFILE_ID, user_id: VIEWER_ID,
    display_name: 'Test QA Viewer (isolated)',
  };
  const adminRole = { id: ADMIN_ROLE_ID, user_id: ADMIN_ID, role: 'admin' };
  const viewerRole = { id: VIEWER_ROLE_ID, user_id: VIEWER_ID, role: 'viewer' };
  return {
    calls,
    saved,
    get removed() { return removed; },
    get created() { return created; },
    get deleted() { return deleted; },
    journalStore: {
      save(value) { saved.push(value); },
      remove() { removed += 1; },
    },
    async fetchImpl(url, options) {
      assert.ok(url.startsWith(`${BOUNDARY.gateway}/`), 'only loopback gateway is allowed');
      assert.equal(options.redirect, 'error');
      const parsed = new URL(url);
      const path = parsed.pathname;
      const { method } = options;
      const bearer = options.headers?.Authorization;
      const asViewer = bearer === `Bearer ${VIEWER_TOKEN}`;
      const call = { url, method, path, bearer, body: options.body };
      calls.push(call);

      if (method === 'GET' && path === '/auth/v1/admin/users') {
        const users = adminUsers ?? (createFailure && created && reconcileUsers
          ? reconcileUsers : [admin, ...(created && !deleted ? [viewer] : [])]);
        return response(200, { users, total: users.length });
      }
      if (method === 'POST' && path === '/auth/v1/admin/users') {
        created = true;
        if (createFailure) throw new Error('simulated connection loss after create');
        return response(201, viewer);
      }
      if (path === `/auth/v1/admin/users/${VIEWER_ID}` && method === 'GET') {
        return deleted ? response(404, { message: 'not found' }) : response(200, viewer);
      }
      if (path === `/auth/v1/admin/users/${VIEWER_ID}` && method === 'DELETE') {
        if (deleteStatus === 204) deleted = true;
        return response(deleteStatus, deleteStatus === 204 ? null : { message: 'denied' });
      }
      if (method === 'POST' && path === '/auth/v1/token') {
        const isAdmin = JSON.parse(options.body).email === BOUNDARY.adminEmail;
        return response(200, {
          user: isAdmin ? admin : viewer,
          access_token: isAdmin ? ADMIN_TOKEN : VIEWER_TOKEN,
        });
      }
      if (method === 'GET' && path === '/rest/v1/profiles') {
        const filter = parsed.searchParams.get('user_id');
        if (filter === `eq.${ADMIN_ID}`) {
          return response(200, asViewer ? [] : [adminProfile]);
        }
        if (filter === `eq.${VIEWER_ID}`) {
          return response(200, deleted ? [] : [viewerProfile]);
        }
      }
      if (method === 'GET' && path === '/rest/v1/user_roles') {
        const filter = parsed.searchParams.get('user_id');
        if (filter === `eq.${ADMIN_ID}`) {
          return response(200, asViewer ? [] : [adminRole]);
        }
        if (filter === `eq.${VIEWER_ID}`) {
          return response(200, deleted ? [] : [viewerRole]);
        }
      }
      if (method === 'POST' && path === '/rest/v1/rpc/has_role') {
        const query = JSON.parse(options.body);
        return response(200, query._user_id === VIEWER_ID && query._role === 'viewer');
      }
      if (method === 'POST' && path === '/functions/v1/admin-users') {
        return response(asViewer ? viewerAdminStatus : 401,
          { error: asViewer ? 'Forbidden' : 'Unauthorized' });
      }
      if (method === 'POST' && path === '/functions/v1/knowledge-process') {
        if (bearer === `Bearer ${ADMIN_TOKEN}`) {
          return response(200, { success: true, entries: [], totalEntries: 0 });
        }
        return response(asViewer ? viewerKnowledgeStatus : 401,
          { error: asViewer ? 'Forbidden' : 'Unauthorized' });
      }
      if (method === 'GET' && path.startsWith('/rest/v1/')) {
        const table = path.slice('/rest/v1/'.length);
        const seeded = ['app_settings', 'chat_v3_admission_buckets'].includes(table) ||
          (knowledgeEntriesHasRow && table === 'knowledge_entries');
        return response(200, asViewer || !seeded ? [] : [{ id: ADMIN_PROFILE_ID,
          mode: 'off' }]);
      }
      assert.fail(`unexpected mocked request ${method} ${path}`);
    },
  };
}

function workflow(h) {
  return smokeTestViewer({
    gateway: BOUNDARY.gateway, keys: KEYS, adminCredentials: ADMIN_CREDENTIALS,
    fetchImpl: h.fetchImpl, journalStore: h.journalStore,
    nonce: NONCE, password: PASSWORD,
  });
}

function exactArgs() {
  return Object.entries(BOUNDARY).flatMap(([name, value]) => [
    `--${name.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}`, value,
  ]);
}

test('requires the exact isolated loopback boundary, without duplicate or extra flags', () => {
  assert.equal(parseExactArgs(exactArgs()), BOUNDARY);
  for (const changed of [
    exactArgs().map((value) => value === BOUNDARY.gateway
      ? 'https://api-volt-next.testdevops.ru' : value),
    exactArgs().map((value) => value === BOUNDARY.env ? '/tmp/.env' : value),
    exactArgs().map((value) => value === BOUNDARY.journal ? '/tmp/journal.json' : value),
    exactArgs().map((value) => value === BOUNDARY.adminCredentials
      ? '/tmp/admin.json' : value),
    exactArgs().map((value) => value === BOUNDARY.project ? 'production' : value),
    exactArgs().map((value) => value === BOUNDARY.dbContainer ? 'db' : value),
    exactArgs().map((value) => value === BOUNDARY.adminEmail ? 'admin@example.com' : value),
    exactArgs().map((value) => value === BOUNDARY.viewerEmail ? 'viewer@example.com' : value),
    exactArgs().map((value) => value === BOUNDARY.mode ? 'production' : value),
    exactArgs().map((value) => value === BOUNDARY.confirm ? 'yes' : value),
    exactArgs().slice(0, -2),
    [...exactArgs(), '--mode', BOUNDARY.mode],
    [...exactArgs(), '--unexpected', 'value'],
  ]) {
    assert.throws(() => parseExactArgs(changed), SmokeError);
  }
});

test('a wrong gateway fails before using HTTP or the journal', async () => {
  let calls = 0;
  let saves = 0;
  await assert.rejects(() => smokeTestViewer({
    gateway: 'https://api-volt-next.testdevops.ru',
    keys: KEYS, adminCredentials: ADMIN_CREDENTIALS,
    fetchImpl() { calls += 1; throw new Error('network must not be used'); },
    journalStore: {
      save() { saves += 1; },
      remove() { throw new Error('journal must not be used'); },
    },
    nonce: NONCE,
    password: PASSWORD,
  }), { code: 'BOUNDARY_MISMATCH' });
  assert.equal(calls, 0);
  assert.equal(saves, 0);
});

test('viewer probe denies staff functions and protected reads, then deletes only its UUID', async () => {
  const h = makeHarness();
  const result = await workflow(h);
  assert.equal(result.userId, VIEWER_ID);
  assert.equal(h.created, true);
  assert.equal(h.deleted, true);
  assert.deepEqual(h.saved, [{ email: BOUNDARY.viewerEmail, nonce: NONCE }]);
  assert.equal(h.removed, 1);
  assert.deepEqual(h.calls.filter((call) => call.method === 'DELETE').map((call) => call.path),
    [`/auth/v1/admin/users/${VIEWER_ID}`]);
  for (const path of ['/functions/v1/admin-users', '/functions/v1/knowledge-process']) {
    assert.ok(h.calls.some((call) => call.path === path &&
      call.bearer === `Bearer ${VIEWER_TOKEN}`), `${path} was probed as viewer`);
  }
  assert.ok(h.calls.some((call) => call.path === '/functions/v1/knowledge-process' &&
    call.bearer === `Bearer ${ADMIN_TOKEN}`),
  'known admin must pass the knowledge-process list positive control');
  assert.ok(h.calls.some((call) => call.path === '/rest/v1/rpc/has_role' &&
    JSON.parse(call.body)._user_id === ADMIN_ID),
  'viewer must probe another user through has_role');
  assert.ok(h.calls.some((call) => call.path === '/rest/v1/app_settings' &&
    call.bearer === `Bearer ${VIEWER_TOKEN}`),
  'viewer must probe a protected table');
});

test('unexpected Auth population fails before creating or journaling a viewer', async () => {
  const h = makeHarness({ adminUsers: [
    { id: ADMIN_ID, email: BOUNDARY.adminEmail },
    { id: VIEWER_ID, email: BOUNDARY.viewerEmail },
  ] });
  await assert.rejects(() => workflow(h), { code: 'AUTH_STORE_MISMATCH' });
  assert.equal(h.created, false);
  assert.deepEqual(h.saved, []);
  assert.equal(h.calls.some((call) => call.method === 'DELETE'), false);
});

test('nonempty knowledge base stops before its positive-control function call', async () => {
  const h = makeHarness({ knowledgeEntriesHasRow: true });
  await assert.rejects(() => workflow(h), { code: 'KNOWLEDGE_NOT_EMPTY' });
  assert.equal(h.created, false);
  assert.deepEqual(h.saved, []);
  assert.equal(h.calls.some((call) => call.path === '/functions/v1/knowledge-process'), false);
});

test('an admin-users 200 response for viewer fails closed and cleans exact UUID', async () => {
  const h = makeHarness({ viewerAdminStatus: 200 });
  await assert.rejects(() => workflow(h), { code: 'UNEXPECTED_HTTP_STATUS' });
  assert.equal(h.deleted, true);
  assert.equal(h.removed, 1);
  assert.deepEqual(h.calls.filter((call) => call.method === 'DELETE').map((call) => call.path),
    [`/auth/v1/admin/users/${VIEWER_ID}`]);
});

test('a knowledge-process 200 response for viewer fails closed and cleans exact UUID', async () => {
  const h = makeHarness({ viewerKnowledgeStatus: 200 });
  await assert.rejects(() => workflow(h), { code: 'UNEXPECTED_HTTP_STATUS' });
  assert.equal(h.deleted, true);
  assert.equal(h.removed, 1);
});

test('unknown create result cannot guess a UUID or discard the journal', async () => {
  const h = makeHarness({ createFailure: true,
    reconcileUsers: [{ id: ADMIN_ID, email: BOUNDARY.adminEmail }] });
  await assert.rejects(() => workflow(h), { code: 'CREATE_OUTCOME_UNKNOWN' });
  assert.equal(h.created, true);
  assert.equal(h.deleted, false);
  assert.deepEqual(h.saved, [{ email: BOUNDARY.viewerEmail, nonce: NONCE }]);
  assert.equal(h.removed, 0);
  assert.equal(h.calls.some((call) => call.method === 'DELETE'), false);
});

test('timed-out create with one exact nonce match cleans only that UUID', async () => {
  const h = makeHarness({ createFailure: true });
  await assert.rejects(() => workflow(h), { code: 'CREATE_OUTCOME_RECONCILED' });
  assert.equal(h.deleted, true);
  assert.equal(h.removed, 1);
  assert.deepEqual(h.calls.filter((call) => call.method === 'DELETE').map((call) => call.path),
    [`/auth/v1/admin/users/${VIEWER_ID}`]);
});

test('failed exact-UUID cleanup retains journal for manual reconciliation', async () => {
  const h = makeHarness({ deleteStatus: 500 });
  await assert.rejects(() => workflow(h), { code: 'ROLLBACK_REQUIRED' });
  assert.equal(h.deleted, false);
  assert.equal(h.removed, 0);
  assert.deepEqual(h.calls.filter((call) => call.method === 'DELETE').map((call) => call.path),
    [`/auth/v1/admin/users/${VIEWER_ID}`]);
});

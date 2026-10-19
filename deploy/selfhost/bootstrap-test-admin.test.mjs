import assert from 'node:assert/strict';
import test from 'node:test';
import {
  BOUNDARY, BootstrapError, bootstrapTestAdmin, parseExactArgs,
} from './bootstrap-test-admin.mjs';

const ID = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const PROFILE_ID = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb';
const ROLE_ID = 'cccccccc-3333-4333-8333-cccccccccccc';
const TOKEN = 'test-user-access-token-123456789';
const KEYS = {
  secret: 'sb_secret_test_123',
  serviceJwt: 'header.body.signature',
  public: 'sb_publishable_test_123',
};
const PASSWORD = 'A'.repeat(48);

function response(status, value) {
  return new Response(value === null ? null : JSON.stringify(value), {
    status, headers: { 'Content-Type': 'application/json' },
  });
}

function defaultSteps() {
  return [
    { method: 'POST', path: '/functions/v1/admin-users', status: 401,
      value: { error: 'Unauthorized' } },
    { method: 'GET', path: '/auth/v1/admin/users?page=1&per_page=1000',
      status: 200, value: { users: [], total: 0 } },
    { method: 'POST', path: '/auth/v1/admin/users', status: 201,
      value: { id: ID, email: BOUNDARY.email } },
    { method: 'GET', path: `/auth/v1/admin/users/${ID}`, status: 200,
      value: { id: ID, email: BOUNDARY.email } },
    { method: 'GET', path: `/rest/v1/profiles?user_id=eq.${ID}&select=id,user_id,display_name`,
      status: 200, value: [{ id: PROFILE_ID, user_id: ID,
        display_name: 'Test QA Admin (isolated)' }] },
    { method: 'GET', path: `/rest/v1/user_roles?user_id=eq.${ID}&select=id,user_id,role`,
      status: 200, value: [{ id: ROLE_ID, user_id: ID, role: 'viewer' }] },
    { method: 'PATCH', path: `/rest/v1/user_roles?id=eq.${ROLE_ID}&user_id=eq.${ID}&role=eq.viewer`,
      status: 200, value: [{ id: ROLE_ID, user_id: ID, role: 'admin' }] },
    { method: 'GET', path: `/rest/v1/user_roles?user_id=eq.${ID}&select=id,user_id,role`,
      status: 200, value: [{ id: ROLE_ID, user_id: ID, role: 'admin' }] },
    { method: 'POST', path: '/auth/v1/token?grant_type=password', status: 200,
      value: { user: { id: ID, email: BOUNDARY.email }, access_token: TOKEN } },
    { method: 'POST', path: '/functions/v1/admin-users', status: 200,
      value: { users: [{ id: ID, email: BOUNDARY.email, role: 'admin' }] } },
  ];
}

function harness(steps = defaultSteps()) {
  const calls = [];
  const saved = [];
  let removed = 0;
  let cursor = 0;
  return {
    calls, saved,
    get removed() { return removed; },
    get cursor() { return cursor; },
    store: { save(value) { saved.push(value); }, remove() { removed += 1; } },
    async fetchImpl(url, options) {
      const next = steps[cursor++];
      assert.ok(next, 'unexpected network call');
      assert.equal(url, BOUNDARY.gateway + next.path);
      assert.equal(options.method, next.method);
      assert.equal(options.redirect, 'error');
      calls.push({ url, ...options });
      return response(next.status, next.value);
    },
  };
}

function args() {
  return [
    '--gateway', BOUNDARY.gateway, '--env', BOUNDARY.env,
    '--credentials', BOUNDARY.credentials, '--project', BOUNDARY.project,
    '--db-container', BOUNDARY.dbContainer, '--email', BOUNDARY.email,
    '--mode', BOUNDARY.mode, '--confirm', BOUNDARY.confirm,
  ];
}

test('requires every exact isolation argument and rejects duplicates or extras', () => {
  assert.equal(parseExactArgs(args()), BOUNDARY);
  for (const changed of [
    args().map((v) => v === BOUNDARY.gateway ? 'https://api-volt-next.testdevops.ru' : v),
    args().map((v) => v === BOUNDARY.env ? '/tmp/.env' : v),
    args().map((v) => v === BOUNDARY.project ? 'production' : v),
    args().map((v) => v === BOUNDARY.dbContainer ? 'db' : v),
    args().map((v) => v === BOUNDARY.email ? 'client@example.com' : v),
    args().slice(0, -2),
    [...args(), '--mode', BOUNDARY.mode],
  ]) {
    assert.throws(() => parseExactArgs(changed), BootstrapError);
  }
});

test('preflights empty Auth and unauthenticated gate, updates one viewer row, verifies login', async () => {
  const h = harness();
  const result = await bootstrapTestAdmin({
    gateway: BOUNDARY.gateway, email: BOUNDARY.email, keys: KEYS,
    fetchImpl: h.fetchImpl, credentialStore: h.store, password: PASSWORD,
  });
  assert.equal(result.userId, ID);
  assert.equal(result.credentialPath, BOUNDARY.credentials);
  assert.equal(h.cursor, 10);
  assert.deepEqual(h.saved, [PASSWORD]);
  assert.equal(h.removed, 0);
  assert.equal(h.calls.filter((call) => call.method === 'PATCH').length, 1);
  assert.equal(h.calls.filter((call) => call.method === 'DELETE').length, 0);
  assert.equal(h.calls.filter((call) => call.url.includes('/rest/v1/user_roles') &&
    call.method === 'POST').length, 0);
  assert.equal(JSON.parse(h.calls[2].body).email_confirm, true);
  assert.equal(h.calls[6].headers.Prefer, 'return=representation');
  assert.equal(h.calls[0].headers.Authorization, undefined);
  assert.equal(h.calls[9].headers.Authorization, `Bearer ${TOKEN}`);
  assert.equal(h.calls[2].headers.apikey, KEYS.secret);
  assert.equal(h.calls[2].headers.Authorization, `Bearer ${KEYS.serviceJwt}`);
});

test('nonempty test Auth store stops before saving credentials or creating users', async () => {
  const steps = defaultSteps().slice(0, 2);
  steps[1].value = { users: [{ id: ID, email: BOUNDARY.email }], total: 1 };
  const h = harness(steps);
  await assert.rejects(() => bootstrapTestAdmin({
    gateway: BOUNDARY.gateway, email: BOUNDARY.email, keys: KEYS,
    fetchImpl: h.fetchImpl, credentialStore: h.store, password: PASSWORD,
  }), { code: 'AUTH_STORE_NOT_EMPTY' });
  assert.equal(h.cursor, 2);
  assert.deepEqual(h.saved, []);
});

test('duplicate role or failed promotion deletes only user created in this run', async () => {
  const steps = defaultSteps().slice(0, 7);
  steps[5].value = [
    { id: ROLE_ID, user_id: ID, role: 'viewer' },
    { id: 'dddddddd-4444-4444-8444-dddddddddddd', user_id: ID, role: 'admin' },
  ];
  steps.length = 6;
  steps.push({ method: 'DELETE', path: `/auth/v1/admin/users/${ID}`, status: 204, value: null });
  const h = harness(steps);
  await assert.rejects(() => bootstrapTestAdmin({
    gateway: BOUNDARY.gateway, email: BOUNDARY.email, keys: KEYS,
    fetchImpl: h.fetchImpl, credentialStore: h.store, password: PASSWORD,
  }), { code: 'PROFILE_OR_ROLE_MISMATCH' });
  assert.equal(h.cursor, 7);
  assert.equal(h.removed, 1);
  assert.equal(h.calls.filter((call) => call.method === 'DELETE').length, 1);
});

test('unknown create outcome retains private password for manual reconciliation', async () => {
  const steps = defaultSteps().slice(0, 3);
  steps[2].status = 500;
  steps[2].value = { error: 'secret vendor detail not printed' };
  const h = harness(steps);
  await assert.rejects(() => bootstrapTestAdmin({
    gateway: BOUNDARY.gateway, email: BOUNDARY.email, keys: KEYS,
    fetchImpl: h.fetchImpl, credentialStore: h.store, password: PASSWORD,
  }), { code: 'CREATE_OUTCOME_UNKNOWN' });
  assert.equal(h.removed, 0);
  assert.deepEqual(h.saved, [PASSWORD]);
  assert.equal(h.calls.filter((call) => call.method === 'DELETE').length, 0);
});

test('wrong gateway or identity fails without touching network or credential store', async () => {
  const h = harness([]);
  await assert.rejects(() => bootstrapTestAdmin({
    gateway: 'https://api-volt-next.testdevops.ru', email: BOUNDARY.email,
    keys: KEYS, fetchImpl: h.fetchImpl, credentialStore: h.store,
    password: PASSWORD,
  }), { code: 'BOUNDARY_MISMATCH' });
  assert.equal(h.cursor, 0);
  assert.deepEqual(h.saved, []);
});

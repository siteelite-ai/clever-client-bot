import assert from 'node:assert/strict';
import test from 'node:test';
import {
  BOUNDARY, ProvisionError, parseArgs, provisionIsolatedAdmin,
  validateEmail, validatePassword,
} from './provision-isolated-admin.mjs';

const EMAIL = 'chosen-admin@example.org';
const PASSWORD = 'correct-horse-battery-staple-2026';
const QA_ID = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const QA_ROLE_ID = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb';
const ID = 'cccccccc-3333-4333-8333-cccccccccccc';
const PROFILE_ID = 'dddddddd-4444-4444-8444-dddddddddddd';
const ROLE_ID = 'eeeeeeee-5555-4555-8555-eeeeeeeeeeee';
const TOKEN = 'test-user-access-token-123456789';
const KEYS = {
  secret: 'sb_secret_isolated_test_123',
  serviceJwt: 'header.body.signature',
  public: 'sb_publishable_isolated_test_123',
};

function response(status, value) {
  return new Response(value === null ? null : JSON.stringify(value), {
    status, headers: { 'Content-Type': 'application/json' },
  });
}

function steps() {
  return [
    { method: 'POST', path: '/functions/v1/admin-users', status: 401,
      value: { error: 'Unauthorized' } },
    { method: 'GET', path: '/auth/v1/admin/users?page=1&per_page=1000',
      status: 200, value: { users: [{ id: QA_ID, email: BOUNDARY.qaEmail }], total: 1 } },
    { method: 'GET', path: `/rest/v1/user_roles?user_id=eq.${QA_ID}&select=id,user_id,role`,
      status: 200, value: [{ id: QA_ROLE_ID, user_id: QA_ID, role: 'admin' }] },
    { method: 'POST', path: '/auth/v1/admin/users', status: 201,
      value: { id: ID, email: EMAIL } },
    { method: 'GET', path: `/auth/v1/admin/users/${ID}`, status: 200,
      value: { id: ID, email: EMAIL } },
    { method: 'GET', path: `/rest/v1/profiles?user_id=eq.${ID}&select=id,user_id,display_name`,
      status: 200, value: [{ id: PROFILE_ID, user_id: ID, display_name: EMAIL }] },
    { method: 'GET', path: `/rest/v1/user_roles?user_id=eq.${ID}&select=id,user_id,role`,
      status: 200, value: [{ id: ROLE_ID, user_id: ID, role: 'viewer' }] },
    { method: 'PATCH', path: `/rest/v1/user_roles?id=eq.${ROLE_ID}&user_id=eq.${ID}&role=eq.viewer`,
      status: 200, value: [{ id: ROLE_ID, user_id: ID, role: 'admin' }] },
    { method: 'GET', path: `/rest/v1/user_roles?user_id=eq.${ID}&select=id,user_id,role`,
      status: 200, value: [{ id: ROLE_ID, user_id: ID, role: 'admin' }] },
    { method: 'POST', path: '/auth/v1/token?grant_type=password', status: 200,
      value: { user: { id: ID, email: EMAIL }, access_token: TOKEN } },
    { method: 'POST', path: '/functions/v1/admin-users', status: 200,
      value: { users: [{ id: ID, email: EMAIL, role: 'admin' }] } },
  ];
}

function harness(nextSteps = steps()) {
  const calls = [];
  let cursor = 0;
  return {
    calls,
    get cursor() { return cursor; },
    async fetchImpl(url, options) {
      const next = nextSteps[cursor++];
      assert.ok(next, 'unexpected network call');
      assert.equal(url, `${BOUNDARY.gateway}${next.path}`);
      assert.equal(options.method, next.method);
      assert.equal(options.redirect, 'error');
      calls.push({ url, ...options });
      return response(next.status, next.value);
    },
  };
}

test('requires explicit email, isolated mode and confirmation', () => {
  const args = ['--email', EMAIL, '--mode', BOUNDARY.mode,
    '--confirm', BOUNDARY.confirm];
  assert.equal(parseArgs(args), EMAIL);
  for (const bad of [
    args.slice(0, -2),
    [...args, '--email', EMAIL],
    ['--email', BOUNDARY.qaEmail, ...args.slice(2)],
    ['--email', 'CLIENT@EXAMPLE.ORG', ...args.slice(2)],
    ['--email', EMAIL, '--mode', 'production', ...args.slice(4)],
    ['--email', EMAIL, '--mode', BOUNDARY.mode, '--confirm', 'yes'],
  ]) assert.throws(() => parseArgs(bad), ProvisionError);
  assert.throws(() => validateEmail('wrong@example.test'), ProvisionError);
  assert.throws(() => validatePassword('short', EMAIL), ProvisionError);
  assert.throws(() => validatePassword(` ${PASSWORD}`, EMAIL), ProvisionError);
});

test('creates exact isolated user, promotes only trigger viewer row and verifies login', async () => {
  const h = harness();
  const result = await provisionIsolatedAdmin({
    email: EMAIL, password: PASSWORD, keys: KEYS, fetchImpl: h.fetchImpl,
  });
  assert.deepEqual(result, { userId: ID, email: EMAIL });
  assert.equal(h.cursor, 11);
  assert.equal(h.calls.filter((call) => call.method === 'DELETE').length, 0);
  assert.equal(h.calls.filter((call) => call.method === 'PATCH').length, 1);
  assert.equal(h.calls[7].headers.Prefer, 'return=representation');
  assert.equal(h.calls[3].headers.apikey, KEYS.secret);
  assert.equal(h.calls[3].headers.Authorization, `Bearer ${KEYS.serviceJwt}`);
  assert.equal(h.calls[0].headers.Authorization, undefined);
  assert.equal(h.calls[10].headers.Authorization, `Bearer ${TOKEN}`);
  assert.deepEqual(JSON.parse(h.calls[3].body), {
    email: EMAIL, password: PASSWORD, email_confirm: true,
    user_metadata: { display_name: EMAIL },
  });
  assert.equal(JSON.parse(h.calls[9].body).password, PASSWORD);
});

test('other Auth users or duplicate email fail before create', async () => {
  for (const users of [
    [{ id: ID, email: EMAIL }],
    [{ id: QA_ID, email: BOUNDARY.qaEmail }, { id: ID, email: EMAIL }],
  ]) {
    const nextSteps = steps().slice(0, 2);
    nextSteps[1].value = { users, total: users.length };
    const h = harness(nextSteps);
    await assert.rejects(() => provisionIsolatedAdmin({
      email: EMAIL, password: PASSWORD, keys: KEYS, fetchImpl: h.fetchImpl,
    }), { code: 'AUTH_STORE_BOUNDARY_MISMATCH' });
    assert.equal(h.cursor, 2);
    assert.equal(h.calls.filter((call) => call.method === 'POST' &&
      call.url.endsWith('/auth/v1/admin/users')).length, 0);
  }
});

test('missing Auth total requires an empty second page before creation', async () => {
  const nextSteps = steps().slice(0, 2);
  nextSteps[1].value = { users: [{ id: QA_ID, email: BOUNDARY.qaEmail }] };
  nextSteps.push({ method: 'GET',
    path: '/auth/v1/admin/users?page=2&per_page=1000', status: 200,
    value: { users: [{ id: ID, email: EMAIL }] } });
  const h = harness(nextSteps);
  await assert.rejects(() => provisionIsolatedAdmin({
    email: EMAIL, password: PASSWORD, keys: KEYS, fetchImpl: h.fetchImpl,
  }), { code: 'AUTH_STORE_BOUNDARY_MISMATCH' });
  assert.equal(h.cursor, 3);
  assert.equal(h.calls.filter((call) => call.method === 'POST' &&
    call.url.endsWith('/auth/v1/admin/users')).length, 0);
});

test('failed role verification rolls back only the UUID returned by create', async () => {
  const nextSteps = steps().slice(0, 9);
  nextSteps[8].value = [
    { id: ROLE_ID, user_id: ID, role: 'admin' },
    { id: 'ffffffff-6666-4666-8666-ffffffffffff', user_id: ID, role: 'viewer' },
  ];
  nextSteps.push({ method: 'DELETE', path: `/auth/v1/admin/users/${ID}`,
    status: 204, value: null });
  const h = harness(nextSteps);
  await assert.rejects(() => provisionIsolatedAdmin({
    email: EMAIL, password: PASSWORD, keys: KEYS, fetchImpl: h.fetchImpl,
  }), { code: 'ROLE_MISMATCH' });
  assert.equal(h.cursor, 10);
  assert.equal(h.calls.filter((call) => call.method === 'DELETE').length, 1);
  assert.equal(h.calls.at(-1).url, `${BOUNDARY.gateway}/auth/v1/admin/users/${ID}`);
});

test('unknown create outcome never guesses which account to delete', async () => {
  const nextSteps = steps().slice(0, 4);
  nextSteps[3].status = 500;
  nextSteps[3].value = { error: 'private upstream detail must not be echoed' };
  const h = harness(nextSteps);
  await assert.rejects(() => provisionIsolatedAdmin({
    email: EMAIL, password: PASSWORD, keys: KEYS, fetchImpl: h.fetchImpl,
  }), { code: 'CREATE_OUTCOME_UNKNOWN' });
  assert.equal(h.calls.filter((call) => call.method === 'DELETE').length, 0);
});

test('invalid dependency or weak password fails without a network call', async () => {
  const h = harness([]);
  await assert.rejects(() => provisionIsolatedAdmin({
    email: EMAIL, password: 'short', keys: KEYS, fetchImpl: h.fetchImpl,
  }), { code: 'WEAK_PASSWORD' });
  await assert.rejects(() => provisionIsolatedAdmin({
    email: EMAIL, password: PASSWORD, keys: { ...KEYS, secret: 'wrong' },
    fetchImpl: h.fetchImpl,
  }), { code: 'INVALID_DEPENDENCY' });
  assert.equal(h.cursor, 0);
});

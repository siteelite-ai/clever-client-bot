import assert from 'node:assert/strict';
import test from 'node:test';
import {
  BOUNDARY, SmokeError, parseExactArgs, smokeAdminSettings,
} from './smoke-admin-settings.mjs';

const ADMIN_ID = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const SETTINGS_ID = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb';
const TOKEN = 'synthetic-admin-token-123456789';
const PUBLIC_KEY = 'sb_publishable_synthetic_test';
const CREDENTIAL = { email: BOUNDARY.email, password: 'X'.repeat(48) };
const ALLOWED_ORIGIN = 'https://chat-volt-next.testdevops.ru';
const SECRET_COLUMNS = ['volt220_api_token', 'openrouter_api_key', 'google_api_key'];

function json(status, value, extraHeaders = {}) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json', ...extraHeaders },
  });
}

function args() {
  return Object.entries(BOUNDARY).flatMap(([name, value]) => [
    name === 'dbContainer' ? '--db-container' : `--${name}`, value,
  ]);
}

function harness({ noTokenStatus = 401, foreignStatus = 403,
  secretReadStatus = 403, secretPatchStatus = 403,
  sentinelExists = false, unsafeSettings = false } = {}) {
  const calls = [];
  const settings = {
    id: SETTINGS_ID,
    hasVolt220ApiToken: false,
    hasOpenrouterKey: false,
    hasGoogleApiKey: false,
    ai_provider: 'openrouter',
    ai_model: 'test/model',
    classifier_provider: 'auto',
    classifier_model: 'test/model',
    classifier_prompt: null,
    active_pipeline: 'v3',
  };
  if (unsafeSettings) settings.openrouter_api_key = 'must-not-be-returned';
  return {
    calls,
    fetchImpl: async (url, options) => {
      assert.ok(url.startsWith(`${BOUNDARY.gateway}/`));
      assert.equal(options.redirect, 'error');
      const parsed = new URL(url);
      const { method } = options;
      const path = parsed.pathname;
      calls.push({ method, path, search: parsed.search,
        origin: options.headers.Origin, body: options.body });
      if (path === '/functions/v1/admin-settings') {
        assert.equal(method, 'POST');
        assert.deepEqual(JSON.parse(options.body), { action: 'read' });
        if (!options.headers.Authorization) {
          return json(noTokenStatus, { error: 'unauthorized' });
        }
        if (options.headers.Origin === 'https://foreign.invalid') {
          return json(foreignStatus, { error: 'origin_not_allowed' });
        }
        assert.equal(options.headers.Origin, ALLOWED_ORIGIN);
        return json(200, { settings },
          { 'Access-Control-Allow-Origin': ALLOWED_ORIGIN });
      }
      if (path === '/auth/v1/token') {
        assert.equal(method, 'POST');
        assert.deepEqual(JSON.parse(options.body), CREDENTIAL);
        return json(200, { user: { id: ADMIN_ID, email: BOUNDARY.email },
          access_token: TOKEN });
      }
      if (path === '/rest/v1/app_settings' && method === 'GET') {
        if (parsed.searchParams.get('select') === 'id') {
          return json(200, parsed.searchParams.has('id')
            ? (sentinelExists ? [{ id: '00000000-0000-4000-8000-000000000000' }] : [])
            : [{ id: SETTINGS_ID }]);
        }
        assert.ok(SECRET_COLUMNS.includes(parsed.searchParams.get('select')));
        return json(secretReadStatus, secretReadStatus === 200
          ? [{ openrouter_api_key: 'unsafe' }] : { code: '42501' });
      }
      if (path === '/rest/v1/app_settings' && method === 'PATCH') {
        assert.equal(parsed.searchParams.get('id'),
          'eq.00000000-0000-4000-8000-000000000000');
        const fields = Object.keys(JSON.parse(options.body));
        assert.equal(fields.length, 1);
        assert.ok(SECRET_COLUMNS.includes(fields[0]));
        return json(secretPatchStatus, { code: secretPatchStatus === 403 ? '42501' : 'ok' });
      }
      assert.fail(`unexpected request: ${method} ${path}`);
    },
  };
}

function run(h, gateway = BOUNDARY.gateway) {
  return smokeAdminSettings({ gateway, publicKey: PUBLIC_KEY,
    credential: CREDENTIAL, fetchImpl: h.fetchImpl });
}

test('rejects any changed path, host, account, mode, or confirmation before I/O', () => {
  assert.equal(parseExactArgs(args()), BOUNDARY);
  for (const value of Object.values(BOUNDARY)) {
    const changed = args().map((item) => item === value ? 'changed' : item);
    assert.throws(() => parseExactArgs(changed), SmokeError);
  }
  assert.throws(() => parseExactArgs([...args(), '--mode', BOUNDARY.mode]), SmokeError);
  assert.throws(() => parseExactArgs(args().slice(0, -2)), SmokeError);
});

test('wrong gateway aborts without HTTP', async () => {
  const h = harness();
  await assert.rejects(run(h, 'https://api-volt-next.testdevops.ru'),
    { code: 'BOUNDARY_MISMATCH' });
  assert.equal(h.calls.length, 0);
});

test('all probes pass with only fixed local Auth, function, and REST requests', async () => {
  const h = harness();
  const labels = await run(h);
  assert.equal(labels.length, 6);
  assert.equal(h.calls.length, 12);
  assert.deepEqual(h.calls.filter((call) => call.method === 'PATCH')
    .map((call) => Object.keys(JSON.parse(call.body))[0]), SECRET_COLUMNS);
  assert.ok(h.calls.every((call) => ['/functions/v1/admin-settings',
    '/auth/v1/token', '/rest/v1/app_settings'].includes(call.path)));
});

test('no-token bypass stops before sign-in', async () => {
  const h = harness({ noTokenStatus: 200 });
  await assert.rejects(run(h), { code: 'NO_TOKEN_GATE_FAILED' });
  assert.equal(h.calls.length, 1);
});

test('foreign origin bypass stops before settings read', async () => {
  const h = harness({ foreignStatus: 200 });
  await assert.rejects(run(h), { code: 'FOREIGN_ORIGIN_GATE_FAILED' });
  assert.equal(h.calls.length, 3);
});

test('raw secret in admin read payload is rejected', async () => {
  const h = harness({ unsafeSettings: true });
  await assert.rejects(run(h), { code: 'UNSAFE_SETTINGS_RESPONSE' });
  assert.equal(h.calls.length, 4);
});

test('an occupied sentinel aborts before any PATCH', async () => {
  const h = harness({ sentinelExists: true });
  await assert.rejects(run(h), { code: 'PATCH_SENTINEL_NOT_EMPTY' });
  assert.equal(h.calls.filter((call) => call.method === 'PATCH').length, 0);
});

test('secret SELECT and PATCH must be forbidden', async () => {
  for (const [override, code] of [
    [{ secretReadStatus: 200 }, 'REST_SECRET_READ_NOT_DENIED'],
    [{ secretPatchStatus: 200 }, 'REST_SECRET_WRITE_NOT_DENIED'],
  ]) {
    const h = harness(override);
    await assert.rejects(run(h), { code });
  }
});

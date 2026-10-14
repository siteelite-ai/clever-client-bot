import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

const require = createRequire(import.meta.url);
const sourcePath = fileURLToPath(new URL('../../supabase/functions/admin-users/index.ts', import.meta.url));
const source = readFileSync(sourcePath, 'utf8');
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;

function createHarness({ caller = { id: 'admin-id' }, isAdmin = true, listError = null } = {}) {
  let handler;
  const calls = { createClient: 0, getUserTokens: [], roleChecks: 0, listUsers: 0 };
  const env = {
    SUPABASE_URL: 'https://isolated-test.supabase.example',
    SUPABASE_ANON_KEY: 'synthetic-anon-key',
    SUPABASE_SERVICE_ROLE_KEY: 'synthetic-service-key',
  };

  const anonClient = {
    auth: {
      async getUser(token) {
        calls.getUserTokens.push(token);
        return { data: { user: caller }, error: null };
      },
    },
  };

  const adminClient = {
    auth: {
      admin: {
        async listUsers() {
          calls.listUsers++;
          if (listError) throw new Error(listError);
          return { data: { users: [{ id: 'other-user-id', email: 'user@example.test', created_at: '2026-01-01' }] }, error: null };
        },
      },
    },
    from(table) {
      const query = {
        select() { return this; },
        eq() { return this; },
        async single() {
          assert.equal(table, 'user_roles');
          calls.roleChecks++;
          return { data: isAdmin ? { role: 'admin' } : null, error: null };
        },
        then(resolve, reject) {
          assert.ok(table === 'profiles' || table === 'user_roles');
          return Promise.resolve({ data: [], error: null }).then(resolve, reject);
        },
      };
      return query;
    },
  };

  const context = {
    console: { error() {} },
    Deno: { env: { get: (key) => env[key] } },
    Request,
    Response,
    exports: {},
    require(specifier) {
      if (specifier === 'https://deno.land/std@0.168.0/http/server.ts') {
        return { serve(callback) { handler = callback; } };
      }
      if (specifier === 'https://esm.sh/@supabase/supabase-js@2') {
        return {
          createClient(_url, key) {
            calls.createClient++;
            return key === env.SUPABASE_ANON_KEY ? anonClient : adminClient;
          },
        };
      }
      return require(specifier);
    },
  };

  runInNewContext(compiled, context, { filename: sourcePath });
  assert.equal(typeof handler, 'function');

  return {
    calls,
    async invoke({ method = 'POST', authorization = 'Bearer synthetic.jwt-token', body = { action: 'list' } } = {}) {
      const headers = authorization === null ? {} : { Authorization: authorization };
      const request = new Request(`${env.SUPABASE_URL}/functions/v1/admin-users`, {
        method,
        headers,
        ...(method === 'POST' ? { body: JSON.stringify(body) } : {}),
      });
      const response = await handler(request);
      return { status: response.status, headers: response.headers, body: await response.text() };
    },
  };
}

test('preflight and method allowlist do not initialize Supabase clients', async () => {
  const harness = createHarness();
  const preflight = await harness.invoke({ method: 'OPTIONS', authorization: null });
  assert.equal(preflight.status, 200);
  assert.equal(preflight.headers.get('Access-Control-Allow-Methods'), 'POST, OPTIONS');

  const get = await harness.invoke({ method: 'GET', authorization: null });
  assert.equal(get.status, 405);
  assert.equal(get.headers.get('Allow'), 'POST, OPTIONS');
  assert.deepEqual(JSON.parse(get.body), { error: 'Method not allowed' });
  assert.equal(harness.calls.createClient, 0);
});

test('malformed or missing Bearer token cannot reach identity lookup', async () => {
  const harness = createHarness();
  for (const authorization of [null, '', 'Basic synthetic.jwt-token', 'synthetic.jwt-token', 'Bearer ', 'Bearer first second', 'Bearer\tfirst']) {
    const response = await harness.invoke({ authorization });
    assert.equal(response.status, 401, `unexpected status for ${authorization}`);
  }
  assert.deepEqual(harness.calls.getUserTokens, []);
  assert.equal(harness.calls.roleChecks, 0);
});

test('valid Bearer token is passed exactly and existing admin gate remains enforced', async () => {
  const harness = createHarness({ isAdmin: false });
  const response = await harness.invoke({ authorization: 'Bearer synthetic.jwt-token' });
  assert.equal(response.status, 403);
  assert.deepEqual(harness.calls.getUserTokens, ['synthetic.jwt-token']);
  assert.equal(harness.calls.roleChecks, 1);
  assert.equal(harness.calls.listUsers, 0);
});

test('unknown identity is denied before the admin role lookup', async () => {
  const harness = createHarness({ caller: null });
  const response = await harness.invoke();
  assert.equal(response.status, 401);
  assert.equal(harness.calls.getUserTokens.length, 1);
  assert.equal(harness.calls.roleChecks, 0);
});

test('valid admin can still list users and internal errors never appear in response', async () => {
  const normal = createHarness();
  const listed = await normal.invoke();
  assert.equal(listed.status, 200);
  assert.equal(JSON.parse(listed.body).users[0].email, 'user@example.test');
  assert.equal(normal.calls.listUsers, 1);

  const failing = createHarness({ listError: 'secret database detail' });
  const response = await failing.invoke();
  assert.equal(response.status, 500);
  assert.deepEqual(JSON.parse(response.body), { error: 'Ошибка сервера' });
  assert.ok(!response.body.includes('secret database detail'));
});

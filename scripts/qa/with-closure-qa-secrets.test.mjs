import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import {
  ACCESS_PREFIX,
  CATALOG_PREFIX,
  PROJECT_REF,
  createClosureQaCredentials,
  runWithClosureQaSecrets,
} from './with-closure-qa-secrets.mjs';

function deterministicCredentials() {
  let byte = 1;
  return createClosureQaCredentials({
    nowMs: 1_700_000_000_000,
    randomBytesImpl: (length) => Buffer.alloc(length, byte++),
  });
}
const FIXTURE = deterministicCredentials();
const [ACCESS_NAME, CATALOG_NAME] = FIXTURE.names;
const ACCESS = FIXTURE.access;
const CATALOG = FIXTURE.catalog;

function fakeManagementApi({
  initialNames = [],
  createStatus = 201,
  partialCreate = false,
  deleteStatus = 200,
  skipDelete = false,
  listStatus = 200,
} = {}) {
  const secrets = new Map(initialNames.map((name) => [name, 'existing-value-must-not-print']));
  const calls = [];
  const fetchImpl = async (url, init) => {
    assert.equal(url, `https://api.supabase.com/v1/projects/${PROJECT_REF}/secrets`);
    assert.equal(init.redirect, 'error');
    assert.match(init.headers.Authorization, /^Bearer /);
    const body = init.body === undefined ? null : JSON.parse(init.body);
    calls.push({ method: init.method, body });
    if (init.method === 'GET') {
      return {
        status: listStatus,
        json: async () => [...secrets].map(([name, value]) => ({ name, value })),
      };
    }
    if (init.method === 'POST') {
      for (const item of partialCreate ? body.slice(0, 1) : body) {
        secrets.set(item.name, item.value);
      }
      return { status: createStatus, json: async () => ({}) };
    }
    if (init.method === 'DELETE') {
      if (!skipDelete) for (const name of body) secrets.delete(name);
      return { status: deleteStatus, json: async () => ({}) };
    }
    throw new Error('Unexpected method');
  };
  return { fetchImpl, calls, secrets };
}

function options(api, runChild = async () => {}) {
  return {
    projectRef: PROJECT_REF,
    token: 'management-token-should-not-reach-child',
    command: 'node',
    args: ['trusted-qa-script.mjs'],
    fetchImpl: api.fetchImpl,
    createCredentials: deterministicCredentials,
    runChild,
    delay: async () => {},
  };
}

test('runId and both values match the time-bounded gate protocol', () => {
  assert.match(FIXTURE.runId, /^\d{10}_[a-f0-9]{32}$/);
  assert.equal(FIXTURE.names[0], `${ACCESS_PREFIX}${FIXTURE.runId}`);
  assert.equal(FIXTURE.names[1], `${CATALOG_PREFIX}${FIXTURE.runId}`);
  assert.match(ACCESS, new RegExp(`^${FIXTURE.runId}_[A-Za-z0-9_-]{64}$`));
  assert.match(CATALOG, new RegExp(`^${FIXTURE.runId}_[A-Za-z0-9_-]{64}$`));
  assert.notEqual(ACCESS, CATALOG);
});

test('a pre-existing name is a hard collision: no POST and no DELETE', async () => {
  const api = fakeManagementApi({ initialNames: [ACCESS_NAME, 'UNRELATED_SECRET'] });
  await assert.rejects(runWithClosureQaSecrets(options(api)), /already exists/);
  assert.deepEqual(api.calls.map((call) => call.method), ['GET']);
  assert.equal(api.secrets.get(ACCESS_NAME), 'existing-value-must-not-print');
});

test('only this runId pair is created, passed as aliases, deleted, and verified', async () => {
  const api = fakeManagementApi({ initialNames: ['UNRELATED_SECRET'] });
  let childWasCalled = false;
  await runWithClosureQaSecrets({ ...options(api, async (command, args, env) => {
    childWasCalled = true;
    assert.equal(command, 'node');
    assert.deepEqual(args, ['trusted-qa-script.mjs']);
    assert.deepEqual(env, {
      VOLT220_V3_QA_SECRET: ACCESS,
      VOLT220_V3_CATALOG_QA_SECRET: CATALOG,
    });
    assert.equal(env.SUPABASE_ACCESS_TOKEN, undefined);
  }), delay: () => { throw new Error('success path must not wait'); } });
  assert.equal(childWasCalled, true);
  assert.deepEqual(api.calls.map((call) => call.method), ['GET', 'POST', 'GET', 'DELETE', 'GET']);
  assert.deepEqual(api.calls[1].body.map((item) => item.name), FIXTURE.names);
  assert.deepEqual(api.calls[3].body, FIXTURE.names);
  assert.deepEqual([...api.secrets.keys()], ['UNRELATED_SECRET']);
});

test('partial POST failure still deletes exactly both attempted names', async () => {
  const api = fakeManagementApi({ createStatus: 500, partialCreate: true });
  let childWasCalled = false;
  await assert.rejects(runWithClosureQaSecrets(options(api, async () => {
    childWasCalled = true;
  })), /Temporary QA secret state uncertain/);
  assert.equal(childWasCalled, false);
  assert.deepEqual(api.calls.map((call) => call.method), ['GET', 'POST', 'DELETE', 'GET', 'GET', 'GET', 'GET']);
  assert.deepEqual(api.calls[2].body, FIXTURE.names);
  assert.equal(api.secrets.size, 0);
});

test('late POST completion after first DELETE is caught and re-deleted for this runId', async () => {
  const api = fakeManagementApi();
  const originalFetch = api.fetchImpl;
  let latePostBody;
  api.fetchImpl = async (url, init) => {
    if (init.method === 'POST') {
      latePostBody = JSON.parse(init.body);
      api.calls.push({ method: 'POST', body: latePostBody });
      // The client receives a transport failure while server-side work lives on.
      throw new Error(`transport might echo ${ACCESS} ${CATALOG}`);
    }
    return originalFetch(url, init);
  };
  const checkpoints = [];
  let thrown;
  try {
    await runWithClosureQaSecrets({
      ...options(api),
      delay: async (ms) => {
        checkpoints.push(ms);
        if (checkpoints.length === 1) {
          // Simulate a late server write of only one member of this pair.
          api.secrets.set(latePostBody[0].name, latePostBody[0].value);
        }
      },
    });
  } catch (error) {
    thrown = error;
  }
  assert.ok(thrown);
  assert.match(thrown.message, /Temporary QA secret state uncertain/);
  assert.equal(thrown.message.includes(ACCESS_NAME), true);
  assert.equal(thrown.message.includes(CATALOG_NAME), true);
  assert.equal(thrown.message.includes(ACCESS), false);
  assert.equal(thrown.message.includes(CATALOG), false);
  assert.equal(thrown.message.includes('management-token'), false);
  assert.equal(checkpoints.length, 3);
  assert.ok(checkpoints[0] <= 2_000 && checkpoints[0] >= 1_000);
  assert.ok(checkpoints[1] <= 5_000 && checkpoints[1] >= 4_000);
  assert.ok(checkpoints[2] <= 15_000 && checkpoints[2] >= 14_000);
  const deletes = api.calls.filter((call) => call.method === 'DELETE');
  assert.equal(deletes.length, 2);
  for (const call of deletes) assert.deepEqual(call.body, FIXTURE.names);
  assert.equal(api.secrets.size, 0);
});

test('child failure is redacted and cannot skip cleanup', async () => {
  const api = fakeManagementApi();
  let thrown;
  try {
    await runWithClosureQaSecrets(options(api, async () => {
      throw new Error(`sensitive child output: ${ACCESS} ${CATALOG}`);
    }));
  } catch (error) {
    thrown = error;
  }
  assert.ok(thrown);
  assert.match(thrown.message, /QA step failed/);
  assert.equal(thrown.message.includes(ACCESS_NAME), true);
  assert.equal(thrown.message.includes(CATALOG_NAME), true);
  assert.equal(String(thrown).includes(ACCESS), false);
  assert.equal(String(thrown).includes(CATALOG), false);
  assert.equal(api.secrets.size, 0);
});

test('cleanup failure is fatal even when the child succeeds', async () => {
  const api = fakeManagementApi({ skipDelete: true, deleteStatus: 500 });
  await assert.rejects(runWithClosureQaSecrets(options(api)), /secret state uncertain/);
  assert.deepEqual(api.calls.at(-2).body, FIXTURE.names);
  assert.equal(api.secrets.has(ACCESS_NAME), true);
  assert.equal(api.secrets.has(CATALOG_NAME), true);
});

test('cleanup verification failure is fatal even after successful DELETE', async () => {
  const api = fakeManagementApi();
  let getCount = 0;
  const originalFetch = api.fetchImpl;
  api.fetchImpl = async (url, init) => {
    if (init.method === 'GET' && ++getCount === 3) return { status: 500 };
    return originalFetch(url, init);
  };
  await assert.rejects(runWithClosureQaSecrets(options(api)), /secret state uncertain/);
  assert.equal(api.secrets.size, 0);
});

test('parallel runs have distinct names and each DELETE touches only its own pair', async () => {
  const api = fakeManagementApi({ initialNames: ['UNRELATED_SECRET'] });
  let childStarts = 0;
  let release;
  const bothChildrenStarted = new Promise((resolve) => { release = resolve; });
  const runChild = async () => {
    childStarts++;
    if (childStarts === 2) release();
    await bothChildrenStarted;
  };
  await Promise.all([
    runWithClosureQaSecrets({ ...options(api, runChild), createCredentials: createClosureQaCredentials }),
    runWithClosureQaSecrets({ ...options(api, runChild), createCredentials: createClosureQaCredentials }),
  ]);
  const created = api.calls.filter((call) => call.method === 'POST').map((call) => call.body.map((item) => item.name));
  const deleted = api.calls.filter((call) => call.method === 'DELETE').map((call) => call.body);
  assert.equal(childStarts, 2);
  assert.equal(created.length, 2);
  assert.notDeepEqual(created[0], created[1]);
  assert.deepEqual(new Set(created.flat()).size, 4);
  assert.deepEqual(deleted.length, 2);
  for (const pair of deleted) assert.equal(created.some((own) => own.join('|') === pair.join('|')), true);
  assert.deepEqual([...api.secrets.keys()], ['UNRELATED_SECRET']);
});

test('abort signal terminates a live child and still removes its own pair', { timeout: 5_000 }, async () => {
  const api = fakeManagementApi();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 80);
  try {
    await assert.rejects(runWithClosureQaSecrets({
      ...options(api),
      command: process.execPath,
      args: ['-e', 'setTimeout(() => {}, 60_000)'],
      runChild: undefined,
      abortSignal: controller.signal,
    }), /QA step failed/);
  } finally {
    clearTimeout(timer);
  }
  assert.equal(api.secrets.size, 0);
  assert.deepEqual(api.calls.filter((call) => call.method === 'DELETE')[0].body, FIXTURE.names);
});

test('real child cannot expose split secrets on stdout or stderr and inherits no PAT', () => {
  const moduleUrl = new URL('./with-closure-qa-secrets.mjs', import.meta.url).href;
  const wrapperSource = `
    import { runTrustedChild } from ${JSON.stringify(moduleUrl)};
    const childSource = \`
      const access = process.env.VOLT220_V3_QA_SECRET;
      const catalog = process.env.VOLT220_V3_CATALOG_QA_SECRET;
      process.stdout.write(access.slice(0, 17));
      process.stderr.write(catalog.slice(0, 1));
      setTimeout(() => {
        process.stdout.write(access.slice(17));
        process.stderr.write(catalog.slice(1));
        if (process.env.SUPABASE_ACCESS_TOKEN) process.exitCode = 2;
      }, 5);
    \`;
    await runTrustedChild(process.execPath, ['-e', childSource], {
      VOLT220_V3_QA_SECRET: process.env.VOLT220_V3_QA_SECRET,
      VOLT220_V3_CATALOG_QA_SECRET: process.env.VOLT220_V3_CATALOG_QA_SECRET,
    });
  `;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', wrapperSource], {
    encoding: 'utf8',
    timeout: 5_000,
    env: {
      ...process.env,
      SUPABASE_ACCESS_TOKEN: 'management-token-should-not-reach-child',
      VOLT220_V3_QA_SECRET: ACCESS,
      VOLT220_V3_CATALOG_QA_SECRET: CATALOG,
    },
  });
  assert.equal(result.status, 0);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, '');
});

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import {
  CHILD_TIMEOUT_MS,
  PROJECT_REF,
  SECRET_NAME,
  createRouteQaCredential,
  runTrustedRouteSmoke,
  runWithRouteQaSecret,
  sanitizeRouteSmokeSummary,
} from './with-route-qa-secret.mjs';
import { ROUTE_CLOSURE_FUNCTIONS } from './run-route-closure-smoke.mjs';

const NOW_MS = Date.now();
const SECRET = createRouteQaCredential({
  nowMs: NOW_MS,
  randomBytesImpl: (length) => Buffer.alloc(length, length === 16 ? 0x2a : 0x37),
});
const PAT = 'management-token-never-to-child-or-output';
const DIGEST = createHash('sha256').update(SECRET, 'utf8').digest('hex');
const MANAGEMENT_URL = `https://api.supabase.com/v1/projects/${PROJECT_REF}/secrets`;
const PROBES = [
  ['missing_secret', 403],
  ['wrong_secret', 403],
  ['invalid_bearer_jwt', 401],
  ['authorized_get', 405],
  ['authorized_malformed_json', 400],
];

function passingSummary() {
  return {
    ok: true,
    status: 'passed',
    checks: ROUTE_CLOSURE_FUNCTIONS.flatMap((functionName) => PROBES.map(([check, status]) => ({
      function: functionName,
      check,
      expected_status: status,
      http_status: status,
    }))),
  };
}

function fakeApi({
  initial = [],
  getStatus = 200,
  postStatus = 201,
  postWrites = true,
  deleteStatus = 200,
  deleteWorks = true,
  postThrows = false,
} = {}) {
  const secrets = new Map(initial.map((name) => [name, 'existing-value-never-to-print']));
  const calls = [];
  const fetchImpl = async (url, init) => {
    assert.equal(url, MANAGEMENT_URL);
    assert.equal(init.redirect, 'error');
    assert.equal(init.headers.Authorization, `Bearer ${PAT}`);
    const body = init.body === undefined ? undefined : JSON.parse(init.body);
    calls.push({ method: init.method, body, signal: init.signal });
    if (init.method === 'GET') return {
      status: getStatus,
      json: async () => [...secrets].map(([name, value]) => ({ name, value })),
    };
    if (init.method === 'POST') {
      if (postThrows) throw new Error(`reflected ${SECRET} ${PAT}`);
      if (postWrites) for (const { name, value } of body) {
        secrets.set(name, createHash('sha256').update(value, 'utf8').digest('hex'));
      }
      return { status: postStatus };
    }
    if (init.method === 'DELETE') {
      if (deleteWorks) for (const name of body) secrets.delete(name);
      return { status: deleteStatus };
    }
    throw new Error('Unexpected method');
  };
  return { fetchImpl, calls, secrets };
}

function options(api, runChild = async () => {}) {
  return {
    projectRef: PROJECT_REF,
    token: PAT,
    fetchImpl: api.fetchImpl,
    createCredential: () => SECRET,
    runChild,
    sleep: async () => {},
  };
}

test('credential has the exact 20-minute route-gate wire format and randomness', () => {
  assert.match(SECRET, /^\d{10}_[a-f0-9]{32}_[A-Za-z0-9_-]{64}$/);
  const another = createRouteQaCredential();
  assert.match(another, /^\d{10}_[a-f0-9]{32}_[A-Za-z0-9_-]{64}$/);
  assert.notEqual(another, SECRET);
  assert.throws(() => createRouteQaCredential({ nowMs: 0 }), /clock/);
  assert.throws(() => createRouteQaCredential({
    randomBytesImpl: () => Buffer.alloc(1),
  }), /generation failed/);
});

test('pre-existing secret is never overwritten or deleted', async () => {
  const api = fakeApi({ initial: [SECRET_NAME, 'OTHER'] });
  await assert.rejects(runWithRouteQaSecret(options(api)), /already exists/);
  assert.deepEqual(api.calls.map((call) => call.method), ['GET']);
  assert.equal(api.secrets.get(SECRET_NAME), 'existing-value-never-to-print');
});

test('preflight 403 and malformed response stop before any write', async () => {
  const denied = fakeApi({ getStatus: 403 });
  await assert.rejects(runWithRouteQaSecret(options(denied)), /GET failed \(HTTP 403\)/);
  assert.deepEqual(denied.calls.map((call) => call.method), ['GET']);

  const malformed = fakeApi();
  malformed.fetchImpl = async () => ({ status: 200, json: async () => ({ value: SECRET }) });
  await assert.rejects(runWithRouteQaSecret(options(malformed)), /unexpected shape/);
});

test('one secret is created, used only by the fixed child, deleted, and verified absent', async () => {
  const api = fakeApi({ initial: ['OTHER'] });
  let called = 0;
  const summary = passingSummary();
  assert.deepEqual(await runWithRouteQaSecret({
    ...options(api, async (value, opts) => {
      called++;
      assert.equal(value, SECRET);
      assert.equal(opts.timeoutMs, CHILD_TIMEOUT_MS);
      assert.equal(opts.abortSignal, undefined);
      return summary;
    }),
    sleep: () => { throw new Error('confirmed POST never needs delayed reads'); },
  }), summary);
  assert.equal(called, 1);
  assert.deepEqual(api.calls.map((call) => call.method), ['GET', 'POST', 'GET', 'GET', 'DELETE', 'GET']);
  assert.deepEqual(api.calls[1].body, [{ name: SECRET_NAME, value: SECRET }]);
  assert.deepEqual(api.calls[4].body, [SECRET_NAME]);
  assert.deepEqual([...api.secrets.keys()], ['OTHER']);
});

test('explicit POST 403 confirms absence but never deletes a same-name secret', async () => {
  const denied = fakeApi({ postStatus: 403, postWrites: false });
  await assert.rejects(runWithRouteQaSecret(options(denied)), /POST refused; no secret was deleted/);
  assert.deepEqual(denied.calls.map((call) => call.method), ['GET', 'POST', 'GET']);
  assert.equal(denied.secrets.size, 0);

  const foreign = fakeApi({ postStatus: 403 });
  await assert.rejects(runWithRouteQaSecret(options(foreign)), /state uncertain/);
  assert.deepEqual(foreign.calls.map((call) => call.method), ['GET', 'POST', 'GET']);
  assert.equal(foreign.secrets.get(SECRET_NAME), DIGEST);
});

test('uncertain POST and child failure are redacted; only owned value can be removed', async () => {
  const uncertain = fakeApi({ postThrows: true });
  await assert.rejects(runWithRouteQaSecret(options(uncertain)), (error) => {
    assert.match(error.message, /state uncertain/);
    assert.equal(String(error).includes(SECRET), false);
    assert.equal(String(error).includes(PAT), false);
    return true;
  });
  assert.deepEqual(uncertain.calls.map((call) => call.method), ['GET', 'POST', 'GET', 'GET', 'GET', 'GET']);
  assert.equal(uncertain.secrets.size, 0);

  const childApi = fakeApi();
  await assert.rejects(runWithRouteQaSecret(options(childApi, async () => {
    throw new Error(`sensitive ${SECRET} ${PAT}`);
  })), (error) => {
    assert.match(error.message, /verified removed/);
    assert.equal(error.message.includes(SECRET), false);
    assert.equal(error.message.includes(PAT), false);
    return true;
  });
  assert.equal(childApi.secrets.size, 0);
});

test('late server-side POST after initial check is noticed and deleted only when owned', async () => {
  const api = fakeApi({ postThrows: true });
  const checkpoints = [];
  await assert.rejects(runWithRouteQaSecret({
    ...options(api),
    sleep: async (ms) => {
      checkpoints.push(ms);
      if (checkpoints.length === 1) api.secrets.set(SECRET_NAME, DIGEST);
    },
  }), /state uncertain/);
  assert.equal(checkpoints.length, 3);
  assert.ok(checkpoints[0] <= 2_000 && checkpoints[0] >= 1_000);
  assert.ok(checkpoints[1] <= 5_000 && checkpoints[1] >= 4_000);
  assert.ok(checkpoints[2] <= 15_000 && checkpoints[2] >= 14_000);
  assert.deepEqual(api.calls.filter((call) => call.method === 'DELETE').map((call) => call.body), [[SECRET_NAME]]);
  assert.equal(api.secrets.size, 0);
});

test('DELETE 403 or failed verification prevents a false success report', async () => {
  const denied = fakeApi({ deleteStatus: 403, deleteWorks: false });
  await assert.rejects(runWithRouteQaSecret(options(denied)), /state uncertain/);
  assert.equal(denied.secrets.has(SECRET_NAME), true);
  assert.deepEqual(denied.calls.filter((call) => call.method === 'DELETE').map((call) => call.body), [[SECRET_NAME]]);

  const unreadable = fakeApi();
  let gets = 0;
  const original = unreadable.fetchImpl;
  unreadable.fetchImpl = async (url, init) => {
    if (init.method === 'GET' && ++gets === 3) return { status: 403 };
    return original(url, init);
  };
  await assert.rejects(runWithRouteQaSecret(options(unreadable)), /state uncertain/);
  assert.equal(unreadable.secrets.has(SECRET_NAME), true);
  assert.equal(unreadable.calls.some((call) => call.method === 'DELETE'), false);

  const unverifiable = fakeApi();
  let readCount = 0;
  const originalUnverifiable = unverifiable.fetchImpl;
  unverifiable.fetchImpl = async (url, init) => {
    if (init.method === 'GET' && ++readCount === 4) return { status: 403 };
    return originalUnverifiable(url, init);
  };
  await assert.rejects(runWithRouteQaSecret(options(unverifiable)), /state uncertain/);
  assert.equal(unverifiable.secrets.has(SECRET_NAME), false);
});

test('foreign or unreadable digest after 201 is never sent to child or deleted', async () => {
  for (const value of ['f'.repeat(64), 'not-a-sha256-digest']) {
    const api = fakeApi();
    const original = api.fetchImpl;
    api.fetchImpl = async (url, init) => {
      const response = await original(url, init);
      if (init.method === 'POST') api.secrets.set(SECRET_NAME, value);
      return response;
    };
    let childCalled = false;
    await assert.rejects(runWithRouteQaSecret(options(api, async () => {
      childCalled = true;
    })), /state uncertain/);
    assert.equal(childCalled, false);
    assert.equal(api.secrets.get(SECRET_NAME), value);
    assert.equal(api.calls.some((call) => call.method === 'DELETE'), false);
  }
});

test('interrupt after POST aborts child but not independent DELETE/verification', async () => {
  const api = fakeApi();
  const controller = new AbortController();
  await assert.rejects(runWithRouteQaSecret({
    ...options(api, async (_secret, { abortSignal }) => {
      assert.equal(abortSignal, controller.signal);
      controller.abort();
      throw new Error('interrupted');
    }),
    abortSignal: controller.signal,
  }), /verified removed/);
  assert.equal(api.secrets.size, 0);
  assert.deepEqual(api.calls.map((call) => call.method), ['GET', 'POST', 'GET', 'GET', 'DELETE', 'GET']);
  assert.equal(api.calls[4].signal.aborted, false);
});

test('fixed child receives only the route secret and a fixed local path', async () => {
  let invocation;
  const spawnImpl = (command, args, opts) => {
    invocation = { command, args, opts };
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.kill = () => true;
    queueMicrotask(() => {
      child.stdout.emit('data', JSON.stringify(passingSummary()));
      child.emit('close', 0);
    });
    return child;
  };
  assert.deepEqual(await runTrustedRouteSmoke(SECRET, { spawnImpl }), passingSummary());
  assert.equal(invocation.command, process.execPath);
  assert.equal(invocation.args.length, 2);
  assert.match(invocation.args[0], /\/scripts\/qa\/run-route-closure-smoke\.mjs$/);
  assert.deepEqual(invocation.args.slice(1), [`--project-ref=${PROJECT_REF}`]);
  assert.equal(invocation.opts.shell, false);
  assert.deepEqual(invocation.opts.stdio, ['ignore', 'pipe', 'ignore']);
  assert.equal(invocation.opts.env[SECRET_NAME], SECRET);
  assert.equal(invocation.opts.env.SUPABASE_ACCESS_TOKEN, undefined);
  assert.deepEqual(Object.keys(invocation.opts.env).sort(), ['LANG', 'PATH', 'TMPDIR', SECRET_NAME].sort());
  assert.equal(JSON.stringify(invocation.args).includes(SECRET), false);
});

test('fixed child timeout and nonzero exit are fatal', async () => {
  const signals = [];
  const stalledSpawn = () => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.kill = (signal) => {
      signals.push(signal);
      queueMicrotask(() => child.emit('close', null));
      return true;
    };
    return child;
  };
  await assert.rejects(runTrustedRouteSmoke(SECRET, { spawnImpl: stalledSpawn, timeoutMs: 5 }), /timed out/);
  assert.deepEqual(signals, ['SIGTERM']);

  const failingSpawn = () => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.kill = () => true;
    queueMicrotask(() => {
      child.stdout.emit('data', JSON.stringify(passingSummary()));
      child.emit('close', 1);
    });
    return child;
  };
  await assert.rejects(runTrustedRouteSmoke(SECRET, { spawnImpl: failingSpawn }), /smoke failed/);
});

test('only exact, ordered 15-probe JSON evidence passes the allowlist', () => {
  const summary = passingSummary();
  assert.deepEqual(sanitizeRouteSmokeSummary(summary), summary);
  for (const changed of [
    { ...summary, secret: SECRET },
    { ...summary, checks: summary.checks.slice(0, 14) },
    { ...summary, checks: [{ ...summary.checks[0], function: 'evil' }, ...summary.checks.slice(1)] },
    { ...summary, checks: [{ ...summary.checks[0], echoed: PAT }, ...summary.checks.slice(1)] },
    { ...summary, checks: [{ ...summary.checks[0], http_status: 500 }, ...summary.checks.slice(1)] },
  ]) {
    assert.throws(() => sanitizeRouteSmokeSummary(changed), /output was invalid/);
  }
});

test('reflected secrets, malformed JSON, invalid UTF-8, and oversized child output are never emitted', async () => {
  for (const output of [
    JSON.stringify({ ...passingSummary(), leak: `${SECRET} ${PAT}` }),
    `${SECRET}${JSON.stringify(passingSummary())}`,
    Buffer.from([0xff, 0xfe]),
    'x'.repeat(17 * 1024),
  ]) {
    let killed = false;
    const spawnImpl = () => {
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.kill = () => {
        killed = true;
        queueMicrotask(() => child.emit('close', null));
        return true;
      };
      queueMicrotask(() => {
        child.stdout.emit('data', output);
        if (!killed) child.emit('close', 0);
      });
      return child;
    };
    await assert.rejects(runTrustedRouteSmoke(SECRET, { spawnImpl }), (error) => {
      assert.equal(String(error).includes(SECRET), false);
      assert.equal(String(error).includes(PAT), false);
      return true;
    });
    if (typeof output === 'string' && output.length > 16 * 1024) assert.equal(killed, true);
  }
});

test('CLI rejects supplied command, URL, and value without reading PAT or making requests', () => {
  for (const extra of [['--endpoint=https://evil.invalid'], ['--', 'node', 'evil.mjs'], [SECRET]]) {
    const result = spawnSync(process.execPath, [
      new URL('./with-route-qa-secret.mjs', import.meta.url).pathname,
      `--project-ref=${PROJECT_REF}`,
      ...extra,
    ], { encoding: 'utf8', timeout: 3_000, env: { PATH: process.env.PATH ?? '' } });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Usage:/);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr.includes(SECRET), false);
  }
});

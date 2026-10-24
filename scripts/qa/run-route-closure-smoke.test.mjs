import assert from 'node:assert/strict';
import test from 'node:test';

import {
  main,
  ROUTE_CLOSURE_FUNCTIONS,
  ROUTE_CLOSURE_PROJECT_REF,
  ROUTE_CLOSURE_SECRET_ENV,
  ROUTE_CLOSURE_SECRET_HEADER,
  ROUTE_CLOSURE_TIMEOUT_MS,
  ROUTE_CLOSURE_MAX_AGE_SECONDS,
  ROUTE_CLOSURE_MAX_FUTURE_SECONDS,
} from './run-route-closure-smoke.mjs';

const issuedSeconds = Math.floor(Date.now() / 1000);
const runId = `${issuedSeconds}_${'0123456789abcdef'.repeat(2)}`;
const secret = `${runId}_${'q'.repeat(64)}`;
const jwt = [
  Buffer.from('{"alg":"HS256"}').toString('base64url'),
  Buffer.from('{"role":"anon"}').toString('base64url'),
  Buffer.from('fixture-signature').toString('base64url'),
].join('.');
const widgetSource = `supabaseKey: '${jwt}'`;
const argv = [`--project-ref=${ROUTE_CLOSURE_PROJECT_REF}`];

test('exactly three fixed endpoints and five free, ordered checks per endpoint', async () => {
  const requests = [];
  const summaries = [];
  const statuses = [403, 403, 401, 405, 400];
  const code = await main({
    argv, env: { [ROUTE_CLOSURE_SECRET_ENV]: secret }, widgetSource,
    emit: (summary) => summaries.push(summary),
    fetchImpl: async (url, init) => {
      requests.push({ url, init });
      return new Response('upstream body must not be emitted', {
        status: statuses[(requests.length - 1) % statuses.length],
      });
    },
  });

  assert.equal(code, 0);
  assert.equal(requests.length, 15);
  assert.equal(summaries.length, 1);
  assert.equal(summaries[0].ok, true);
  assert.equal(summaries[0].status, 'passed');
  assert.equal(summaries[0].checks.length, 15);
  assert.equal(JSON.stringify(summaries).includes(secret), false);
  assert.equal(JSON.stringify(summaries).includes('upstream body'), false);
  for (let i = 0; i < requests.length; i++) {
    const { url, init } = requests[i];
    assert.equal(url, `https://${ROUTE_CLOSURE_PROJECT_REF}.supabase.co/functions/v1/${ROUTE_CLOSURE_FUNCTIONS[Math.floor(i / 5)]}`);
    assert.equal(init.redirect, 'error');
    assert.equal(init.signal.aborted, true);
    if (i % 5 === 2) {
      assert.equal(init.method, 'GET');
      assert.equal(init.body, undefined);
      assert.equal(init.headers.Authorization, 'Bearer invalid-route-qa-jwt');
      assert.equal(init.headers.apikey, undefined);
      assert.equal(init.headers[ROUTE_CLOSURE_SECRET_HEADER], secret);
    } else {
      assert.equal(init.headers.Authorization, `Bearer ${jwt}`);
      assert.equal(init.headers.apikey, jwt);
    }
    if (i % 5 === 0) {
      assert.equal(init.method, 'POST');
      assert.equal(init.body, '{');
      assert.equal(init.headers[ROUTE_CLOSURE_SECRET_HEADER], undefined);
    } else if (i % 5 === 1) {
      assert.equal(init.method, 'POST');
      assert.equal(init.body, '{');
      assert.notEqual(init.headers[ROUTE_CLOSURE_SECRET_HEADER], secret);
      assert.match(init.headers[ROUTE_CLOSURE_SECRET_HEADER], /^\d{10}_[a-f0-9]{32}_[A-Za-z0-9_-]{64}$/);
    } else if (i % 5 === 3) {
      assert.equal(init.method, 'GET');
      assert.equal(init.body, undefined);
      assert.equal(init.headers[ROUTE_CLOSURE_SECRET_HEADER], secret);
    } else if (i % 5 === 4) {
      assert.equal(init.method, 'POST');
      assert.equal(init.body, '{');
      assert.equal(init.headers[ROUTE_CLOSURE_SECRET_HEADER], secret);
    }
  }
});

test('missing credentials, wrong project and arbitrary URLs fail before any request', async () => {
  const inputs = [
    { argv, env: {} },
    { argv, env: { [ROUTE_CLOSURE_SECRET_ENV]: 'short' } },
    { argv, env: { [ROUTE_CLOSURE_SECRET_ENV]: 'q'.repeat(64) } },
    { argv: [], env: { [ROUTE_CLOSURE_SECRET_ENV]: secret } },
    { argv: ['--project-ref=otherproject'], env: { [ROUTE_CLOSURE_SECRET_ENV]: secret } },
    { argv: [...argv, '--endpoint=https://attacker.invalid'], env: { [ROUTE_CLOSURE_SECRET_ENV]: secret } },
    { argv: ['--project-ref=https://attacker.invalid'], env: { [ROUTE_CLOSURE_SECRET_ENV]: secret } },
    { argv, env: { [ROUTE_CLOSURE_SECRET_ENV]: secret }, widgetSource: 'supabaseKey: "bad"' },
    { argv, env: { [ROUTE_CLOSURE_SECRET_ENV]: secret }, timeoutMs: ROUTE_CLOSURE_TIMEOUT_MS + 1 },
  ];
  for (const input of inputs) {
    const summaries = [];
    let requests = 0;
    const code = await main({
      argv, env: { [ROUTE_CLOSURE_SECRET_ENV]: secret }, widgetSource,
      ...input,
      emit: (summary) => summaries.push(summary),
      fetchImpl: async () => { requests++; throw new Error('must not fetch'); },
    });
    assert.equal(code, 2);
    assert.equal(requests, 0);
    assert.deepEqual(summaries, [{ ok: false, status: 'not_run', classification: 'config' }]);
  }
});

test('expired, future-dated, and malformed QA credentials fail before network', async () => {
  assert.equal(ROUTE_CLOSURE_MAX_AGE_SECONDS, 20 * 60);
  assert.equal(ROUTE_CLOSURE_MAX_FUTURE_SECONDS, 120);
  const cases = [
    { nowSeconds: issuedSeconds + ROUTE_CLOSURE_MAX_AGE_SECONDS + 1, value: secret },
    { nowSeconds: issuedSeconds - ROUTE_CLOSURE_MAX_FUTURE_SECONDS - 1, value: secret },
    { nowSeconds: Number.NaN, value: secret },
    { nowSeconds: issuedSeconds, value: `${issuedSeconds}_${'g'.repeat(32)}_${'q'.repeat(64)}` },
    { nowSeconds: issuedSeconds, value: `${runId}_${'q'.repeat(63)}` },
  ];
  for (const { nowSeconds, value } of cases) {
    let requests = 0;
    const summaries = [];
    const code = await main({
      argv, nowSeconds, env: { [ROUTE_CLOSURE_SECRET_ENV]: value }, widgetSource,
      emit: (summary) => summaries.push(summary),
      fetchImpl: async () => { requests++; throw new Error('must not fetch'); },
    });
    assert.equal(code, 2);
    assert.equal(requests, 0);
    assert.deepEqual(summaries, [{ ok: false, status: 'not_run', classification: 'config' }]);
  }
});

test('a service-role JWT in widget source is rejected before network', async () => {
  const serviceJwt = [
    Buffer.from('{"alg":"HS256"}').toString('base64url'),
    Buffer.from('{"role":"service_role"}').toString('base64url'),
    Buffer.from('fixture-signature').toString('base64url'),
  ].join('.');
  let requests = 0;
  const summaries = [];
  const code = await main({
    argv, env: { [ROUTE_CLOSURE_SECRET_ENV]: secret },
    widgetSource: `supabaseKey: '${serviceJwt}'`,
    emit: (summary) => summaries.push(summary),
    fetchImpl: async () => { requests++; throw new Error('must not fetch'); },
  });
  assert.equal(code, 2);
  assert.equal(requests, 0);
  assert.deepEqual(summaries, [{ ok: false, status: 'not_run', classification: 'config' }]);
});

test('unexpected status fails immediately without echoing response body or credentials', async () => {
  const summaries = [];
  let requests = 0;
  const code = await main({
    argv, env: { [ROUTE_CLOSURE_SECRET_ENV]: secret }, widgetSource,
    emit: (summary) => summaries.push(summary),
    fetchImpl: async () => {
      requests++;
      return new Response(`sensitive ${secret}`, { status: 200 });
    },
  });
  assert.equal(code, 1);
  assert.equal(requests, 1);
  assert.deepEqual(summaries, [{
    ok: false, status: 'failed', classification: 'unexpected_status',
    checks: [{ function: ROUTE_CLOSURE_FUNCTIONS[0], check: 'missing_secret',
      expected_status: 403, http_status: 200 }],
  }]);
  assert.equal(JSON.stringify(summaries).includes(secret), false);
});

test('verify_jwt=false-like handler response cannot pass the invalid-Bearer gate check', async () => {
  const summaries = [];
  const requests = [];
  const code = await main({
    argv, env: { [ROUTE_CLOSURE_SECRET_ENV]: secret }, widgetSource,
    emit: (summary) => summaries.push(summary),
    fetchImpl: async (url, init) => {
      requests.push({ url, init });
      // The first two are denied by the app secret gate. A closure deployed
      // with verify_jwt=false then reaches the handler and returns 405 here.
      return new Response('', { status: requests.length <= 2 ? 403 : 405 });
    },
  });
  assert.equal(code, 1);
  assert.equal(requests.length, 3);
  assert.equal(requests[2].init.headers.Authorization, 'Bearer invalid-route-qa-jwt');
  assert.equal(requests[2].init.headers.apikey, undefined);
  assert.equal(summaries[0].classification, 'unexpected_status');
  assert.deepEqual(summaries[0].checks.at(-1), {
    function: ROUTE_CLOSURE_FUNCTIONS[0], check: 'invalid_bearer_jwt',
    expected_status: 401, http_status: 405,
  });
});

test('transport failure and timeout abort safely without leaking exception text', async () => {
  const transportSummaries = [];
  const transportCode = await main({
    argv, env: { [ROUTE_CLOSURE_SECRET_ENV]: secret }, widgetSource,
    emit: (summary) => transportSummaries.push(summary),
    fetchImpl: async () => { throw new Error(`unsafe ${secret}`); },
  });
  assert.equal(transportCode, 1);
  assert.equal(transportSummaries[0].classification, 'transport');
  assert.equal(JSON.stringify(transportSummaries).includes(secret), false);

  const timeoutSummaries = [];
  let signal;
  const timeoutCode = await main({
    argv, env: { [ROUTE_CLOSURE_SECRET_ENV]: secret }, widgetSource,
    timeoutMs: 5,
    emit: (summary) => timeoutSummaries.push(summary),
    fetchImpl: async (_url, init) => {
      signal = init.signal;
      return new Promise(() => {});
    },
  });
  assert.equal(timeoutCode, 1);
  assert.equal(signal.aborted, true);
  assert.equal(timeoutSummaries[0].classification, 'transport');
});

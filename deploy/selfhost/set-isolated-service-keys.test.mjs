import assert from 'node:assert/strict';
import test from 'node:test';
import {
  BOUNDARY, KeyEntryError, parseArgs, promptDedicatedKeys,
  setIsolatedServiceKeys, validateDedicatedKeys,
} from './set-isolated-service-keys.mjs';

const ID = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const AUTH = { secret: 'sb_secret_isolated_test', serviceJwt: 'header.body.signature' };
const KEYS = { openrouter: 'new-openrouter-test-key', catalog: 'new-catalog-test-token' };
const BASE = `/rest/v1/app_settings?id=eq.${ID}`;

function reply(status, body, headers = {}) {
  return new Response(body === null ? null : JSON.stringify(body), {
    status, headers: { ...headers, ...(body === null ? {} : { 'Content-Type': 'application/json' }) },
  });
}

function steps() {
  return [
    { method: 'GET', path: '/rest/v1/app_settings?select=id&limit=2',
      response: reply(200, [{ id: ID }]) },
    { method: 'GET', path: `${BASE}&openrouter_api_key=is.null&select=id`,
      response: reply(200, [{ id: ID }]) },
    { method: 'GET', path: `${BASE}&volt220_api_token=is.null&select=id`,
      response: reply(200, [{ id: ID }]) },
    { method: 'PATCH', path: `${BASE}&openrouter_api_key=is.null&volt220_api_token=is.null`,
      response: reply(204, null, { 'Content-Range': '*/1' }) },
    { method: 'GET', path: `${BASE}&openrouter_api_key=not.is.null&select=id`,
      response: reply(200, [{ id: ID }]) },
    { method: 'GET', path: `${BASE}&volt220_api_token=not.is.null&select=id`,
      response: reply(200, [{ id: ID }]) },
  ];
}

function harness(script = steps()) {
  const calls = [];
  return {
    calls,
    async fetchImpl(url, options) {
      const expected = script[calls.length];
      assert.ok(expected, 'unexpected network call');
      assert.equal(url, `${BOUNDARY.gateway}${expected.path}`);
      assert.equal(options.method, expected.method);
      assert.equal(options.redirect, 'error');
      calls.push({ url, options });
      return expected.response;
    },
  };
}

test('requires exact isolated mode; rejects unsafe or identical input', () => {
  assert.equal(parseArgs(['--mode', BOUNDARY.mode, '--confirm', BOUNDARY.confirm]), BOUNDARY);
  for (const bad of [[], ['--mode', 'production', '--confirm', BOUNDARY.confirm],
    ['--mode', BOUNDARY.mode, '--confirm', 'yes']]) {
    assert.throws(() => parseArgs(bad), KeyEntryError);
  }
  for (const bad of [
    { openrouter: '', catalog: 'x' },
    { openrouter: 'has space', catalog: 'x' },
    { openrouter: 'same', catalog: 'same' },
    { openrouter: 'x', catalog: 'y\n' },
  ]) assert.throws(() => validateDedicatedKeys(bad), KeyEntryError);
});

test('one conditional minimal PATCH, then id-only presence verification', async () => {
  const h = harness();
  assert.deepEqual(await setIsolatedServiceKeys({ keys: KEYS, auth: AUTH,
    fetchImpl: h.fetchImpl }), { updatedRows: 1, bothPresent: true });
  assert.equal(h.calls.length, 6);
  const patch = h.calls[3];
  assert.equal(patch.options.headers.Prefer, 'return=minimal,count=exact');
  assert.equal(patch.options.headers.apikey, AUTH.secret);
  assert.equal(patch.options.headers.Authorization, `Bearer ${AUTH.serviceJwt}`);
  assert.deepEqual(JSON.parse(patch.options.body), {
    openrouter_api_key: KEYS.openrouter, volt220_api_token: KEYS.catalog,
  });
  assert.ok(h.calls.every((call) => !call.url.includes(KEYS.openrouter) &&
    !call.url.includes(KEYS.catalog)));
  assert.ok(h.calls.filter((call) => call.options.method === 'GET')
    .every((call) => call.url.includes('select=id')));
});

test('refuses nonempty keys and multiple rows before any write', async () => {
  for (const script of [
    [{ ...steps()[0], response: reply(200, [{ id: ID },
      { id: 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb' }]) }],
    [steps()[0], { ...steps()[1], response: reply(200, []) }],
  ]) {
    const h = harness(script);
    await assert.rejects(() => setIsolatedServiceKeys({ keys: KEYS, auth: AUTH,
      fetchImpl: h.fetchImpl }), KeyEntryError);
    assert.equal(h.calls.filter((call) => call.options.method === 'PATCH').length, 0);
  }
});

test('unknown count/network or partial verification fails closed, never retries', async () => {
  for (const mutation of [
    (s) => { s[3].response = reply(204, null); },
    (s) => { s[3].response = reply(204, null, { 'Content-Range': '*/0' }); },
    (s) => { s[4].response = reply(200, []); },
  ]) {
    const script = steps();
    mutation(script);
    const h = harness(script);
    await assert.rejects(() => setIsolatedServiceKeys({ keys: KEYS, auth: AUTH,
      fetchImpl: h.fetchImpl }), KeyEntryError);
    assert.equal(h.calls.filter((call) => call.options.method === 'PATCH').length, 1);
  }
  const script = steps();
  script[3].response = undefined;
  const h = harness(script);
  await assert.rejects(() => setIsolatedServiceKeys({ keys: KEYS, auth: AUTH,
    fetchImpl: async (url, options) => {
      if (options.method === 'PATCH') throw new Error('opaque network error');
      return h.fetchImpl(url, options);
    } }), { code: 'WRITE_OUTCOME_UNKNOWN' });
});

test('hidden TTY prompts restore echo on success and failure', async () => {
  for (const answers of [
    ['SERVER3', KEYS.openrouter, KEYS.catalog],
    ['SERVER3', KEYS.openrouter, 'bad value'],
  ]) {
    let cursor = 0;
    const stty = [];
    const output = { isTTY: true, write() {} };
    const received = promptDedicatedKeys({
      input: { isTTY: true }, output,
      runStty(args) { stty.push(args[0]); return { status: 0 }; },
      makeReadline() { return {
        async question() { return answers[cursor++]; }, close() {},
      }; },
    });
    if (answers[2] === KEYS.catalog) assert.deepEqual(await received, KEYS);
    else await assert.rejects(() => received, KeyEntryError);
    assert.deepEqual(stty, ['-echo', 'echo']);
  }
});

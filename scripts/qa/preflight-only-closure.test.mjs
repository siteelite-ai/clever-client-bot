import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CLOSURE_PREFLIGHT_ENDPOINT,
  CLOSURE_PREFLIGHT_TIMEOUT_MS,
  main,
} from './preflight-only-closure.mjs';
import { runTrustedChild } from './with-closure-qa-secrets.mjs';

const access = 'a'.repeat(64);
const catalog = 'c'.repeat(64);
const publicKey = 'eyJhbGciOiJIUzI1NiJ9.eyJyb2xlIjoiYW5vbiJ9.cHVibGlj';
const widgetSource = `supabaseKey: '${publicKey}'`;
const env = {
  VOLT220_V3_QA_SECRET: access,
  VOLT220_V3_CATALOG_QA_SECRET: catalog,
};

function readyResponse() {
  return new Response(JSON.stringify({
    ok: true,
    status: 'ready',
    checks: Object.fromEntries(
      ['categories', 'products', 'facets', 'article_filter']
        .map((name) => [name, { status: 'ok', http_status: 200 }]),
    ),
  }), { status: 200 });
}

test('preflight-only child makes exactly one authenticated private catalog probe, not chat', async () => {
  assert.equal(CLOSURE_PREFLIGHT_TIMEOUT_MS, 40_000);
  const requests = [];
  const summaries = [];
  const code = await main({
    env, widgetSource, argv: [], emit: (summary) => summaries.push(summary),
    fetchImpl: async (url, init) => {
      requests.push({ url, init });
      return readyResponse();
    },
  });
  assert.equal(code, 0);
  assert.deepEqual(summaries, [{ ok: true, status: 'ready', http_status: 200 }]);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, CLOSURE_PREFLIGHT_ENDPOINT);
  assert.equal(requests[0].init.method, 'POST');
  assert.equal(requests[0].init.redirect, 'error');
  assert.deepEqual(JSON.parse(requests[0].init.body), { type: 'catalog_health_preflight' });
  assert.equal(requests[0].init.headers.Authorization, `Bearer ${publicKey}`);
  assert.equal(requests[0].init.headers.apikey, publicKey);
  assert.equal(requests[0].init.headers['x-volt-preview-secret'], access);
  assert.equal(requests[0].init.headers['x-catalog-qa-secret'], catalog);
});

test('missing or ambiguous credentials, bad public key and CLI arguments fail before network', async () => {
  const inputs = [
    { env: { VOLT220_V3_CATALOG_QA_SECRET: catalog }, widgetSource },
    { env: { VOLT220_V3_QA_SECRET: 'short', VOLT220_V3_CATALOG_QA_SECRET: catalog }, widgetSource },
    { env: { VOLT220_V3_QA_SECRET: access }, widgetSource },
    { env: { VOLT220_V3_QA_SECRET: access, VOLT220_V3_CATALOG_QA_SECRET: access }, widgetSource },
    { env, widgetSource: 'supabaseKey: "not-a-jwt"' },
    { env, widgetSource, argv: ['--endpoint=https://attacker.invalid'] },
  ];
  for (const input of inputs) {
    let requests = 0;
    const summaries = [];
    const code = await main({
      argv: [], ...input, emit: (summary) => summaries.push(summary),
      fetchImpl: async () => { requests++; throw new Error('network must not be reached'); },
    });
    assert.equal(code, 2);
    assert.equal(requests, 0);
    assert.deepEqual(summaries, [{ ok: false, status: 'not_run', classification: 'config' }]);
  }
});

test('failed and malicious upstream responses cannot leak credentials or response text', async () => {
  const summaries = [];
  const code = await main({
    env, widgetSource, argv: [], emit: (summary) => summaries.push(summary),
    fetchImpl: async () => new Response(JSON.stringify({
      error: `private:${access}:${catalog}`,
      classification: 'https://attacker.invalid',
    }), { status: 503 }),
  });
  assert.equal(code, 1);
  assert.deepEqual(summaries, [{
    ok: false, status: 'unavailable', classification: 'upstream', http_status: 503,
  }]);
  const output = JSON.stringify(summaries);
  assert.equal(output.includes(access), false);
  assert.equal(output.includes(catalog), false);
  assert.equal(output.includes('attacker.invalid'), false);
});

test('the exact CLI is runnable by the restricted short-lived-secret wrapper without paid calls', async () => {
  // A preload replaces fetch before the real CLI starts. Any non-probe request
  // fails; no network or OpenRouter fixture can be reached in this test.
  const preload = `globalThis.fetch = async (url, init) => {
    if (url !== ${JSON.stringify(CLOSURE_PREFLIGHT_ENDPOINT)} ||
      JSON.parse(init.body).type !== 'catalog_health_preflight') {
      throw new Error('unexpected request');
    }
    return new Response(${JSON.stringify(JSON.stringify({
      ok: true, status: 'ready',
      checks: Object.fromEntries(
        ['categories', 'products', 'facets', 'article_filter']
          .map((name) => [name, { status: 'ok', http_status: 200 }]),
      ),
    }))}, { status: 200 });
  };`;
  await runTrustedChild(process.execPath, [
    '--import', `data:text/javascript,${encodeURIComponent(preload)}`,
    'scripts/qa/preflight-only-closure.mjs',
  ], env, { timeoutMs: 3_000 });
});

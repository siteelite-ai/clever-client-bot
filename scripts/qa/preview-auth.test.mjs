import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  isPrivatePreviewEndpoint,
  previewAuthHeaders,
  previewRedirectPolicy,
  redactPreviewSecret,
  PREVIEW_QA_SECRET_ENV,
  PREVIEW_SECRET_ENV,
  PREVIEW_SECRET_HEADER,
} from './preview-auth.mjs';

const base = 'https://yngoixmvmxdfxokuafjp.supabase.co/functions/v1/';
const fixture = 'a'.repeat(32);
const qaFixture = 'b'.repeat(32);

test('only the two private preview URLs receive the server-side header', () => {
  for (const name of ['chat-consultant-v3-preview', 'chat-consultant-v3-closure-preview']) {
    assert.equal(isPrivatePreviewEndpoint(`${base}${name}`), true);
    assert.deepEqual(previewAuthHeaders(`${base}${name}`, { VOLT220_V3_PREVIEW_SECRET: fixture }), {
      [PREVIEW_SECRET_HEADER]: fixture,
    });
    assert.deepEqual(previewRedirectPolicy(`${base}${name}`), { redirect: 'error' });
  }
  for (const name of ['chat-consultant-v3', 'chat-consultant-v3-preview-extra', 'search-products']) {
    assert.equal(isPrivatePreviewEndpoint(`${base}${name}`), false);
    assert.deepEqual(previewAuthHeaders(`${base}${name}`, {}), {});
    assert.deepEqual(previewRedirectPolicy(`${base}${name}`), {});
  }
});

test('private header is never sent to an attacker host or URL with userinfo', () => {
  for (const endpoint of [
    'https://attacker.example/functions/v1/chat-consultant-v3-preview',
    'https://example.supabase.co/functions/v1/chat-consultant-v3-closure-preview',
    'http://yngoixmvmxdfxokuafjp.supabase.co/functions/v1/chat-consultant-v3-preview',
    'https://attacker@yngoixmvmxdfxokuafjp.supabase.co/functions/v1/chat-consultant-v3-preview',
    `${base}chat-consultant-v3-preview?next=https://attacker.example`,
  ]) {
    assert.throws(() => previewAuthHeaders(endpoint, { VOLT220_V3_PREVIEW_SECRET: fixture }), /canonical Supabase/);
    assert.throws(() => previewRedirectPolicy(endpoint), /canonical Supabase/);
  }
});

test('private preview QA refuses to run without an environment secret', () => {
  for (const value of [undefined, '', 'short', 'a'.repeat(257), 'has a space']) {
    assert.throws(
      () => previewAuthHeaders(`${base}chat-consultant-v3-preview`, { VOLT220_V3_PREVIEW_SECRET: value }),
      /environment secret/,
    );
  }
});

test('QA credential takes precedence, while an absent QA credential keeps old behavior', () => {
  const endpoint = `${base}chat-consultant-v3-closure-preview`;
  assert.equal(PREVIEW_SECRET_ENV, 'VOLT220_V3_PREVIEW_SECRET');
  assert.equal(PREVIEW_QA_SECRET_ENV, 'VOLT220_V3_QA_SECRET');
  assert.deepEqual(previewAuthHeaders(endpoint, { [PREVIEW_SECRET_ENV]: fixture }), {
    [PREVIEW_SECRET_HEADER]: fixture,
  });
  assert.deepEqual(previewAuthHeaders(endpoint, {
    [PREVIEW_SECRET_ENV]: fixture,
    [PREVIEW_QA_SECRET_ENV]: qaFixture,
  }), { [PREVIEW_SECRET_HEADER]: qaFixture });
  assert.deepEqual(previewAuthHeaders(endpoint, { [PREVIEW_QA_SECRET_ENV]: qaFixture }), {
    [PREVIEW_SECRET_HEADER]: qaFixture,
  });
});

test('invalid QA credential fails closed instead of falling back to the old secret', () => {
  const endpoint = `${base}chat-consultant-v3-preview`;
  for (const bad of ['', 'short', 'a'.repeat(257), 'has a space', null]) {
    assert.throws(() => previewAuthHeaders(endpoint, {
      [PREVIEW_SECRET_ENV]: fixture,
      [PREVIEW_QA_SECRET_ENV]: bad,
    }), /VOLT220_V3_QA_SECRET environment secret/);
  }
  assert.deepEqual(previewAuthHeaders(`${base}chat-consultant-v3`, {
    [PREVIEW_QA_SECRET_ENV]: qaFixture,
  }), {});
  assert.throws(() => previewAuthHeaders('https://attacker.example/functions/v1/chat-consultant-v3-preview', {
    [PREVIEW_QA_SECRET_ENV]: qaFixture,
  }), /canonical Supabase/);
});

test('acceptance transport uses the private header and refuses redirects', async () => {
  const previousArgv = process.argv;
  const previousSecret = process.env.VOLT220_V3_PREVIEW_SECRET;
  const previousQaSecret = process.env.VOLT220_V3_QA_SECRET;
  process.argv = ['node', 'preview-transport-test', `--endpoint=${base}chat-consultant-v3-preview`];
  process.env.VOLT220_V3_PREVIEW_SECRET = fixture;
  delete process.env.VOLT220_V3_QA_SECRET;
  try {
    const { fetchAcceptanceTurn } = await import(`./run-customer-acceptance.mjs?preview-auth-test=${Date.now()}`);
    const seen = [];
    await fetchAcceptanceTurn({ message: 'test' }, {
      fetchImpl: async (url, init) => {
        seen.push({ url, init });
        return { status: 403, text: async () => '' };
      },
      maxAttempts: 1,
    });
    assert.equal(seen.length, 1);
    assert.equal(seen[0].url, `${base}chat-consultant-v3-preview`);
    assert.equal(seen[0].init.redirect, 'error');
    assert.equal(seen[0].init.headers[PREVIEW_SECRET_HEADER], fixture);
  } finally {
    process.argv = previousArgv;
    if (previousSecret === undefined) delete process.env.VOLT220_V3_PREVIEW_SECRET;
    else process.env.VOLT220_V3_PREVIEW_SECRET = previousSecret;
    if (previousQaSecret === undefined) delete process.env.VOLT220_V3_QA_SECRET;
    else process.env.VOLT220_V3_QA_SECRET = previousQaSecret;
  }
});

test('acceptance transport uses isolated QA credential when configured', async () => {
  const previousArgv = process.argv;
  const previousSecret = process.env.VOLT220_V3_PREVIEW_SECRET;
  const previousQaSecret = process.env.VOLT220_V3_QA_SECRET;
  process.argv = ['node', 'preview-qa-transport-test', `--endpoint=${base}chat-consultant-v3-closure-preview`];
  process.env.VOLT220_V3_PREVIEW_SECRET = fixture;
  process.env.VOLT220_V3_QA_SECRET = qaFixture;
  try {
    const { fetchAcceptanceTurn } = await import(`./run-customer-acceptance.mjs?preview-qa-auth-test=${Date.now()}`);
    const seen = [];
    await fetchAcceptanceTurn({ message: 'test' }, {
      fetchImpl: async (url, init) => {
        seen.push({ url, init });
        return { status: 403, text: async () => '' };
      },
      maxAttempts: 1,
    });
    assert.equal(seen.length, 1);
    assert.equal(seen[0].url, `${base}chat-consultant-v3-closure-preview`);
    assert.equal(seen[0].init.redirect, 'error');
    assert.equal(seen[0].init.headers[PREVIEW_SECRET_HEADER], qaFixture);
  } finally {
    process.argv = previousArgv;
    if (previousSecret === undefined) delete process.env.VOLT220_V3_PREVIEW_SECRET;
    else process.env.VOLT220_V3_PREVIEW_SECRET = previousSecret;
    if (previousQaSecret === undefined) delete process.env.VOLT220_V3_QA_SECRET;
    else process.env.VOLT220_V3_QA_SECRET = previousQaSecret;
  }
});

test('preview response reflection is redacted before it can enter a QA report', () => {
  const headers = previewAuthHeaders(`${base}chat-consultant-v3-preview`, {
    VOLT220_V3_PREVIEW_SECRET: fixture,
    VOLT220_V3_QA_SECRET: qaFixture,
  });
  assert.equal(redactPreviewSecret(`echo:${qaFixture}`, headers), 'echo:[redacted-preview-secret]');
  assert.equal(redactPreviewSecret(`echo:${qaFixture}`, {}), `echo:${qaFixture}`);
});

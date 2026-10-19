import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  isPrivatePreviewEndpoint,
  previewAuthHeaders,
  previewRedirectPolicy,
  redactPreviewSecret,
  PREVIEW_SECRET_HEADER,
} from './preview-auth.mjs';

const base = 'https://yngoixmvmxdfxokuafjp.supabase.co/functions/v1/';
const fixture = 'a'.repeat(32);

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

test('acceptance transport uses the private header and refuses redirects', async () => {
  const previousArgv = process.argv;
  const previousSecret = process.env.VOLT220_V3_PREVIEW_SECRET;
  process.argv = ['node', 'preview-transport-test', `--endpoint=${base}chat-consultant-v3-preview`];
  process.env.VOLT220_V3_PREVIEW_SECRET = fixture;
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
  }
});

test('preview response reflection is redacted before it can enter a QA report', () => {
  const headers = previewAuthHeaders(`${base}chat-consultant-v3-preview`, {
    VOLT220_V3_PREVIEW_SECRET: fixture,
  });
  assert.equal(redactPreviewSecret(`echo:${fixture}`, headers), 'echo:[redacted-preview-secret]');
  assert.equal(redactPreviewSecret(`echo:${fixture}`, {}), `echo:${fixture}`);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AttestationError,
  MANAGEMENT_URL,
  PREVIEW_SLUGS,
  PUBLIC_SLUGS,
  PROJECT_REF,
  parseManifest,
  readManifest,
  verifyPreviewBundles,
} from './verify-preview-bundles.mjs';

const SOURCE_SHA = 'a'.repeat(40);
const HEAD_SHA = 'b'.repeat(40);
const WIDGET_VERSION = 'widget-0123456789abcdef';
const TOKEN = 'never-print-this-management-PAT';

function fixture() {
  const manifest = {
    schemaVersion: 1,
    projectRef: PROJECT_REF,
    runtime_source_commit_sha: SOURCE_SHA,
    widgetVersion: WIDGET_VERSION,
    previewFunctions: Object.fromEntries(PREVIEW_SLUGS.map((slug, i) => [slug, {
      version: 101 + i,
      ezbr_sha256: String(i + 1).repeat(64),
      verify_jwt: true,
    }])),
    publicFunctions: Object.fromEntries(PUBLIC_SLUGS.map((slug, i) => [slug, {
      version: 501 + i,
      ezbr_sha256: String(i + 5).repeat(64),
    }])),
  };
  const remote = [
    ...PREVIEW_SLUGS.map((slug) => ({
      slug, status: 'ACTIVE', ...manifest.previewFunctions[slug],
    })),
    ...PUBLIC_SLUGS.map((slug) => ({
      slug, status: 'ACTIVE', ...manifest.publicFunctions[slug], verify_jwt: false,
    })),
  ];
  return { manifest, remote };
}

function jsonResponse(payload, init = {}) {
  return new Response(JSON.stringify(payload), {
    status: init.status ?? 200,
    headers: { 'content-type': 'application/json', ...init.headers },
  });
}

function options(remote, overrides = {}) {
  return {
    token: TOKEN,
    getGitHead: async () => HEAD_SHA,
    isRuntimeUnchanged: async (source, head) => {
      assert.equal(source, SOURCE_SHA);
      assert.equal(head, HEAD_SHA);
      return true;
    },
    getWidgetVersion: async () => WIDGET_VERSION,
    fetchImpl: async (url, init) => {
      assert.equal(url, MANAGEMENT_URL);
      assert.equal(init.method, 'GET');
      assert.equal(init.redirect, 'error');
      assert.equal(init.cache, 'no-store');
      assert.equal(init.headers.Authorization, `Bearer ${TOKEN}`);
      return jsonResponse(remote);
    },
    ...overrides,
  };
}

test('all eight exact bundles and local runtime source match', async () => {
  const { manifest, remote } = fixture();
  const actual = await verifyPreviewBundles(manifest, options(remote));
  assert.deepEqual(actual, { ok: true, failures: [] });
});

test('a stale preview version and SHA both fail without dumping values', async () => {
  const { manifest, remote } = fixture();
  remote[0].version -= 1;
  remote[0].ezbr_sha256 = 'f'.repeat(64);
  const actual = await verifyPreviewBundles(manifest, options(remote));
  assert.deepEqual(actual.failures, [
    { code: 'PREVIEW_VERSION_MISMATCH', slug: PREVIEW_SLUGS[0] },
    { code: 'PREVIEW_SHA_MISMATCH', slug: PREVIEW_SLUGS[0] },
  ]);
  assert.equal(actual.ok, false);
  assert.equal(JSON.stringify(actual).includes(TOKEN), false);
});

test('a changed public production function baseline fails', async () => {
  const { manifest, remote } = fixture();
  remote[PREVIEW_SLUGS.length].ezbr_sha256 = 'f'.repeat(64);
  const actual = await verifyPreviewBundles(manifest, options(remote));
  assert.deepEqual(actual.failures, [
    { code: 'PUBLIC_SHA_MISMATCH', slug: PUBLIC_SLUGS[0] },
  ]);
});

test('preview verify_jwt=false fails even when version and SHA match', async () => {
  const { manifest, remote } = fixture();
  remote[2].verify_jwt = false;
  const actual = await verifyPreviewBundles(manifest, options(remote));
  assert.deepEqual(actual.failures, [
    { code: 'PREVIEW_JWT_DISABLED', slug: PREVIEW_SLUGS[2] },
  ]);
});

test('wrong or dirty local runtime HEAD fails before network', async () => {
  const { manifest, remote } = fixture();
  let fetched = false;
  await assert.rejects(
    verifyPreviewBundles(manifest, options(remote, {
      isRuntimeUnchanged: async (source, head) => {
        assert.equal(source, SOURCE_SHA);
        assert.equal(head, HEAD_SHA);
        return false;
      },
      fetchImpl: async () => { fetched = true; throw new Error('should not fetch'); },
    })),
    (error) => error instanceof AttestationError && error.code === 'LOCAL_RUNTIME_DRIFT',
  );
  assert.equal(fetched, false);
});

test('changed local widget version fails before network', async () => {
  const { manifest, remote } = fixture();
  await assert.rejects(
    verifyPreviewBundles(manifest, options(remote, {
      getWidgetVersion: async () => 'widget-ffffffffffffffff',
      fetchImpl: async () => { throw new Error('should not fetch'); },
    })),
    (error) => error.code === 'LOCAL_WIDGET_VERSION_MISMATCH',
  );
});

test('malformed manifests fail closed before network', async () => {
  const { manifest, remote } = fixture();
  assert.throws(() => parseManifest('{not-json'), { code: 'MANIFEST_INVALID_JSON' });
  assert.throws(() => parseManifest({ ...manifest, unexpected: true }), { code: 'MANIFEST_SCHEMA_INVALID' });
  const missingPreview = structuredClone(manifest);
  delete missingPreview.previewFunctions[PREVIEW_SLUGS[0]];
  assert.throws(() => parseManifest(missingPreview), { code: 'MANIFEST_SCHEMA_INVALID' });
  const weakJwt = structuredClone(manifest);
  weakJwt.previewFunctions[PREVIEW_SLUGS[0]].verify_jwt = false;
  assert.throws(() => parseManifest(weakJwt), { code: 'MANIFEST_PREVIEW_INVALID' });
  const badPublicSha = structuredClone(manifest);
  badPublicSha.publicFunctions[PUBLIC_SLUGS[0]].ezbr_sha256 = 'nope';
  assert.throws(() => parseManifest(badPublicSha), { code: 'MANIFEST_PUBLIC_INVALID' });
  let fetched = false;
  await assert.rejects(verifyPreviewBundles(weakJwt, options(remote, {
    fetchImpl: async () => { fetched = true; return jsonResponse(remote); },
  })), { code: 'MANIFEST_PREVIEW_INVALID' });
  assert.equal(fetched, false);
});

test('manifest path allows only a direct docs/qa JSON and never prints input', async () => {
  for (const path of ['../secrets.json', 'docs/qa/../private.json', '/tmp/test.json',
    'docs/qa/subdir/test.json', `docs/qa/${TOKEN}.txt`]) {
    await assert.rejects(readManifest(path), (error) =>
      error.code === 'MANIFEST_PATH_INVALID' && !error.message.includes(TOKEN));
  }
});

test('transport and server errors redact token and response body', async () => {
  const { manifest, remote } = fixture();
  for (const fetchImpl of [
    async () => { throw new Error(`${TOKEN} was in the transport error`); },
    async () => jsonResponse({ error: TOKEN }, { status: 403 }),
    async () => jsonResponse({ error: TOKEN }, { status: 302 }),
  ]) {
    await assert.rejects(verifyPreviewBundles(manifest, options(remote, { fetchImpl })),
      (error) => error instanceof AttestationError &&
        !error.message.includes(TOKEN) && !JSON.stringify(error).includes(TOKEN));
  }
});

test('oversized, malformed, duplicate and missing metadata fail closed', async () => {
  const { manifest, remote } = fixture();
  const tooLarge = jsonResponse({ data: 'x'.repeat(1024 * 1024) });
  await assert.rejects(verifyPreviewBundles(manifest, options(remote, {
    fetchImpl: async () => tooLarge,
  })), { code: 'MANAGEMENT_RESPONSE_TOO_LARGE' });
  await assert.rejects(verifyPreviewBundles(manifest, options(remote, {
    fetchImpl: async () => jsonResponse({ functions: remote }),
  })), { code: 'MANAGEMENT_RESPONSE_INVALID' });
  await assert.rejects(verifyPreviewBundles(manifest, options(remote, {
    fetchImpl: async () => jsonResponse([...remote, remote[0]]),
  })), { code: 'MANAGEMENT_DUPLICATE_FUNCTION' });
  const absent = await verifyPreviewBundles(manifest, options(remote.slice(1)));
  assert.deepEqual(absent.failures, [{ code: 'PREVIEW_NOT_ACTIVE', slug: PREVIEW_SLUGS[0] }]);
});

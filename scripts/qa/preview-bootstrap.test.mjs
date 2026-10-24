import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const functions = new URL('../../supabase/functions/', import.meta.url);
const read = (name) => readFileSync(new URL(name, functions), 'utf8');

for (const [name, expectedVariant] of [
  ['chat-consultant-v3-preview', true],
  ['chat-consultant-v3-closure-preview', false],
]) {
  test(`${name} statically bundles v3 after its isolate-local bootstrap`, () => {
    const entry = read(`${name}/index.ts`);
    const imports = [...entry.matchAll(/^import\s+"([^"]+)";?$/gm)]
      .map((match) => match[1]);
    assert.deepEqual(imports, ['./bootstrap.ts', '../chat-consultant-v3/index.ts']);
    assert.doesNotMatch(entry, /\bawait\s+import\s*\(/,
      'Lovable does not bundle the sibling function behind a runtime import');

    const bootstrap = read(`${name}/bootstrap.ts`);
    assert.match(bootstrap, /__VOLT220_ADMISSION_SCOPE__\s*=\s*"preview"/);
    assert.equal(/__VOLT220_FUNCTION_VARIANT__\s*=\s*"preview"/.test(bootstrap),
      expectedVariant,
      'the closure lane must keep the production provider policy');
  });
}

test('shared v3 rejects untrusted preview POST before parsing or paid work', () => {
  const handler = read('chat-consultant-v3/index.ts');
  const serve = handler.lastIndexOf('Deno.serve(async (req) => {');
  const options = handler.indexOf('if (req.method === "OPTIONS")', serve);
  const gate = handler.indexOf('if (ADMISSION_SCOPE === "preview" && !await previewSecretAuthorized(', serve);
  const bodyRead = handler.indexOf('readRequestTextBounded(req)', serve);
  const dbClient = handler.indexOf('createClient(SUPABASE_URL, SERVICE_ROLE_KEY', serve);
  assert(serve >= 0 && options > serve && gate > options && bodyRead > gate && dbClient > gate);
  assert.match(handler, /req\.headers\.get\(PREVIEW_SECRET_HEADER\)/);
  assert.match(handler, /Deno\.env\.get\(PREVIEW_SECRET_ENV\)/);
  assert.match(handler.slice(gate, bodyRead), /status: 403/);
});

test('temporary closure QA secrets remain isolate-local, additive, and use existing private headers', () => {
  const closure = read('chat-consultant-v3-closure-preview/bootstrap.ts');
  const ordinary = read('chat-consultant-v3-preview/bootstrap.ts');
  const handler = read('chat-consultant-v3/index.ts');
  const gate = read('_shared/v3-tools/preview-secret-gate.ts');
  assert.match(closure, /__VOLT220_CLOSURE_TEST_SCOPE__\s*=\s*"closure_preview"/);
  assert.doesNotMatch(ordinary, /__VOLT220_CLOSURE_TEST_SCOPE__/);
  assert.doesNotMatch(handler, /\.__VOLT220_CLOSURE_TEST_SCOPE__\s*=/);
  assert.match(gate, /admissionScope === "preview" && closureMarker === "closure_preview"/);
  assert.match(handler, /readClosureTestSecret\(\s*"access", ADMISSION_SCOPE, CLOSURE_TEST_MARKER, suppliedPreviewSecret/);
  assert.equal((handler.match(/readClosureTestSecret\(\s*"catalog", ADMISSION_SCOPE, CLOSURE_TEST_MARKER,/g) ?? []).length, 2);
  assert.match(gate, /V3_CLOSURE_ACCESS_/);
  assert.match(gate, /V3_CLOSURE_CATALOG_/);
  assert.doesNotMatch(gate, /VOLT220_V3_CLOSURE_TEST_ACCESS|VOLT220_V3_CLOSURE_TEST_CATALOG/);
  assert.match(handler, /req\.headers\.get\(PREVIEW_SECRET_HEADER\)/);
  assert.match(handler, /req\.headers\.get\(CATALOG_QA_SECRET_HEADER\)/);
  assert.doesNotMatch(gate, /x-volt-closure-test-access|x-closure-catalog-secret/);
});

test('verified facts rollout follows the isolated preview lane, independent of provider variant', () => {
  const handler = read('chat-consultant-v3/index.ts');
  assert.match(handler, /const VERIFIED_MANUFACTURER_FACTS_ENABLED\s*=\s*verifiedManufacturerFactsEnabled\(\s*ADMISSION_SCOPE\s*,?\s*\)/);
  assert.doesNotMatch(handler, /const VERIFIED_MANUFACTURER_FACTS_ENABLED\s*=\s*DEPLOYMENT_VARIANT/);
});

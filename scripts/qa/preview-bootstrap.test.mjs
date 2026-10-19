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

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

const require = createRequire(import.meta.url);
const sourcePath = fileURLToPath(new URL('../../supabase/functions/knowledge-process/index.ts', import.meta.url));
const source = readFileSync(sourcePath, 'utf8');
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;

function createHarness({ lovableKey } = {}) {
  let handler;
  const calls = { serviceClients: 0, embeddings: 0, pdfGateway: 0, inserts: [], deletes: [] };
  const pending = [];
  const values = {
    SUPABASE_URL: 'https://isolated-test.supabase.example',
    SUPABASE_ANON_KEY: 'synthetic-anon-key',
    SUPABASE_SERVICE_ROLE_KEY: 'synthetic-service-key',
    ...(lovableKey ? { LOVABLE_API_KEY: lovableKey } : {}),
  };

  const database = {
    from(table) {
      const query = {
        mode: 'select',
        value: null,
        select() { return this; },
        order() { return this; },
        limit() { return this; },
        eq() { return this; },
        delete() { this.mode = 'delete'; return this; },
        insert(value) { this.mode = 'insert'; this.value = value; return this; },
        range() { return Promise.resolve({ data: [], error: null }); },
        single() {
          if (table === 'app_settings') {
            return Promise.resolve({ data: { openrouter_api_key: 'synthetic-openrouter-key' }, error: null });
          }
          if (table === 'knowledge_entries' && this.mode === 'insert') {
            const data = {
              id: 'synthetic-entry-id',
              ...this.value,
              created_at: '2026-01-01T00:00:00Z',
            };
            calls.inserts.push(data);
            return Promise.resolve({ data, error: null });
          }
          throw new Error(`Unexpected single() on ${table}/${this.mode}`);
        },
        then(resolve, reject) {
          if (this.mode === 'delete') calls.deletes.push(table);
          const result = { data: [], error: null };
          return Promise.resolve(result).then(resolve, reject);
        },
      };
      return query;
    },
  };

  const context = {
    console: { log() {}, warn() {}, error() {} },
    Deno: { env: { get: (name) => values[name] } },
    EdgeRuntime: { waitUntil(promise) { pending.push(promise); } },
    Request,
    Response,
    fetch: async (url) => {
      if (url === 'https://openrouter.ai/api/v1/embeddings') {
        calls.embeddings++;
        return Response.json({ data: [{ embedding: [0.1, 0.2, 0.3] }] });
      }
      if (url === 'https://ai.gateway.lovable.dev/v1/chat/completions') {
        calls.pdfGateway++;
        return Response.json({ choices: [{ message: { content: 'PDF заголовок\n' + 'Документ '.repeat(10) } }] });
      }
      throw new Error(`Unexpected network call: ${url}`);
    },
    exports: {},
    require(specifier) {
      if (specifier === 'https://deno.land/std@0.168.0/http/server.ts') {
        return { serve(callback) { handler = callback; } };
      }
      if (specifier === 'https://esm.sh/@supabase/supabase-js@2') {
        return {
          createClient(_url, key) {
            if (key === values.SUPABASE_SERVICE_ROLE_KEY) calls.serviceClients++;
            return database;
          },
        };
      }
      if (specifier === './authorization.ts') {
        return {
          bearerToken: (header) => header === 'Bearer synthetic-user-token' ? 'synthetic-user-token' : null,
          authorizeKnowledgeUser: async () => ({ allowed: true, userId: 'synthetic-admin-id' }),
        };
      }
      return require(specifier);
    },
  };
  runInNewContext(compiled, context, { filename: sourcePath });
  assert.equal(typeof handler, 'function', 'knowledge-process handler should be registered');

  return {
    calls,
    async invoke(body, authorized = true) {
      const response = await handler(new Request('https://isolated-test.supabase.example/functions/v1/knowledge-process', {
        method: 'POST',
        headers: authorized ? { Authorization: 'Bearer synthetic-user-token' } : {},
        body: JSON.stringify(body),
      }));
      await Promise.all(pending);
      return { status: response.status, body: await response.json() };
    },
  };
}

test('without Lovable key, normal list and delete actions pass the key gate', async () => {
  const harness = createHarness();
  const listed = await harness.invoke({ action: 'list' });
  assert.equal(listed.status, 200);
  assert.equal(listed.body.success, true);
  assert.deepEqual(Array.from(listed.body.entries), []);

  const deleted = await harness.invoke({ action: 'delete', entryId: 'synthetic-entry-id' });
  assert.equal(deleted.status, 200);
  assert.equal(deleted.body.success, true);
  assert.ok(harness.calls.deletes.includes('knowledge_entries'));
  assert.equal(harness.calls.pdfGateway, 0);
});

test('without Lovable key, both text and browser-extracted PDF use add_text', async () => {
  const harness = createHarness();
  for (const entryType of ['text', 'pdf']) {
    const result = await harness.invoke({
      action: 'add_text',
      title: `${entryType} title`,
      text: 'Knowledge content long enough to index.',
      entryType,
    });
    assert.equal(result.status, 200);
    assert.equal(result.body.success, true);
  }
  assert.deepEqual(harness.calls.inserts.map((entry) => entry.type), ['text', 'pdf']);
  assert.equal(harness.calls.pdfGateway, 0);
  assert.ok(harness.calls.embeddings >= 2);
});

test('legacy process_pdf fails clearly without Lovable key, before external requests or writes', async () => {
  const harness = createHarness();
  const result = await harness.invoke({ action: 'process_pdf', pdfBase64: 'synthetic-base64' });
  assert.equal(result.status, 400);
  assert.equal(result.body.success, false);
  assert.match(result.body.error, /LOVABLE_API_KEY не настроен/);
  assert.match(result.body.error, /Загрузите PDF через кабинет/);
  assert.equal(harness.calls.embeddings, 0);
  assert.equal(harness.calls.pdfGateway, 0);
  assert.equal(harness.calls.inserts.length, 0);
});

test('configured legacy process_pdf still reaches its existing PDF extraction path', async () => {
  const harness = createHarness({ lovableKey: 'synthetic-lovable-key' });
  const result = await harness.invoke({ action: 'process_pdf', pdfBase64: 'synthetic-base64' });
  assert.equal(result.status, 200);
  assert.equal(result.body.success, true);
  assert.equal(harness.calls.pdfGateway, 1);
  assert.equal(harness.calls.inserts[0].type, 'pdf');
});

test('the authorization gate still rejects missing bearer token before service-role access', async () => {
  const harness = createHarness();
  const result = await harness.invoke({ action: 'list' }, false);
  assert.equal(result.status, 401);
  assert.equal(harness.calls.serviceClients, 0);
});

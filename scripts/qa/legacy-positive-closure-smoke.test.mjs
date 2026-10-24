import test from 'node:test';
import assert from 'node:assert/strict';
import { main, runPositiveSmoke } from './legacy-positive-closure-smoke.mjs';

const REF = 'yngoixmvmxdfxokuafjp';
const SECRET = `${Math.floor(Date.now() / 1000)}_${'a'.repeat(32)}_${'B'.repeat(64)}`;
const PAYLOAD = Buffer.from(JSON.stringify({ role: 'anon', ref: REF })).toString('base64url');
const ANON = `e30.${PAYLOAD}.e30`;
const WIDGET = `const settings = { supabaseKey: '${ANON}' };`;
const V2_SSE = [
  'data: {"slot_update":{"slots":[]}}',
  'data: {"choices":[{"delta":{"content":"Чем помочь?"}}]}',
  'data: {"meta":{"pipeline_version":"v2","route":"S_GREETING","branch_executed":"real"}}',
  'data: [DONE]',
  '',
].join('\n\n');

function fakeSuccessFetch(seen) {
  return async (url, init) => {
    seen.push({ url, init });
    if (url.endsWith('/chat-consultant-v2-closure-preview')) {
      return new Response(V2_SSE, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
    }
    if (url.endsWith('/search-products-closure-preview')) {
      return Response.json({ results: [{ id: 123, pagetitle: 'Кабель ВВГ' }], pagination: { total: 1 } });
    }
    return Response.json({ content: 'Здравствуйте! Чем помочь?' });
  };
}

test('positive smoke uses three fixed protected routes, minimal bodies, and no arbitrary URL', async () => {
  const seen = [];
  const result = await runPositiveSmoke({ secret: SECRET, widgetSource: WIDGET, fetchImpl: fakeSuccessFetch(seen) });
  assert.equal(result.ok, true);
  assert.deepEqual(seen.map((item) => item.url), [
    `https://${REF}.supabase.co/functions/v1/chat-consultant-v2-closure-preview`,
    `https://${REF}.supabase.co/functions/v1/search-products-closure-preview`,
    `https://${REF}.supabase.co/functions/v1/chat-consultant-closure-preview`,
  ]);
  const bodies = seen.map((item) => JSON.parse(item.init.body));
  assert.match(bodies[0].conversationId,
    /^route-positive-smoke-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.deepEqual({ ...bodies[0], conversationId: null },
    { conversationId: null, query: 'Здравствуйте' });
  assert.deepEqual(bodies[1],
    { action: 'search', query: 'кабель ВВГ', page: 1, perPage: 1 });
  assert.match(bodies[2].sessionId, /^route-positive-smoke-[0-9a-f-]{36}$/);
  assert.notEqual(bodies[0].conversationId, bodies[2].sessionId);
  assert.deepEqual({ ...bodies[2], sessionId: null },
    { message: 'Здравствуйте', stream: false, sessionId: null });
  for (const item of seen) {
    assert.equal(item.init.method, 'POST');
    assert.equal(item.init.redirect, 'error');
    assert.equal(item.init.headers['x-volt220-route-qa-secret'], SECRET);
    assert.equal(item.init.headers.Authorization, `Bearer ${ANON}`);
  }
  assert.equal(JSON.stringify(result).includes(SECRET), false);
  assert.equal(JSON.stringify(result).includes(ANON), false);
});

test('wrong project ref and non-anon widget JWT fail before any network request', async () => {
  let calls = 0;
  const fetchImpl = async () => { calls++; throw new Error(SECRET); };
  const wrongRef = await runPositiveSmoke({
    secret: SECRET, projectRef: 'attacker.example', widgetSource: WIDGET, fetchImpl,
  });
  assert.equal(wrongRef.status, 'not_run');
  const userJwt = WIDGET.replace(ANON, `e30.${Buffer.from(JSON.stringify({ role: 'service_role', ref: REF })).toString('base64url')}.e30`);
  const wrongRole = await runPositiveSmoke({ secret: SECRET, widgetSource: userJwt, fetchImpl });
  assert.equal(wrongRole.status, 'not_run');
  assert.equal(calls, 0);
});

test('HTTP errors and untrusted provider body are not printed and prevent later paid V1', async () => {
  const seen = [];
  const fetchImpl = async (url, init) => {
    seen.push(url);
    if (seen.length === 1) return fakeSuccessFetch([])(url, init);
    return new Response(`token=${SECRET} ${ANON}`, { status: 503 });
  };
  const result = await runPositiveSmoke({ secret: SECRET, widgetSource: WIDGET, fetchImpl });
  assert.equal(result.ok, false);
  assert.equal(result.classification, 'unexpected_status');
  assert.equal(result.failed_function, 'search-products-closure-preview');
  assert.equal(seen.length, 2);
  assert.equal(JSON.stringify(result).includes(SECRET), false);
  assert.equal(JSON.stringify(result).includes(ANON), false);
});

test('200 malformed V2 stream and oversized body fail closed without exposing content', async () => {
  const malformed = await runPositiveSmoke({
    secret: SECRET, widgetSource: WIDGET,
    fetchImpl: async () => new Response(`data: ${SECRET}\n\ndata: [DONE]\n\n`, {
      headers: { 'Content-Type': 'text/event-stream' },
    }),
  });
  assert.equal(malformed.classification, 'response_shape');
  assert.equal(malformed.failed_function, 'chat-consultant-v2-closure-preview');
  assert.equal(JSON.stringify(malformed).includes(SECRET), false);
  const oversized = await runPositiveSmoke({
    secret: SECRET, widgetSource: WIDGET,
    fetchImpl: async () => new Response('x'.repeat(128 * 1024 + 1), {
      headers: { 'Content-Type': 'text/event-stream' },
    }),
  });
  assert.equal(oversized.classification, 'response_shape');
});

test('200 empty catalog and 200 legacy error body cannot pass the positive smoke', async () => {
  const emptyCatalog = await runPositiveSmoke({
    secret: SECRET, widgetSource: WIDGET,
    fetchImpl: async (url, init) => url.endsWith('/search-products-closure-preview')
      ? Response.json({ results: [], pagination: { total: 0 } })
      : fakeSuccessFetch([])(url, init),
  });
  assert.equal(emptyCatalog.classification, 'response_shape');
  assert.equal(emptyCatalog.failed_function, 'search-products-closure-preview');
  assert.equal(emptyCatalog.checks.length, 2);
  const legacyError = await runPositiveSmoke({
    secret: SECRET, widgetSource: WIDGET,
    fetchImpl: async (url, init) => url.endsWith('/chat-consultant-closure-preview')
      ? Response.json({ error: SECRET, content: '' })
      : fakeSuccessFetch([])(url, init),
  });
  assert.equal(legacyError.classification, 'response_shape');
  assert.equal(legacyError.failed_function, 'chat-consultant-closure-preview');
  assert.equal(legacyError.shape_reason, 'error_field');
  assert.equal(legacyError.checks.length, 3);
  assert.equal(JSON.stringify(legacyError).includes(SECRET), false);
});

test('V1 failure exposes only one fixed diagnostic code, never response material', async () => {
  const cases = [
    [new Response('{"content":"ok"}', { headers: { 'Content-Type': 'text/plain' } }), 'content_type_mismatch'],
    [new Response(`not-json:${SECRET}`, { headers: { 'Content-Type': 'application/json' } }), 'invalid_json'],
    [Response.json({ other: SECRET }), 'missing_content'],
    [Response.json({ content: '   ' }), 'empty_content'],
    [Response.json({ content: 'ok', error: SECRET }), 'error_field'],
    [Response.json({ content: 'ok', duplicate: true }), 'duplicate'],
    [Response.json({ content: 42 }), 'other_shape'],
  ];
  for (const [v1Response, reason] of cases) {
    const result = await runPositiveSmoke({
      secret: SECRET, widgetSource: WIDGET,
      fetchImpl: async (url, init) => url.endsWith('/chat-consultant-closure-preview')
        ? v1Response : fakeSuccessFetch([])(url, init),
    });
    assert.equal(result.ok, false);
    assert.equal(result.failed_function, 'chat-consultant-closure-preview');
    assert.equal(result.shape_reason, reason);
    assert.equal(JSON.stringify(result).includes(SECRET), false);
  }
});

test('V1 accepts both direct JSON and bounded heartbeat-wrapped JSON SSE', async () => {
  const json = JSON.stringify({ content: 'Здравствуйте! Чем помочь?' });
  const responses = [
    Response.json({ content: 'Здравствуйте! Чем помочь?' }),
    new Response(`: keepalive\n\n: keepalive\n\ndata: ${json}\n\ndata: [DONE]\n\n`, {
      headers: { 'Content-Type': 'text/event-stream; charset=utf-8' },
    }),
  ];
  for (const v1Response of responses) {
    const result = await runPositiveSmoke({
      secret: SECRET, widgetSource: WIDGET,
      fetchImpl: async (url, init) => url.endsWith('/chat-consultant-closure-preview')
        ? v1Response : fakeSuccessFetch([])(url, init),
    });
    assert.equal(result.ok, true);
    assert.equal(result.checks.length, 3);
  }
});

test('V1 heartbeat SSE requires one valid JSON data event and terminal DONE', async () => {
  const errorJson = JSON.stringify({ error: SECRET });
  const duplicateJson = JSON.stringify({ content: 'ok', duplicate: true });
  const cases = [
    [`: keepalive\n\ndata: ${errorJson}\n\ndata: [DONE]\n\n`, 'error_field'],
    [`data: ${duplicateJson}\n\ndata: [DONE]\n\n`, 'duplicate'],
    [`data: {"content":"ok"}\n\n`, 'other_shape'],
    [`data: {"content":"ok"}\n\ndata: {"content":"again"}\n\ndata: [DONE]\n\n`, 'other_shape'],
    [`data: not-json-${SECRET}\n\ndata: [DONE]\n\n`, 'invalid_json'],
    [`data: {"content":"ok"}\n\ndata: [DONE]\n\ndata: {"content":"late"}\n\n`, 'other_shape'],
  ];
  for (const [body, reason] of cases) {
    const result = await runPositiveSmoke({
      secret: SECRET, widgetSource: WIDGET,
      fetchImpl: async (url, init) => url.endsWith('/chat-consultant-closure-preview')
        ? new Response(body, { headers: { 'Content-Type': 'text/event-stream' } })
        : fakeSuccessFetch([])(url, init),
    });
    assert.equal(result.ok, false);
    assert.equal(result.failed_function, 'chat-consultant-closure-preview');
    assert.equal(result.shape_reason, reason);
    assert.equal(JSON.stringify(result).includes(SECRET), false);
  }
});

test('search may return more than requested perPage without false failure', async () => {
  const seen = [];
  const fetchImpl = async (url, init) => {
    if (url.endsWith('/search-products-closure-preview')) {
      seen.push(JSON.parse(init.body));
      return Response.json({
        results: [
          { id: 'a', pagetitle: 'Кабель ВВГ 2×1,5' },
          { id: 'b', pagetitle: 'Кабель ВВГ 3×1,5' },
        ],
        pagination: { total: 50 },
      });
    }
    return fakeSuccessFetch([])(url, init);
  };
  const result = await runPositiveSmoke({ secret: SECRET, widgetSource: WIDGET, fetchImpl });
  assert.equal(result.ok, true);
  assert.equal(seen[0].perPage, 1);
});

test('main emits only allowlisted status after wrapper returns cleanup result', async () => {
  let unblock;
  const gate = new Promise((resolve) => { unblock = resolve; });
  const outputs = [];
  const task = main({
    argv: [`--project-ref=${REF}`], env: { SUPABASE_ACCESS_TOKEN: 't'.repeat(32) },
    widgetSource: WIDGET, fetchImpl: fakeSuccessFetch([]),
    withSecretImpl: async ({ projectRef, token, runChild }) => {
      assert.equal(projectRef, REF);
      assert.equal(token, 't'.repeat(32));
      const result = await runChild(SECRET);
      await gate;
      return { ...result, injected: SECRET };
    },
    emit: (value) => outputs.push(value),
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(outputs, []);
  unblock();
  assert.equal(await task, 0);
  assert.equal(outputs.length, 1);
  assert.equal(outputs[0].secret_cleanup, 'verified');
  assert.equal(JSON.stringify(outputs).includes(SECRET), false);
});

test('main fails closed for invalid CLI config and wrapper cleanup failure', async () => {
  const outputs = [];
  const base = {
    env: { SUPABASE_ACCESS_TOKEN: 't'.repeat(32) },
    widgetSource: WIDGET, fetchImpl: fakeSuccessFetch([]),
    emit: (value) => outputs.push(value),
  };
  let called = false;
  assert.equal(await main({ ...base, argv: [`--project-ref=${REF}`, '--url=https://evil.invalid'],
    withSecretImpl: async () => { called = true; },
  }), 2);
  assert.equal(called, false);
  assert.deepEqual(outputs[0], { ok: false, status: 'not_run', classification: 'config' });
  assert.equal(await main({ ...base, argv: [`--project-ref=${REF}`],
    withSecretImpl: async () => { throw new Error(SECRET); },
  }), 1);
  assert.deepEqual(outputs[1], { ok: false, status: 'not_run', classification: 'orchestration' });
  assert.equal(JSON.stringify(outputs).includes(SECRET), false);
});

test('main sanitizes V1 diagnostic and rejects arbitrary diagnostic strings', async () => {
  const outputs = [];
  const base = {
    argv: [`--project-ref=${REF}`], env: { SUPABASE_ACCESS_TOKEN: 't'.repeat(32) },
    widgetSource: WIDGET, emit: (value) => outputs.push(value),
    fetchImpl: async (url, init) => url.endsWith('/chat-consultant-closure-preview')
      ? Response.json({ content: '' }) : fakeSuccessFetch([])(url, init),
  };
  assert.equal(await main({ ...base,
    withSecretImpl: async ({ runChild }) => runChild(SECRET),
  }), 1);
  assert.equal(outputs[0].failed_function, 'chat-consultant-closure-preview');
  assert.equal(outputs[0].shape_reason, 'empty_content');
  assert.equal(outputs[0].secret_cleanup, 'verified');
  assert.equal(await main({ ...base,
    withSecretImpl: async ({ runChild }) => ({ ...await runChild(SECRET), shape_reason: SECRET }),
  }), 1);
  assert.deepEqual(outputs[1], { ok: false, status: 'not_run', classification: 'orchestration' });
  assert.equal(JSON.stringify(outputs).includes(SECRET), false);
});

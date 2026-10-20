import { assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import type { PublicApiAdmissionRpc } from '../_shared/public-api-admission.ts';
import { handleChatConsultant, parseLegacyChatBody } from './index.ts';

const URL = 'https://example.supabase.co/functions/v1/chat-consultant';
const LIMITS = {
  PUBLIC_API_ADMISSION_MODE: 'enforce',
  PUBLIC_API_MODEL_LIMIT_PER_MINUTE: '8',
  PUBLIC_API_MODEL_LIMIT_IN_FLIGHT: '3',
  PUBLIC_API_CATALOG_LIMIT_PER_MINUTE: '20',
  PUBLIC_API_CATALOG_LIMIT_IN_FLIGHT: '5',
};
const readEnv = (values: Record<string, string | undefined>) =>
  (name: string) => values[name];
const validPost = () => new Request(URL, {
  method: 'POST',
  body: JSON.stringify({ message: 'Покажи розетки', stream: true }),
});

Deno.test('legacy chat preserves CORS preflight and rejects unsupported methods before reading a body', async () => {
  const preflight = await handleChatConsultant(new Request(URL, { method: 'OPTIONS' }));
  assertEquals(preflight.status, 200);
  assertEquals(preflight.headers.get('access-control-allow-origin'), '*');

  const get = await handleChatConsultant(new Request(URL, { method: 'GET' }));
  assertEquals(get.status, 405);
  assertEquals(get.headers.get('allow'), 'POST, OPTIONS');
  assertEquals(await get.json(), { error: 'method_not_allowed' });
});

Deno.test('legacy chat rejects a declared oversized POST before parsing', async () => {
  const response = await handleChatConsultant(new Request(URL, {
    method: 'POST',
    headers: { 'content-length': String(256 * 1024 + 1) },
    body: '{}',
  }));
  assertEquals(response.status, 413);
  assertEquals(await response.json(), { error: 'payload_too_large' });
});

Deno.test('legacy chat bounds a POST even when Content-Length is missing or forged', async () => {
  const response = await handleChatConsultant(new Request(URL, {
    method: 'POST',
    headers: { 'content-length': '1' },
    body: JSON.stringify({ message: 'x'.repeat(256 * 1024) }),
  }));
  assertEquals(response.status, 413);
  assertEquals(await response.json(), { error: 'payload_too_large' });
});

Deno.test('legacy chat returns a bounded JSON error for malformed POST bodies', async () => {
  const response = await handleChatConsultant(new Request(URL, {
    method: 'POST',
    body: '{not-json',
  }));
  assertEquals(response.status, 400);
  assertEquals(response.headers.get('content-type'), 'application/json');
  assertEquals(await response.json(), { error: 'invalid_json' });
});

Deno.test('legacy chat times out a trickling POST before reserving or starting paid work', async () => {
  let cancelled = false;
  let rpcCalls = 0;
  let workCalls = 0;
  const req = new Request(URL, {
    method: 'POST',
    body: new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new TextEncoder().encode('{')); },
      cancel() { cancelled = true; },
    }),
  });
  const response = await handleChatConsultant(req, {
    bodyReadTimeoutMs: 15,
    rpc: () => { rpcCalls++; throw new Error('body not validated'); },
    acceptedWork: async () => { workCalls++; throw new Error('paid work must not start'); },
  });
  assertEquals(response.status, 408);
  assertEquals(await response.json(), { error: 'request_timeout' });
  assertEquals(cancelled, true);
  assertEquals(rpcCalls, 0);
  assertEquals(workCalls, 0);
});

Deno.test('legacy chat rejects JSON without a usable user message before the pipeline', async () => {
  for (const payload of [
    null,
    [],
    {},
    { message: '   ' },
    { messages: [] },
    { messages: [{ role: 'assistant', content: 'Здравствуйте!' }] },
    { messages: [null, { role: 'user', content: 'Есть розетки?' }] },
  ]) {
    const response = await handleChatConsultant(new Request(URL, {
      method: 'POST',
      body: JSON.stringify(payload),
    }));
    assertEquals(response.status, 400);
    assertEquals(await response.json(), { error: 'invalid_request' });
  }
});

Deno.test('legacy chat parser preserves both supported POST payload shapes', async () => {
  const messages = {
    messages: [{ role: 'user', content: 'Есть розетки?' }],
    conversationId: 'legacy-conversation',
    dialogSlots: { category: 'Розетки' },
    stream: false,
  };
  const singleMessage = {
    message: 'Есть розетки?',
    history: [{ role: 'assistant', content: 'Здравствуйте!' }],
    sessionId: 'legacy-session',
    stream: true,
  };
  for (const payload of [messages, singleMessage]) {
    const parsed = await parseLegacyChatBody(new Request(URL, {
      method: 'POST',
      body: JSON.stringify(payload),
    }));
    assertEquals(parsed, { ok: true, body: payload });
  }
});

Deno.test('legacy admission rejects global budget before any model or catalog work', async () => {
  let workCalls = 0;
  let rpcCalls = 0;
  const rpc: PublicApiAdmissionRpc = (name, args) => {
    rpcCalls++;
    assertEquals(name, 'reserve_public_api_admission');
    assertEquals(args.p_route, 'chat-consultant');
    assertEquals(args.p_lanes, ['catalog', 'model']);
    return Promise.resolve({ data: {
      allowed: false,
      reason: 'limit_exceeded',
      mode: 'enforce',
      replayed: false,
      would_reject: true,
      retry_after_seconds: 12,
    } });
  };
  const response = await handleChatConsultant(validPost(), {
    rpc,
    readEnv: readEnv(LIMITS),
    acceptedWork: async () => {
      workCalls++;
      throw new Error('paid work must not start');
    },
  });
  assertEquals(response.status, 429);
  assertEquals(response.headers.get('retry-after'), '12');
  assertEquals(await response.json(), {
    error: 'Слишком много запросов. Подождите минуту.',
  });
  assertEquals(workCalls, 0);
  assertEquals(rpcCalls, 1);
});

Deno.test('legacy admission fails closed on an ambiguous RPC error and releases it', async () => {
  let workCalls = 0;
  let releaseCalls = 0;
  const rpc: PublicApiAdmissionRpc = (name) => {
    if (name === 'reserve_public_api_admission') {
      throw new Error('database unavailable');
    }
    releaseCalls++;
    return Promise.resolve({ data: true });
  };
  const response = await handleChatConsultant(validPost(), {
    rpc,
    readEnv: readEnv(LIMITS),
    acceptedWork: async () => {
      workCalls++;
      throw new Error('paid work must not start');
    },
  });
  assertEquals(response.status, 503);
  assertEquals(await response.json(), {
    error: 'Сервис временно недоступен. Попробуйте позже.',
  });
  assertEquals(workCalls, 0);
  assertEquals(releaseCalls, 1);
});

Deno.test('legacy admission off preserves accepted JSON response without RPC', async () => {
  let workCalls = 0;
  const response = await handleChatConsultant(validPost(), {
    rpc: () => { throw new Error('off must not call RPC'); },
    readEnv: readEnv({ PUBLIC_API_ADMISSION_MODE: 'off' }),
    acceptedWork: async (_req, body) => {
      workCalls++;
      assertEquals(body.message, 'Покажи розетки');
      return new Response(JSON.stringify({ content: 'Есть варианты.' }), {
        headers: { 'Content-Type': 'application/json' },
      });
    },
  });
  assertEquals(response.status, 200);
  assertEquals(await response.json(), { content: 'Есть варианты.' });
  assertEquals(workCalls, 1);
});

Deno.test('legacy admission releases an SSE reservation after the body completes', async () => {
  let releaseCalls = 0;
  const rpc: PublicApiAdmissionRpc = (name) => {
    if (name === 'reserve_public_api_admission') {
      return Promise.resolve({ data: {
        allowed: true, reason: 'admitted', mode: 'enforce',
        replayed: false, would_reject: false, retry_after_seconds: null,
      } });
    }
    releaseCalls++;
    return Promise.resolve({ data: true });
  };
  const response = await handleChatConsultant(validPost(), {
    rpc,
    readEnv: readEnv(LIMITS),
    acceptedWork: async () => new Response('data: {"content":"ok"}\n\ndata: [DONE]\n\n', {
      headers: { 'Content-Type': 'text/event-stream' },
    }),
  });
  assertEquals(response.status, 200);
  assertEquals(releaseCalls, 0);
  assertEquals((await response.text()).includes('data: [DONE]'), true);
  assertEquals(releaseCalls, 1);
});

Deno.test('legacy cancellation retains admission until underlying paid stream settles', async () => {
  let releaseCalls = 0;
  let upstreamCanceled = false;
  let sourceController!: ReadableStreamDefaultController<Uint8Array>;
  const rpc: PublicApiAdmissionRpc = (name) => {
    if (name === 'reserve_public_api_admission') {
      return Promise.resolve({ data: {
        allowed: true, reason: 'admitted', mode: 'enforce',
        replayed: false, would_reject: false, retry_after_seconds: null,
      } });
    }
    releaseCalls++;
    return Promise.resolve({ data: true });
  };
  const response = await handleChatConsultant(validPost(), {
    rpc,
    readEnv: readEnv(LIMITS),
    acceptedWork: async () => new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        sourceController = controller;
        controller.enqueue(new TextEncoder().encode('data: waiting\n\n'));
      },
      cancel() { upstreamCanceled = true; },
    }), { headers: { 'Content-Type': 'text/event-stream' } }),
  });
  const reader = response.body!.getReader();
  assertEquals((await reader.read()).done, false);
  assertEquals(releaseCalls, 0);
  const canceling = reader.cancel();
  await Promise.resolve();
  assertEquals(releaseCalls, 0);
  assertEquals(upstreamCanceled, false);
  sourceController.close();
  await canceling;
  assertEquals(releaseCalls, 1);
});

Deno.test('legacy heartbeat cancellation while pipeline is pending cannot release early', async () => {
  let releaseCalls = 0;
  let resolveWork!: (response: Response) => void;
  let sourceController!: ReadableStreamDefaultController<Uint8Array>;
  const pendingWork = new Promise<Response>((resolve) => { resolveWork = resolve; });
  const rpc: PublicApiAdmissionRpc = (name) => {
    if (name === 'reserve_public_api_admission') {
      return Promise.resolve({ data: {
        allowed: true, reason: 'admitted', mode: 'enforce',
        replayed: false, would_reject: false, retry_after_seconds: null,
      } });
    }
    releaseCalls++;
    return Promise.resolve({ data: true });
  };
  const response = await handleChatConsultant(validPost(), {
    rpc,
    readEnv: readEnv(LIMITS),
    acceptedWork: async () => await pendingWork,
  });
  assertEquals(response.headers.get('content-type')?.includes('text/event-stream'), true);
  const reader = response.body!.getReader();
  assertEquals((await reader.read()).done, false); // heartbeat, no model result yet
  const canceling = reader.cancel();
  await Promise.resolve();
  assertEquals(releaseCalls, 0);
  resolveWork(new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      sourceController = controller;
      controller.enqueue(new TextEncoder().encode('data: result\n\n'));
    },
  }), { headers: { 'Content-Type': 'text/event-stream' } }));
  await Promise.resolve();
  assertEquals(releaseCalls, 0);
  sourceController.close();
  await canceling;
  assertEquals(releaseCalls, 1);
});

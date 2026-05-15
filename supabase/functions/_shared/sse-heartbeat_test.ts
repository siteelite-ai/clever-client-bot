/**
 * Tests for sse-heartbeat wrapper.
 * Run: supabase--test_edge_functions { functions: ["_shared"] }
 */
import { assert, assertEquals, assertStringIncludes, assertRejects } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import {
  wrapWithHeartbeat,
  SSE_HEARTBEAT_LINE,
} from './sse-heartbeat.ts';

const decoder = new TextDecoder();

async function readAll(res: Response): Promise<string> {
  if (!res.body) return '';
  const reader = res.body.getReader();
  let out = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) out += decoder.decode(value);
  }
  return out;
}

function sseResponse(chunks: string[], delayMs = 0): Promise<Response> {
  const encoder = new TextEncoder();
  return new Promise((resolve) => {
    setTimeout(() => {
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          for (const c of chunks) controller.enqueue(encoder.encode(c));
          controller.close();
        },
      });
      resolve(new Response(stream, {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream; charset=utf-8' },
      }));
    }, delayMs);
  });
}

function jsonResponse(body: unknown, delayMs = 0, status = 200): Promise<Response> {
  return new Promise((resolve) => {
    setTimeout(() => {
      resolve(new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json' },
      }));
    }, delayMs);
  });
}

// ─── FAST PATH ───────────────────────────────────────────────────────────────

Deno.test('sse-heartbeat: fast inner (<fastPathMs) → JSON pass-through unchanged', async () => {
  const inner = jsonResponse({ ok: true, x: 1 }, 5);
  const out = await wrapWithHeartbeat(inner, { fastPathMs: 100, intervalMs: 50 });
  assertEquals(out.status, 200);
  assertEquals(out.headers.get('content-type'), 'application/json');
  const body = await out.text();
  assertEquals(JSON.parse(body), { ok: true, x: 1 });
});

Deno.test('sse-heartbeat: fast inner SSE → pass-through unchanged (no heartbeat)', async () => {
  const inner = sseResponse(['data: hello\n\n', 'data: [DONE]\n\n'], 5);
  const out = await wrapWithHeartbeat(inner, { fastPathMs: 100, intervalMs: 50 });
  assertEquals(out.status, 200);
  const body = await readAll(out);
  // No heartbeat lines on fast path
  assertEquals(body.includes(SSE_HEARTBEAT_LINE), false);
  assertStringIncludes(body, 'data: hello');
  assertStringIncludes(body, 'data: [DONE]');
});

Deno.test('sse-heartbeat: fast inner rejection → propagates error', async () => {
  const inner = new Promise<Response>((_, reject) => {
    setTimeout(() => reject(new Error('fast boom')), 5);
  });
  await assertRejects(
    () => wrapWithHeartbeat(inner, { fastPathMs: 100, intervalMs: 50 }),
    Error,
    'fast boom',
  );
});

// ─── SLOW PATH ───────────────────────────────────────────────────────────────

Deno.test('sse-heartbeat: slow inner SSE → emits heartbeat then pipes body', async () => {
  const inner = sseResponse(['data: result\n\n', 'data: [DONE]\n\n'], 250);
  const t0 = Date.now();
  const out = await wrapWithHeartbeat(inner, { fastPathMs: 50, intervalMs: 30 });
  const ttfb = Date.now() - t0;

  // First byte must arrive ~fastPathMs after wrap call (not 250ms)
  assert(ttfb < 200, `TTFB too high: ${ttfb}ms`);
  assertEquals(out.status, 200);
  assertStringIncludes(out.headers.get('content-type') ?? '', 'text/event-stream');

  const body = await readAll(out);
  // Heartbeat present (at least one)
  assert(body.startsWith(SSE_HEARTBEAT_LINE), `body should start with heartbeat: ${body.slice(0, 50)}`);
  // Inner SSE chunks are still piped through
  assertStringIncludes(body, 'data: result');
  assertStringIncludes(body, 'data: [DONE]');
});

Deno.test('sse-heartbeat: slow inner JSON → wrapped as single data event', async () => {
  const inner = jsonResponse({ content: 'hi', x: 7 }, 250);
  const out = await wrapWithHeartbeat(inner, { fastPathMs: 50, intervalMs: 30 });
  assertStringIncludes(out.headers.get('content-type') ?? '', 'text/event-stream');
  const body = await readAll(out);
  assert(body.startsWith(SSE_HEARTBEAT_LINE));
  // Inner JSON surfaced as data: <json>
  assertStringIncludes(body, '"content":"hi"');
  assertStringIncludes(body, 'data: [DONE]');
});

Deno.test('sse-heartbeat: slow inner rejection → emits error event + DONE', async () => {
  const inner = new Promise<Response>((_, reject) => {
    setTimeout(() => reject(new Error('slow boom')), 250);
  });
  const out = await wrapWithHeartbeat(inner, { fastPathMs: 50, intervalMs: 30 });
  assertEquals(out.status, 200);
  const body = await readAll(out);
  assert(body.startsWith(SSE_HEARTBEAT_LINE));
  assertStringIncludes(body, '"error":"slow boom"');
  assertStringIncludes(body, 'data: [DONE]');
});

Deno.test('sse-heartbeat: multiple heartbeats fire while inner is delayed', async () => {
  const inner = sseResponse(['data: ok\n\n'], 200);
  const out = await wrapWithHeartbeat(inner, { fastPathMs: 30, intervalMs: 40 });
  const body = await readAll(out);
  // expect ≥2 heartbeat occurrences (one immediate + at least one interval tick)
  const count = body.split(SSE_HEARTBEAT_LINE).length - 1;
  assert(count >= 2, `expected ≥2 heartbeats, got ${count}; body=${JSON.stringify(body)}`);
});

Deno.test('sse-heartbeat: CORS headers propagated on slow path', async () => {
  const inner = sseResponse(['data: x\n\n'], 250);
  const out = await wrapWithHeartbeat(inner, {
    fastPathMs: 50,
    intervalMs: 30,
    corsHeaders: { 'Access-Control-Allow-Origin': '*' },
  });
  assertEquals(out.headers.get('access-control-allow-origin'), '*');
});

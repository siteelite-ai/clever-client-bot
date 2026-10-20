import {
  assert,
  assertEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import { MAX_V2_REQUEST_BODY_BYTES, parseV2Request } from "./request-guard.ts";

function post(body: string, headers: Record<string, string> = {}): Request {
  return new Request("https://example.test/functions/v1/chat-consultant-v2", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body,
  });
}

const legacyBody = {
  conversationId: "legacy-session-1",
  query: "  нужны розетки  ",
  messages: [
    { role: "system", content: "legacy role is accepted then ignored" },
    { role: "user", content: "покажи варианты" },
  ],
  dialogSlots: { pending: { intent: "product_search" } },
  messageId: "legacy-optional-extra",
};

Deno.test("v2 guard: preserves the legacy POST payload and trims query", async () => {
  const result = await parseV2Request(post(JSON.stringify(legacyBody)));
  assert(result.ok);
  assertEquals(result.value.query, "нужны розетки");
  assertEquals(result.value.messages?.length, 2);
  assertEquals(result.value.dialogSlots?.pending, { intent: "product_search" });
});

Deno.test("v2 guard: accepts a complete typed conversation slot", async () => {
  const result = await parseV2Request(post(JSON.stringify({
    conversationId: "v2-session-1",
    query: "первый",
    history: [{ role: "assistant", content: "Что выбрать?" }],
    state: {
      conversation_id: "v2-session-1",
      slots: [{
        id: "slot-1",
        type: "category_disambiguation",
        created_at: 1_700_000_000_000,
        expires_at: 1_700_000_300_000,
        ttl_turns: 2,
        turns_since_created: 0,
        options: [{
          label: "Розетки",
          value: "rozetki",
          payload: { categoryId: 10 },
        }],
        pending_query: "розетки",
        pending_modifiers: [],
        pending_filters: null,
        consumed: false,
      }],
      slot_state: { soft404_streak: 1 },
    },
  })));
  assert(result.ok);
  const state = result.value.state as {
    slots: Array<{ options: Array<{ label: string }> }>;
  };
  assertEquals(state.slots[0].options[0].label, "Розетки");
});

Deno.test("v2 guard: preserves the historical permissive state contract", async () => {
  for (
    const state of [
      null,
      "legacy-state",
      { slots: [null], custom: { source: "older-client" } },
    ]
  ) {
    const result = await parseV2Request(post(JSON.stringify({
      ...legacyBody,
      state,
    })));
    assert(result.ok);
    assertEquals(result.value.state, state);
  }
});

Deno.test("v2 guard: accepts 100 history messages of 1000 characters", async () => {
  const result = await parseV2Request(post(JSON.stringify({
    ...legacyBody,
    history: Array.from({ length: 100 }, () => ({
      role: "assistant",
      content: "x".repeat(1000),
    })),
  })));
  assert(result.ok);
  assertEquals(result.value.history?.length, 100);
});

Deno.test("v2 guard: invalid legacy fields still fail before model work", async () => {
  for (
    const body of [
      { ...legacyBody, history: [{ role: "admin", content: "hello" }] },
      { ...legacyBody, query: "   " },
    ]
  ) {
    const result = await parseV2Request(post(JSON.stringify(body)));
    assert(!result.ok);
    assertEquals(result.status, 400);
    assertEquals(result.error, "invalid_request");
  }
});

Deno.test("v2 guard: invalid JSON returns the established 400 error", async () => {
  const result = await parseV2Request(post('{"conversationId":'));
  assert(!result.ok);
  assertEquals(result.status, 400);
  assertEquals(result.error, "invalid_json");
});

Deno.test("v2 guard: trickling body receives 408 and cancels ingress", async () => {
  let cancelled = false;
  const req = new Request("https://example.test/functions/v1/chat-consultant-v2", {
    method: "POST",
    body: new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new TextEncoder().encode("{")); },
      cancel() { cancelled = true; },
    }),
  });
  const result = await parseV2Request(req, 15);
  assert(!result.ok);
  assertEquals(result.status, 408);
  assertEquals(result.error, "request_timeout");
  assertEquals(cancelled, true);
});

Deno.test("v2 guard: advertised body size is a fast 413 precheck", async () => {
  const result = await parseV2Request(post(JSON.stringify(legacyBody), {
    "content-length": String(MAX_V2_REQUEST_BODY_BYTES + 1),
  }));
  assert(!result.ok);
  assertEquals(result.status, 413);
  assertEquals(result.error, "payload_too_large");
});

Deno.test("v2 guard: streamed bytes, not Content-Length, enforce the 512 KiB cap", async () => {
  const oversized = JSON.stringify({
    ...legacyBody,
    history: [{ role: "assistant", content: "х".repeat(270_000) }],
  });
  assert(
    new TextEncoder().encode(oversized).byteLength > MAX_V2_REQUEST_BODY_BYTES,
  );
  const result = await parseV2Request(
    post(oversized, { "content-length": "1" }),
  );
  assert(!result.ok);
  assertEquals(result.status, 413);
  assertEquals(result.error, "payload_too_large");
});

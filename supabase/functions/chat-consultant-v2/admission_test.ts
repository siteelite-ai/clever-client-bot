import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import type { PublicApiAdmissionRpc } from "../_shared/public-api-admission.ts";
import { handleChatConsultantV2 } from "./index.ts";

const URL = "https://example.supabase.co/functions/v1/chat-consultant-v2";
const LIMITS = {
  PUBLIC_API_ADMISSION_MODE: "enforce",
  PUBLIC_API_MODEL_LIMIT_PER_MINUTE: "8",
  PUBLIC_API_MODEL_LIMIT_IN_FLIGHT: "3",
  PUBLIC_API_CATALOG_LIMIT_PER_MINUTE: "20",
  PUBLIC_API_CATALOG_LIMIT_IN_FLIGHT: "5",
};
const readEnv = (values: Record<string, string | undefined>) =>
  (name: string) => values[name];
const validPost = () => new Request(URL, {
  method: "POST",
  body: JSON.stringify({
    conversationId: "legacy-v2-conversation",
    query: "Покажи розетки",
  }),
});

Deno.test("v2 admission denies model/catalog budget before paid work, with SSE framing", async () => {
  let workCalls = 0;
  let rpcCalls = 0;
  const rpc: PublicApiAdmissionRpc = (name, args) => {
    rpcCalls++;
    assertEquals(name, "reserve_public_api_admission");
    assertEquals(args.p_route, "chat-consultant-v2");
    assertEquals(args.p_lanes, ["catalog", "model"]);
    return Promise.resolve({ data: {
      allowed: false,
      reason: "limit_exceeded",
      mode: "enforce",
      replayed: false,
      would_reject: true,
      retry_after_seconds: 9,
    } });
  };
  const response = await handleChatConsultantV2(validPost(), {
    rpc,
    readEnv: readEnv(LIMITS),
    acceptedWork: async () => {
      workCalls++;
      throw new Error("paid work must not start");
    },
  });
  assertEquals(response.status, 429);
  assertEquals(response.headers.get("content-type"), "text/event-stream; charset=utf-8");
  assertEquals(response.headers.get("retry-after"), "9");
  const body = await response.text();
  assertEquals(body.includes('"error":"rate_limited"'), true);
  assertEquals(body.endsWith("data: [DONE]\n\n"), true);
  assertEquals(workCalls, 0);
  assertEquals(rpcCalls, 1);
});

Deno.test("v2 trickling POST fails before admission or paid work", async () => {
  let cancelled = false;
  let rpcCalls = 0;
  let workCalls = 0;
  const req = new Request(URL, {
    method: "POST",
    body: new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new TextEncoder().encode("{")); },
      cancel() { cancelled = true; },
    }),
  });
  const response = await handleChatConsultantV2(req, {
    bodyReadTimeoutMs: 15,
    rpc: () => { rpcCalls++; throw new Error("body not validated"); },
    acceptedWork: async () => { workCalls++; throw new Error("paid work must not start"); },
  });
  assertEquals(response.status, 408);
  const body = await response.json();
  assertEquals(body.error, "request_timeout");
  assertEquals(cancelled, true);
  assertEquals(rpcCalls, 0);
  assertEquals(workCalls, 0);
});

Deno.test("v2 admission fails closed on RPC error without starting paid work", async () => {
  let workCalls = 0;
  let releaseCalls = 0;
  const rpc: PublicApiAdmissionRpc = (name) => {
    if (name === "reserve_public_api_admission") throw new Error("database unavailable");
    releaseCalls++;
    return Promise.resolve({ data: true });
  };
  const response = await handleChatConsultantV2(validPost(), {
    rpc,
    readEnv: readEnv(LIMITS),
    acceptedWork: async () => {
      workCalls++;
      throw new Error("paid work must not start");
    },
  });
  assertEquals(response.status, 503);
  assertEquals((await response.text()).includes('"error":"service_unavailable"'), true);
  assertEquals(workCalls, 0);
  assertEquals(releaseCalls, 1);
});

Deno.test("v2 admission off retains accepted response and makes no RPC", async () => {
  let workCalls = 0;
  const response = await handleChatConsultantV2(validPost(), {
    rpc: () => { throw new Error("off must not call RPC"); },
    readEnv: readEnv({ PUBLIC_API_ADMISSION_MODE: "off" }),
    acceptedWork: async (request) => {
      workCalls++;
      assertEquals(request.query, "Покажи розетки");
      return new Response("data: [DONE]\n\n", {
        headers: { "Content-Type": "text/event-stream" },
      });
    },
  });
  assertEquals(response.status, 200);
  assertEquals(await response.text(), "data: [DONE]\n\n");
  assertEquals(workCalls, 1);
});

Deno.test("v2 admission release follows SSE completion, not handler return", async () => {
  let releaseCalls = 0;
  const rpc: PublicApiAdmissionRpc = (name) => {
    if (name === "reserve_public_api_admission") {
      return Promise.resolve({ data: {
        allowed: true, reason: "admitted", mode: "enforce",
        replayed: false, would_reject: false, retry_after_seconds: null,
      } });
    }
    releaseCalls++;
    return Promise.resolve({ data: true });
  };
  const response = await handleChatConsultantV2(validPost(), {
    rpc,
    readEnv: readEnv(LIMITS),
    acceptedWork: async () => new Response("data: [DONE]\n\n", {
      headers: { "Content-Type": "text/event-stream" },
    }),
  });
  assertEquals(releaseCalls, 0);
  assertEquals(await response.text(), "data: [DONE]\n\n");
  assertEquals(releaseCalls, 1);
});

Deno.test("v2 cancellation retains admission until underlying paid stream settles", async () => {
  let releaseCalls = 0;
  let upstreamCanceled = false;
  let sourceController!: ReadableStreamDefaultController<Uint8Array>;
  const rpc: PublicApiAdmissionRpc = (name) => {
    if (name === "reserve_public_api_admission") {
      return Promise.resolve({ data: {
        allowed: true, reason: "admitted", mode: "enforce",
        replayed: false, would_reject: false, retry_after_seconds: null,
      } });
    }
    releaseCalls++;
    return Promise.resolve({ data: true });
  };
  const response = await handleChatConsultantV2(validPost(), {
    rpc,
    readEnv: readEnv(LIMITS),
    acceptedWork: async () => new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        sourceController = controller;
        controller.enqueue(new TextEncoder().encode("data: waiting\n\n"));
      },
      cancel() { upstreamCanceled = true; },
    }), { headers: { "Content-Type": "text/event-stream" } }),
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

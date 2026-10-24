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

Deno.test("v2 preflight advertises only the requested signed-proof header", async () => {
  const ordinary = await handleChatConsultantV2(new Request(URL, { method: "OPTIONS" }));
  assertEquals(ordinary.status, 200);
  assertEquals(ordinary.headers.get("access-control-allow-headers")?.includes("x-volt-subject-proof"), false);
  const signed = await handleChatConsultantV2(new Request(URL, {
    method: "OPTIONS",
    headers: { "Access-Control-Request-Headers": "content-type, X-Volt-Subject-Proof" },
  }));
  assertEquals(signed.headers.get("access-control-allow-headers")?.includes("x-volt-subject-proof"), true);
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

const SUBJECT_PROOF_ENV = {
  PUBLIC_API_ADMISSION_MODE: "off",
  PUBLIC_SUBJECT_PROOF_KID: "test-key",
  PUBLIC_SUBJECT_PROOF_HMAC_KEY: btoa("a".repeat(32)).replace(/=+$/u, ""),
  PUBLIC_SUBJECT_LIMIT_PER_MINUTE: "5",
  PUBLIC_SUBJECT_LIMIT_IN_FLIGHT: "2",
};

Deno.test("v2 subject enforcement rejects missing proof before model/catalog work", async () => {
  let paidCalls = 0;
  const response = await handleChatConsultantV2(validPost(), {
    readEnv: readEnv({ ...SUBJECT_PROOF_ENV, PUBLIC_SUBJECT_ADMISSION_MODE: "enforce" }),
    rpc: () => { throw new Error("global admission must not run"); },
    subjectRpc: () => { throw new Error("subject admission must not run without proof"); },
    acceptedWork: async () => { paidCalls++; throw new Error("paid work must not run"); },
  });
  assertEquals(response.status, 403);
  assertEquals(response.headers.get("content-type"), "text/event-stream; charset=utf-8");
  const body = await response.text();
  assertEquals(body.includes('"error":"access_denied"'), true);
  assertEquals(body.endsWith("data: [DONE]\n\n"), true);
  assertEquals(paidCalls, 0);
});

Deno.test("v2 subject observation preserves an unsigned SSE response", async () => {
  let paidCalls = 0;
  const observed: unknown[][] = [];
  const originalWarn = console.warn;
  const originalInfo = console.info;
  try {
    console.warn = (...args) => { observed.push(args); };
    console.info = (...args) => { observed.push(args); };
    const response = await handleChatConsultantV2(validPost(), {
      readEnv: readEnv({ ...SUBJECT_PROOF_ENV, PUBLIC_SUBJECT_ADMISSION_MODE: "observe" }),
      rpc: () => { throw new Error("global admission is off"); },
      subjectRpc: () => { throw new Error("unsigned observe must not reserve"); },
      acceptedWork: async () => {
        paidCalls++;
        return new Response("data: [DONE]\n\n", {
          headers: { "Content-Type": "text/event-stream" },
        });
      },
    });
    assertEquals(response.status, 200);
    assertEquals(await response.text(), "data: [DONE]\n\n");
    assertEquals(paidCalls, 1);
    assertEquals(observed.some(([label, data]) =>
      label === "[chat-consultant-v2] subject proof would reject" &&
      (data as { reason?: string }).reason === "missing_proof"
    ), true);
  } finally {
    console.warn = originalWarn;
    console.info = originalInfo;
  }
});

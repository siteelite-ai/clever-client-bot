// Real v3 handler, offline Supabase fixture: protect persisted SSE replay as
// well as newly accepted paid work. No catalog or model network is allowed.
import {
  assert,
  assertEquals,
  assertFalse,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  offlineAdmissionHandler,
  restoreAdmissionFixture,
  setPublicAdmissionMode,
  setSubjectAdmissionMode,
} from "./public-api-admission-integration-fixture.ts";
import "./index.ts";

const ENDPOINT = "https://fixture.supabase.invalid/functions/v1/chat-consultant-v3";
const SUBJECT_A = "a".repeat(64);
const SUBJECT_B = "b".repeat(64);
const SESSION_ID = "96e9c5d9-479f-45ab-89d0-eb978cd7de09";
const MESSAGE_ID = "5910496f-170b-476a-bab4-2572b26918f0";
const QUERY = "Покажи розетки";

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function captureFixtureIntervals(): () => void {
  // Supabase's auth client may arm an isolate refresh timer. A real Edge
  // request isolate is torn down after the request; our shared test isolate
  // must explicitly dispose every timer just like the existing v3 fixture.
  const originalSetInterval = globalThis.setInterval;
  const intervals = new Set<number>();
  globalThis.setInterval = ((callback, delay, ...args) => {
    const id = originalSetInterval(callback, delay, ...args);
    intervals.add(id);
    return id;
  }) as typeof setInterval;
  return () => {
    for (const id of intervals) clearInterval(id);
    globalThis.setInterval = originalSetInterval;
  };
}

function base64Url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

async function proof(subjectHash: string): Promise<string> {
  const keyBytes = new TextEncoder().encode("a".repeat(32));
  const key = await crypto.subtle.importKey(
    "raw", keyBytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  const now = Math.floor(Date.now() / 1000);
  const payload = base64Url(new TextEncoder().encode(JSON.stringify({
    v: 1,
    kid: "fixture-key",
    aud: "volt220-public-api",
    sub: subjectHash,
    iat: now,
    exp: now + 30,
    jti: crypto.randomUUID(),
  })));
  const signed = `v1.${payload}`;
  const signature = new Uint8Array(await crypto.subtle.sign(
    "HMAC", key, new TextEncoder().encode(signed),
  ));
  return `${signed}.${base64Url(signature)}`;
}

function post(proofHeader?: string, resumeOnly = true): Request {
  return new Request(ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(proofHeader ? { "x-volt-subject-proof": proofHeader } : {}),
    },
    body: JSON.stringify({
      message: QUERY,
      messageId: MESSAGE_ID,
      sessionId: SESSION_ID,
      history: [],
      resumeOnly,
    }),
  });
}

function replayRow(subjectHash: string | null): Record<string, unknown> {
  return {
    id: "offline-existing-log",
    session_id: SESSION_ID,
    user_query: QUERY,
    public_subject_hash: subjectHash,
    error: null,
    response_events: [
      { type: "diagnostic", log_id: "offline-existing-log", phase: "start" },
      { type: "delta", content: "Ранее найденная карточка", origin: "server" },
      {
        type: "diagnostic", log_id: "offline-existing-log",
        phase: "complete", products_count: 0, error: null,
        replacement_egress: "ordinary",
      },
      { type: "done" },
    ],
  };
}

Deno.test({
  name: "v3 preflight permits requested proof header without changing ordinary OFF CORS",
  permissions: { read: true, env: false, net: false },
  async fn() {
    setSubjectAdmissionMode("off");
    const plain = await offlineAdmissionHandler()(new Request(ENDPOINT, { method: "OPTIONS" }));
    assertEquals(plain.status, 200);
    assertEquals(plain.headers.get("access-control-allow-headers")?.includes("x-volt-subject-proof"), false);
    const signed = await offlineAdmissionHandler()(new Request(ENDPOINT, {
      method: "OPTIONS",
      headers: { "Access-Control-Request-Headers": "content-type, X-Volt-Subject-Proof" },
    }));
    assertEquals(signed.headers.get("access-control-allow-headers")?.includes("x-volt-subject-proof"), true);
  },
});

async function runReplay(
  mode: "off" | "observe" | "enforce",
  token: string | undefined,
  storedHash: string | null,
): Promise<{ status: number; text: string; paths: string[] }> {
  setPublicAdmissionMode("off");
  setSubjectAdmissionMode(mode);
  const originalFetch = globalThis.fetch;
  const restoreIntervals = captureFixtureIntervals();
  const paths: string[] = [];
  try {
    globalThis.fetch = async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init);
      const url = new URL(request.url);
      paths.push(`${request.method} ${url.pathname}`);
      assertEquals(url.origin, "https://fixture.supabase.invalid");
      if (request.method === "GET" && url.pathname === "/rest/v1/chat_request_logs") {
        return json(replayRow(storedHash));
      }
      throw new Error(`Unexpected fixture request: ${request.method} ${url.pathname}`);
    };
    const response = await offlineAdmissionHandler()(post(token));
    return { status: response.status, text: await response.text(), paths };
  } finally {
    restoreIntervals();
    globalThis.fetch = originalFetch;
  }
}

Deno.test({
  name: "v3 OFF replay remains column-agnostic and needs no subject RPC",
  permissions: { read: true, env: false, net: false },
  async fn() {
    const result = await runReplay("off", undefined, null);
    assertEquals(result.status, 200);
    assert(result.text.includes("Ранее найденная карточка"));
    assertEquals(result.paths.length, 1);
    assertFalse(result.paths[0].includes("subject_hash"));
  },
});

Deno.test({
  name: "v3 observe leaves unsigned replay available and never reserves paid work",
  permissions: { read: true, env: false, net: false },
  async fn() {
    const result = await runReplay("observe", undefined, null);
    assertEquals(result.status, 200);
    assert(result.text.includes("Ранее найденная карточка"));
    assertEquals(result.paths.length, 1);
  },
});

Deno.test({
  name: "v3 observe records a cross-subject replay mismatch without blocking it",
  permissions: { read: true, env: false, net: false },
  async fn() {
    const result = await runReplay("observe", await proof(SUBJECT_B), SUBJECT_A);
    assertEquals(result.status, 200);
    assert(result.text.includes("Ранее найденная карточка"));
    assertEquals(result.paths.length, 1);
  },
});

Deno.test({
  name: "v3 enforce rejects absent proof before replay lookup or any paid request",
  permissions: { read: true, env: false, net: false },
  async fn() {
    const result = await runReplay("enforce", undefined, SUBJECT_A);
    assertEquals(result.status, 403);
    assert(result.text.includes("access_denied"));
    assertFalse(result.text.includes("Ранее найденная карточка"));
    assertEquals(result.paths, []);
  },
});

Deno.test({
  name: "v3 enforced replay is allowed only to the original signed subject",
  permissions: { read: true, env: false, net: false },
  async fn() {
    const original = await runReplay("enforce", await proof(SUBJECT_A), SUBJECT_A);
    assertEquals(original.status, 200);
    assert(original.text.includes("Ранее найденная карточка"));
    assertEquals(original.paths.length, 1);
    const foreign = await runReplay("enforce", await proof(SUBJECT_B), SUBJECT_A);
    assertEquals(foreign.status, 200);
    assertFalse(foreign.text.includes("Ранее найденная карточка"));
    assert(foreign.text.includes("request_conflict"));
    assert(foreign.text.includes('"log_id":null'));
    assertEquals(foreign.paths.length, 1);
  },
});

Deno.test({
  name: "v3 enforced replay rejects legacy unbound rows rather than grandfathering them",
  permissions: { read: true, env: false, net: false },
  async fn() {
    const result = await runReplay("enforce", await proof(SUBJECT_A), null);
    assertEquals(result.status, 200);
    assertFalse(result.text.includes("Ранее найденная карточка"));
    assert(result.text.includes("request_conflict"));
    assert(result.text.includes('"log_id":null'));
    assertEquals(result.paths.length, 1);
  },
});

Deno.test({
  name: "v3 newly claimed enforced turn binds the hash and releases subject before done",
  permissions: { read: true, env: false, net: false },
  async fn() {
    setPublicAdmissionMode("off");
    setSubjectAdmissionMode("enforce");
    const originalFetch = globalThis.fetch;
    const restoreIntervals = captureFixtureIntervals();
    const paths: string[] = [];
    let released = false;
    let claimHash: string | null = null;
    try {
      globalThis.fetch = async (input, init) => {
        const request = input instanceof Request ? input : new Request(input, init);
        const url = new URL(request.url);
        paths.push(`${request.method} ${url.pathname}`);
        assertEquals(url.origin, "https://fixture.supabase.invalid");
        if (url.pathname === "/rest/v1/chat_request_logs" && request.method === "POST") {
          const body = await request.json() as Record<string, unknown>;
          claimHash = body.public_subject_hash as string;
          return json({ id: "offline-new-log" }, 201);
        }
        if (url.pathname === "/rest/v1/chat_request_logs" && request.method === "PATCH") {
          return new Response(null, { status: 204 });
        }
        if (url.pathname === "/rest/v1/rpc/reserve_public_subject_admission") {
          const args = await request.json() as Record<string, unknown>;
          assertEquals(args.p_subject_hash, SUBJECT_A);
          assertEquals(args.p_route, "chat-consultant-v3");
          return json({
            allowed: true, mode: "enforce", reason: "admitted", replayed: false,
            would_reject: false, retry_after_seconds: null,
          });
        }
        if (url.pathname === "/rest/v1/rpc/release_public_subject_admission") {
          released = true;
          return json(true);
        }
        if (url.pathname === "/rest/v1/app_settings") {
          return json({ openrouter_api_key: "", volt220_api_token: "" });
        }
        throw new Error(`Unexpected fixture request: ${request.method} ${url.pathname}`);
      };
      const response = await offlineAdmissionHandler()(post(await proof(SUBJECT_A), false));
      assertEquals(response.status, 200);
      const text = await response.text();
      assert(text.includes("data: [DONE]"));
      assertEquals(claimHash, SUBJECT_A);
      assert(released, "subject reservation must release before terminal response completion");
      assert(paths.some((path) => path.includes("reserve_public_subject_admission")));
      assert(paths.some((path) => path.includes("release_public_subject_admission")));
      assertFalse(paths.some((path) => path.includes("reserve_public_api_admission")));
    } finally {
      restoreIntervals();
      globalThis.fetch = originalFetch;
      restoreAdmissionFixture();
    }
  },
});

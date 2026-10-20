// Exercises the actual v3 HTTP handler's newly claimed-turn path. A fixture
// Supabase RPC enforces the cross-route gate; model/catalog calls are forbidden.
import {
  assert,
  assertEquals,
  assertFalse,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  offlineAdmissionHandler,
  restoreAdmissionFixture,
  setPublicAdmissionMode,
} from "./public-api-admission-integration-fixture.ts";
import "./index.ts";

type Decision = "allow" | "deny";

interface FixtureRun {
  events: Array<Record<string, unknown>>;
  requests: string[];
  releasedReservationId: string | null;
  reservedReservationId: string | null;
  persistedSteps: string[];
  releaseBeforeDone: boolean;
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function eventsFromSse(text: string): Array<Record<string, unknown>> {
  return text.split("\n\n")
    .filter((line) => line.startsWith("data: "))
    .map((line) => line === "data: [DONE]"
      ? { v3_event: { type: "done" } }
      : JSON.parse(line.slice(6)) as Record<string, unknown>);
}

function v3Events(events: FixtureRun["events"]): Array<Record<string, unknown>> {
  return events.map((event) => event.v3_event)
    .filter((event): event is Record<string, unknown> =>
      Boolean(event) && typeof event === "object"
    );
}

async function runOfflineTurn(
  mode: "off" | "enforce",
  decision: Decision = "allow",
): Promise<FixtureRun> {
  setPublicAdmissionMode(mode);
  const originalFetch = globalThis.fetch;
  const originalSetInterval = globalThis.setInterval;
  const intervals = new Set<number>();
  const requests: string[] = [];
  const persistedSteps: string[] = [];
  let releasedReservationId: string | null = null;
  let reservedReservationId: string | null = null;
  let releaseCompleted = false;
  let releaseStarted!: () => void;
  const releaseStartedPromise = new Promise<void>((resolve) => {
    releaseStarted = resolve;
  });
  let continueRelease!: () => void;
  const releaseGate = new Promise<void>((resolve) => {
    continueRelease = resolve;
  });

  try {
    globalThis.setInterval = ((callback, delay, ...args) => {
      const id = originalSetInterval(callback, delay, ...args);
      intervals.add(id);
      return id;
    }) as typeof setInterval;

    globalThis.fetch = async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init);
      const url = new URL(request.url);
      requests.push(`${request.method} ${url.origin}${url.pathname}`);
      assertEquals(url.origin, "https://fixture.supabase.invalid", "no paid/catalog network calls");

      if (url.pathname === "/rest/v1/chat_request_logs") {
        if (request.method === "POST") return json({ id: "offline-log-id" }, 201);
        if (request.method === "PATCH") {
          const body = await request.json() as {
            steps?: Array<{ step?: string }>;
          };
          persistedSteps.push(...(body.steps ?? []).map(({ step }) => step ?? ""));
          return new Response(null, { status: 204 });
        }
      }
      if (url.pathname === "/rest/v1/app_settings" && request.method === "GET") {
        // Stop before any catalog/model call but still exercise successful
        // admission and the accepted turn's terminal release path.
        return json({ openrouter_api_key: "", volt220_api_token: "" });
      }
      if (url.pathname === "/rest/v1/rpc/reserve_public_api_admission") {
        assertEquals(request.method, "POST");
        const args = await request.json() as Record<string, unknown>;
        assertEquals(args.p_route, "chat-consultant-v3");
        assertEquals(args.p_mode, "enforce");
        assertEquals(args.p_lanes, ["catalog", "model"]);
        assertEquals(args.p_model_limit_in_flight, 1);
        assertEquals(args.p_catalog_limit_in_flight, 2);
        assertEquals(typeof args.p_reservation_id, "string");
        reservedReservationId = args.p_reservation_id as string;
        return json({
          allowed: decision === "allow",
          mode: "enforce",
          reason: decision === "allow" ? "admitted" : "limit_exceeded",
          would_reject: decision === "deny",
          replayed: false,
          retry_after_seconds: decision === "deny" ? 30 : null,
        });
      }
      if (url.pathname === "/rest/v1/rpc/release_public_api_admission") {
        assertEquals(request.method, "POST");
        const args = await request.json() as Record<string, unknown>;
        releasedReservationId = args.p_reservation_id as string;
        releaseStarted();
        await releaseGate;
        releaseCompleted = true;
        return json(true);
      }
      throw new Error(`Unexpected fixture request: ${request.method} ${url.pathname}`);
    };

    const response = await offlineAdmissionHandler()(new Request(
      "https://fixture.supabase.invalid/functions/v1/chat-consultant-v3",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: "Нужен удлинитель",
          messageId: crypto.randomUUID(),
          sessionId: crypto.randomUUID(),
          history: [],
        }),
      },
    ));
    assertEquals(response.status, 200);
    const decoder = new TextDecoder();
    let streamedText = "";
    let releaseBeforeDone = false;
    const consume = (async () => {
      const reader = response.body!.getReader();
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        streamedText += decoder.decode(next.value, { stream: true });
        if (streamedText.includes("data: [DONE]")) {
          releaseBeforeDone = releaseCompleted;
        }
      }
      return streamedText;
    })();
    if (mode === "enforce" && decision === "allow") {
      await releaseStartedPromise;
      // The fake release RPC is intentionally unresolved. A terminal event
      // before this gate opens would prove that SSE outlived its reservation.
      await new Promise((resolve) => setTimeout(resolve, 15));
      assertFalse(streamedText.includes("data: [DONE]"));
    }
    continueRelease();
    const events = eventsFromSse(await consume);
    const terminalEvents = v3Events(events);
    const done = terminalEvents.find((event) => event.type === "done");
    assert(done, "accepted turn must emit terminal done");
    return {
      events,
      requests,
      releasedReservationId,
      reservedReservationId,
      persistedSteps,
      releaseBeforeDone,
    };
  } finally {
    continueRelease();
    for (const id of intervals) clearInterval(id);
    globalThis.setInterval = originalSetInterval;
    globalThis.fetch = originalFetch;
  }
}

Deno.test({
  name: "v3 public admission off leaves the production handler without an RPC",
  permissions: { read: true, env: false, net: false },
  async fn() {
    const result = await runOfflineTurn("off");
    assertFalse(result.requests.some((request) => request.includes("/rpc/")));
    assertEquals(result.reservedReservationId, null);
    assertEquals(result.releasedReservationId, null);
    assert(result.persistedSteps.includes("public_api_admission_checked"));
  },
});

Deno.test({
  name: "v3 denied global capacity stops before settings, catalog, and model",
  permissions: { read: true, env: false, net: false },
  async fn() {
    const result = await runOfflineTurn("enforce", "deny");
    assertEquals(result.reservedReservationId !== null, true);
    assertEquals(result.releasedReservationId, null);
    assertFalse(result.requests.some((request) =>
      request.includes("/app_settings") ||
      request.includes("fixture.catalog.invalid") ||
      request.includes("openrouter.ai")
    ));
    assert(v3Events(result.events).some((event) =>
      event.type === "diagnostic" && event.error === "rate_limited"
    ));
    assert(result.persistedSteps.includes("public_api_admission_checked"));
    assertFalse(result.persistedSteps.includes("v3_settings_loaded"));
  },
});

Deno.test({
  name: "v3 admitted turn releases its global reservation before terminal SSE",
  permissions: { read: true, env: false, net: false },
  async fn() {
    try {
      const result = await runOfflineTurn("enforce", "allow");
      assertEquals(result.releasedReservationId, result.reservedReservationId);
      assert(result.releaseBeforeDone);
      assert(result.persistedSteps.includes("v3_settings_loaded"));
    } finally {
      restoreAdmissionFixture();
    }
  },
});

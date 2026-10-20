import {
  type PublicApiAdmissionRpc,
  releasePublicApiAdmission,
  reservePublicApiAdmission,
  wrapResponseForAdmissionRelease,
} from "./public-api-admission.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
function equal(actual: unknown, expected: unknown) {
  assert(Object.is(actual, expected), `${actual} !== ${expected}`);
}
function env(values: Record<string, string | undefined>) {
  return (name: string) => values[name];
}
const LIMITS = {
  PUBLIC_API_ADMISSION_MODE: "enforce",
  PUBLIC_API_MODEL_LIMIT_PER_MINUTE: "8",
  PUBLIC_API_MODEL_LIMIT_IN_FLIGHT: "3",
  PUBLIC_API_CATALOG_LIMIT_PER_MINUTE: "20",
  PUBLIC_API_CATALOG_LIMIT_IN_FLIGHT: "5",
};

Deno.test("off makes no RPC or reservation and tolerates absent limits", async () => {
  const rpc: PublicApiAdmissionRpc = () => {
    throw new Error("off must not make an RPC");
  };
  for (const mode of [undefined, "off"]) {
    const reservation = await reservePublicApiAdmission({
      route: "chat-consultant",
      lanes: ["model", "catalog"],
      rpc,
      readEnv: env({ PUBLIC_API_ADMISSION_MODE: mode }),
    });
    equal(reservation.allowed, true);
    equal(reservation.reason, "off");
    equal(reservation.reservationId, null);
    equal(reservation.releaseRequired, false);
    equal((await releasePublicApiAdmission({ reservation, rpc })).attempted, false);
  }
});

Deno.test("one server UUID reserves both global lanes; no client identity", async () => {
  const calls: Array<Record<string, string | number | null | string[]>> = [];
  const rpc: PublicApiAdmissionRpc = (name, args) => {
    equal(name, "reserve_public_api_admission");
    calls.push(args);
    return Promise.resolve({ data: {
      allowed: true,
      reason: "admitted",
      mode: "enforce",
      replayed: false,
      would_reject: false,
      retry_after_seconds: null,
    } });
  };
  const reservation = await reservePublicApiAdmission({
    route: "chat-consultant-v2",
    lanes: ["model", "catalog"],
    rpc,
    readEnv: env(LIMITS),
  });
  const request = calls[0];
  assert(request, "RPC not called");
  equal(request.p_route, "chat-consultant-v2");
  equal(request.p_model_limit_per_minute, 8);
  equal(request.p_catalog_limit_in_flight, 5);
  equal(JSON.stringify(request.p_lanes), '["catalog","model"]');
  assert(typeof request.p_reservation_id === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
      .test(request.p_reservation_id), "not a generated UUIDv4");
  equal(reservation.reservationId, request.p_reservation_id);
  equal(reservation.allowed, true);
  equal(reservation.releaseRequired, true);
});

Deno.test("catalog route cannot reserve the model lane", async () => {
  const rpc: PublicApiAdmissionRpc = () => {
    throw new Error("invalid lane must not call RPC");
  };
  const reservation = await reservePublicApiAdmission({
    route: "search-products",
    lanes: ["catalog", "model"],
    rpc,
    readEnv: env(LIMITS),
  });
  equal(reservation.allowed, false);
  equal(reservation.failure, "invalid_route_or_lanes");
});

Deno.test("enforce refuses missing/invalid limits without paid work", async () => {
  const rpc: PublicApiAdmissionRpc = () => {
    throw new Error("bad config must not call RPC");
  };
  const missing = await reservePublicApiAdmission({
    route: "search-products", lanes: ["catalog"], rpc,
    readEnv: env({ PUBLIC_API_ADMISSION_MODE: "enforce" }),
  });
  equal(missing.allowed, false);
  equal(missing.failure, "missing_enforcement_limit");
  const invalid = await reservePublicApiAdmission({
    route: "search-products", lanes: ["catalog"], rpc,
    readEnv: env({
      ...LIMITS, PUBLIC_API_CATALOG_LIMIT_PER_MINUTE: "0",
    }),
  });
  equal(invalid.allowed, false);
  equal(invalid.failure, "invalid_limit");
});

Deno.test("enforce denies limit; observe records over-limit but allows", async () => {
  const rpc: PublicApiAdmissionRpc = (_name, args) => Promise.resolve({
    data: {
      allowed: args.p_mode === "observe",
      reason: args.p_mode === "observe" ? "observed_limit" : "limit_exceeded",
      mode: args.p_mode,
      replayed: false,
      would_reject: true,
      retry_after_seconds: 7,
    },
  });
  for (const mode of ["enforce", "observe"] as const) {
    const reservation = await reservePublicApiAdmission({
      route: "search-products", lanes: ["catalog"], rpc,
      readEnv: env({ ...LIMITS, PUBLIC_API_ADMISSION_MODE: mode }),
    });
    equal(reservation.allowed, mode === "observe");
    equal(reservation.wouldReject, true);
    equal(reservation.retryAfterSeconds, 7);
    equal(reservation.releaseRequired, mode === "observe");
  }
});

Deno.test("a late reserve sees prior cancellation and cannot start paid work", async () => {
  const rpc: PublicApiAdmissionRpc = () => Promise.resolve({ data: {
    allowed: false,
    reason: "cancelled",
    mode: "observe",
    replayed: true,
    would_reject: false,
    retry_after_seconds: null,
  } });
  const reservation = await reservePublicApiAdmission({
    route: "search-products", lanes: ["catalog"], rpc,
    readEnv: env({ ...LIMITS, PUBLIC_API_ADMISSION_MODE: "observe" }),
  });
  equal(reservation.allowed, false);
  equal(reservation.reason, "cancelled");
  equal(reservation.replayed, true);
  equal(reservation.releaseRequired, false);
});

Deno.test("ambiguous timeout is closed in enforce and open in observe, then released", async () => {
  let releases = 0;
  const rpc: PublicApiAdmissionRpc = (name) => name ===
      "reserve_public_api_admission"
    ? new Promise(() => {})
    : (releases++, Promise.resolve({ data: true }));
  for (const mode of ["enforce", "observe"] as const) {
    const reservation = await reservePublicApiAdmission({
      route: "search-products", lanes: ["catalog"], rpc,
      timeoutMs: 1,
      readEnv: env({ ...LIMITS, PUBLIC_API_ADMISSION_MODE: mode }),
    });
    equal(reservation.allowed, mode === "observe");
    equal(reservation.failure, "rpc_timeout");
    equal(reservation.releaseRequired, true);
    equal((await releasePublicApiAdmission({ reservation, rpc })).released, true);
  }
  equal(releases, 2);
});

Deno.test("release retries once and stream wrapper releases on finish", async () => {
  let releases = 0;
  const rpc: PublicApiAdmissionRpc = (name) => {
    if (name === "reserve_public_api_admission") {
      return Promise.resolve({ data: {
        allowed: true, reason: "admitted", mode: "enforce",
        replayed: false, would_reject: false,
        retry_after_seconds: null,
      } });
    }
    releases++;
    return Promise.resolve(releases === 1
      ? { data: null, error: { message: "transient" } }
      : { data: true });
  };
  const reservation = await reservePublicApiAdmission({
    route: "chat-consultant-v3", lanes: ["catalog", "model"],
    rpc, readEnv: env(LIMITS),
  });
  const original = new Response("done", {
    status: 202,
    headers: { "content-type": "text/event-stream", "x-check": "kept" },
  });
  const wrapped = wrapResponseForAdmissionRelease(original, () =>
    releasePublicApiAdmission({ reservation, rpc }));
  equal(wrapped.status, 202);
  equal(wrapped.headers.get("x-check"), "kept");
  equal(await wrapped.text(), "done");
  equal(releases, 2);
});

Deno.test("stream cancellation triggers release even before natural finish", async () => {
  let releases = 0;
  let canceled = false;
  const response = new Response(new ReadableStream<Uint8Array>({
    pull(controller) { controller.enqueue(new Uint8Array([1])); },
    cancel() { canceled = true; },
  }));
  const wrapped = wrapResponseForAdmissionRelease(response, () => {
    releases++;
  });
  const reader = wrapped.body?.getReader();
  assert(reader, "missing stream");
  await reader.read();
  await reader.cancel();
  equal(canceled, true);
  equal(releases, 1);
});

import {
  type PublicSubjectAdmissionRpc,
  releasePublicSubjectAdmission,
  reservePublicSubjectAdmission,
  verifyPublicSubjectProof,
} from "./public-subject-admission.ts";
import { wrapResponseForAdmissionRelease } from "./public-api-admission.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
function equal(actual: unknown, expected: unknown) {
  assert(Object.is(actual, expected), `${actual} !== ${expected}`);
}
function env(values: Record<string, string | undefined>) {
  return (name: string) => values[name];
}
function base64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/gu, "-").replace(/\//gu, "_").replace(/=+$/u, "");
}

const NOW = 1_800_000_000;
const SUBJECT = "a".repeat(64);
const SECRET = new Uint8Array(32).fill(19);
const VALUES = {
  PUBLIC_SUBJECT_ADMISSION_MODE: "enforce",
  PUBLIC_SUBJECT_PROOF_HMAC_KEY: base64url(SECRET),
  PUBLIC_SUBJECT_PROOF_KID: "gateway-1",
  PUBLIC_SUBJECT_LIMIT_PER_MINUTE: "3",
  PUBLIC_SUBJECT_LIMIT_IN_FLIGHT: "2",
};

async function token(claims: Record<string, unknown> = {}, secret = SECRET) {
  const payload = {
    v: 1,
    kid: "gateway-1",
    aud: "volt220-public-api",
    sub: SUBJECT,
    iat: NOW,
    exp: NOW + 30,
    jti: "481f4be9-725e-49d4-a09b-710a60e80c71",
    ...claims,
  };
  const segment = base64url(new TextEncoder().encode(JSON.stringify(payload)));
  const input = `v1.${segment}`;
  const key = await crypto.subtle.importKey(
    "raw",
    secret,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = new Uint8Array(
    await crypto.subtle.sign(
      "HMAC",
      key,
      new TextEncoder().encode(input),
    ),
  );
  return `${input}.${base64url(signature)}`;
}
function request(proof?: string, body = '{"sessionId":"attacker"}') {
  return new Request(
    "https://example.invalid/functions/v1/chat-consultant-v3",
    {
      method: "POST",
      headers: {
        ...(proof ? { "x-volt-subject-proof": proof } : {}),
        "x-forwarded-for": "192.0.2.11",
        "cf-connecting-ip": "192.0.2.12",
        origin: "https://attacker.invalid",
      },
      body,
    },
  );
}
const nowSeconds = () => NOW;

Deno.test("OFF ignores client proof, reads no other env, and never reserves", async () => {
  const read: string[] = [];
  const verification = await verifyPublicSubjectProof({
    req: request("attacker-data"),
    readEnv: (name) => {
      read.push(name);
      return undefined;
    },
  });
  equal(verification.allowed, true);
  equal(verification.mode, "off");
  equal(verification.subjectHash, null);
  equal(JSON.stringify(read), '["PUBLIC_SUBJECT_ADMISSION_MODE"]');
  const rpc: PublicSubjectAdmissionRpc = () => {
    throw new Error("OFF must never call SQL");
  };
  const reservation = await reservePublicSubjectAdmission({
    verification,
    route: "chat-consultant-v3",
    rpc,
    readEnv: env({}),
  });
  equal(reservation.allowed, true);
  equal(reservation.rpcCalled, false);
  equal(reservation.releaseRequired, false);
});

Deno.test("OFF verification cannot bypass an enforcement flip before reserve", async () => {
  const verification = await verifyPublicSubjectProof({
    req: request(),
    readEnv: env({ PUBLIC_SUBJECT_ADMISSION_MODE: "off" }),
  });
  const rpc: PublicSubjectAdmissionRpc = () => {
    throw new Error("mode drift must not call SQL");
  };
  const admission = await reservePublicSubjectAdmission({
    verification,
    route: "search-products",
    rpc,
    readEnv: env({ PUBLIC_SUBJECT_ADMISSION_MODE: "enforce" }),
  });
  equal(admission.allowed, false);
  equal(admission.failure, "invalid_mode");
});

Deno.test("valid HMAC yields only a signed pseudonym, ignoring spoofed browser fields", async () => {
  const verified = await verifyPublicSubjectProof({
    req: request(await token(), '{"sessionId":"b'.concat("b".repeat(64), '"}')),
    readEnv: env(VALUES),
    nowSeconds,
  });
  equal(verified.allowed, true);
  equal(verified.subjectHash, SUBJECT);
  equal(verified.reason, "verified");
  const forged = await verifyPublicSubjectProof({
    req: request(
      await token({ sub: "b".repeat(64) }),
      '{"sessionId":"attacker"}',
    ),
    readEnv: env(VALUES),
    nowSeconds,
  });
  equal(forged.subjectHash, "b".repeat(64));
});

Deno.test("missing, malformed and forged proofs fail closed; observe is non-blocking", async () => {
  const badSignature = await token({}, new Uint8Array(32).fill(20));
  for (
    const input of [
      undefined,
      "garbage",
      badSignature,
      "v1." + "a".repeat(2048),
    ]
  ) {
    const enforced = await verifyPublicSubjectProof({
      req: request(input),
      readEnv: env(VALUES),
      nowSeconds,
    });
    equal(enforced.allowed, false);
    equal(enforced.subjectHash, null);
    equal(
      enforced.failure,
      input === undefined ? "missing_proof" : "invalid_proof",
    );
    const observed = await verifyPublicSubjectProof({
      req: request(input),
      readEnv: env({ ...VALUES, PUBLIC_SUBJECT_ADMISSION_MODE: "observe" }),
      nowSeconds,
    });
    equal(observed.allowed, true);
    equal(observed.wouldReject, true);
    const rpc: PublicSubjectAdmissionRpc = () => {
      throw new Error("no trusted subject means no SQL call");
    };
    const reservation = await reservePublicSubjectAdmission({
      verification: observed,
      route: "search-products",
      rpc,
    });
    equal(reservation.allowed, true);
    equal(reservation.rpcCalled, false);
  }
});

Deno.test("strict signed shape, audience, kid, lifetime and pseudonym", async () => {
  const claims = [
    { kid: "other" },
    { aud: "chat-consultant-v3" },
    { sub: "192.0.2.1" },
    { sub: "A".repeat(64) },
    { iat: NOW + 6 },
    { exp: NOW },
    { exp: NOW + 61 },
    { jti: "client-picked" },
    { extra: "not allowed" },
  ];
  for (const bad of claims) {
    const result = await verifyPublicSubjectProof({
      req: request(await token(bad)),
      readEnv: env(VALUES),
      nowSeconds,
    });
    equal(result.allowed, false);
    equal(result.failure, "invalid_proof");
  }
});

Deno.test("bad proof key/config fails closed in enforce and non-blocking in observe", async () => {
  for (const mode of ["enforce", "observe"] as const) {
    const result = await verifyPublicSubjectProof({
      req: request(await token()),
      readEnv: env({
        ...VALUES,
        PUBLIC_SUBJECT_ADMISSION_MODE: mode,
        PUBLIC_SUBJECT_PROOF_HMAC_KEY: "weak",
      }),
      nowSeconds,
    });
    equal(result.allowed, mode === "observe");
    equal(result.failure, "invalid_proof_config");
  }
});

Deno.test("replayed capability cannot reset a cross-route subject quota", async () => {
  const sharedToken = await token();
  let calls = 0;
  const subjects: string[] = [];
  const ids = new Set<string>();
  const rpc: PublicSubjectAdmissionRpc = (name, args) => {
    equal(name, "reserve_public_subject_admission");
    calls++;
    subjects.push(args.p_subject_hash as string);
    ids.add(args.p_reservation_id as string);
    equal(args.p_window_seconds, 60);
    equal(args.p_max_requests, 3);
    equal(args.p_max_inflight, 2);
    return Promise.resolve({
      data: {
        allowed: calls === 1,
        reason: calls === 1 ? "admitted" : "limit_exceeded",
        mode: "enforce",
        replayed: false,
        would_reject: calls !== 1,
        retry_after_seconds: calls === 1 ? null : 13,
      },
    });
  };
  for (const route of ["chat-consultant-v3", "search-products"] as const) {
    const verified = await verifyPublicSubjectProof({
      req: request(sharedToken, `{"sessionId":"${route}"}`),
      readEnv: env(VALUES),
      nowSeconds,
    });
    const reservation = await reservePublicSubjectAdmission({
      verification: verified,
      route,
      rpc,
      readEnv: env(VALUES),
    });
    equal(reservation.allowed, route === "chat-consultant-v3");
    equal(
      reservation.retryAfterSeconds,
      route === "search-products" ? 13 : null,
    );
  }
  equal(calls, 2);
  equal(ids.size, 2);
  equal(JSON.stringify(subjects), JSON.stringify([SUBJECT, SUBJECT]));
});

Deno.test("missing enforcement limits, invalid limits and mode flip make no RPC", async () => {
  const verification = await verifyPublicSubjectProof({
    req: request(await token()),
    readEnv: env(VALUES),
    nowSeconds,
  });
  const rpc: PublicSubjectAdmissionRpc = () => {
    throw new Error("invalid configuration must not reach SQL");
  };
  const missing = await reservePublicSubjectAdmission({
    verification,
    route: "chat-consultant",
    rpc,
    readEnv: env({ ...VALUES, PUBLIC_SUBJECT_LIMIT_PER_MINUTE: undefined }),
  });
  equal(missing.failure, "missing_enforcement_limit");
  equal(missing.allowed, false);
  const invalid = await reservePublicSubjectAdmission({
    verification,
    route: "chat-consultant",
    rpc,
    readEnv: env({ ...VALUES, PUBLIC_SUBJECT_LIMIT_IN_FLIGHT: "0" }),
  });
  equal(invalid.failure, "invalid_limit");
  const flip = await reservePublicSubjectAdmission({
    verification,
    route: "chat-consultant",
    rpc,
    readEnv: env({ ...VALUES, PUBLIC_SUBJECT_ADMISSION_MODE: "off" }),
  });
  equal(flip.failure, "invalid_mode");
});

Deno.test("observe limit allows but records wouldReject", async () => {
  const settings = { ...VALUES, PUBLIC_SUBJECT_ADMISSION_MODE: "observe" };
  const verification = await verifyPublicSubjectProof({
    req: request(await token()),
    readEnv: env(settings),
    nowSeconds,
  });
  const rpc: PublicSubjectAdmissionRpc = () =>
    Promise.resolve({
      data: {
        allowed: true,
        reason: "observed_limit",
        mode: "observe",
        replayed: false,
        would_reject: true,
        retry_after_seconds: 8,
      },
    });
  const admission = await reservePublicSubjectAdmission({
    verification,
    route: "search-products",
    rpc,
    readEnv: env(settings),
  });
  equal(admission.allowed, true);
  equal(admission.wouldReject, true);
  equal(admission.releaseRequired, true);
});

Deno.test("observe SQL denial remains non-blocking, without phantom release", async () => {
  const settings = { ...VALUES, PUBLIC_SUBJECT_ADMISSION_MODE: "observe" };
  const verification = await verifyPublicSubjectProof({
    req: request(await token()),
    readEnv: env(settings),
    nowSeconds,
  });
  const rpc: PublicSubjectAdmissionRpc = () =>
    Promise.resolve({
      data: {
        allowed: false,
        reason: "reservation_conflict",
        mode: "observe",
        replayed: true,
        would_reject: false,
        retry_after_seconds: null,
      },
    });
  const admission = await reservePublicSubjectAdmission({
    verification,
    route: "search-products",
    rpc,
    readEnv: env(settings),
  });
  equal(admission.allowed, true);
  equal(admission.wouldReject, true);
  equal(admission.releaseRequired, false);
});

Deno.test("observe invalid route is telemetry-only; mode drift is closed", async () => {
  const settings = { ...VALUES, PUBLIC_SUBJECT_ADMISSION_MODE: "observe" };
  const verification = await verifyPublicSubjectProof({
    req: request(await token()),
    readEnv: env(settings),
    nowSeconds,
  });
  const rpc: PublicSubjectAdmissionRpc = () => {
    throw new Error("invalid route/mode should never call SQL");
  };
  const badRoute = await reservePublicSubjectAdmission({
    verification,
    route: "other" as "search-products",
    rpc,
    readEnv: env(settings),
  });
  equal(badRoute.allowed, true);
  equal(badRoute.wouldReject, true);
  equal(badRoute.failure, "invalid_route");
  const drift = await reservePublicSubjectAdmission({
    verification,
    route: "search-products",
    rpc,
    readEnv: env({ ...settings, PUBLIC_SUBJECT_ADMISSION_MODE: "enforce" }),
  });
  equal(drift.allowed, false);
  equal(drift.failure, "invalid_mode");
});

Deno.test("ambiguous reserve fails closed in enforce, opens in observe, and releases", async () => {
  for (const mode of ["enforce", "observe"] as const) {
    const settings = { ...VALUES, PUBLIC_SUBJECT_ADMISSION_MODE: mode };
    const verification = await verifyPublicSubjectProof({
      req: request(await token()),
      readEnv: env(settings),
      nowSeconds,
    });
    let releases = 0;
    const rpc: PublicSubjectAdmissionRpc = (name) =>
      name === "reserve_public_subject_admission"
        ? new Promise(() => {})
        : (releases++, Promise.resolve({ data: true }));
    const reservation = await reservePublicSubjectAdmission({
      verification,
      route: "chat-consultant-v2",
      rpc,
      readEnv: env(settings),
      timeoutMs: 1,
    });
    equal(reservation.allowed, mode === "observe");
    equal(reservation.failure, "rpc_timeout");
    equal(reservation.releaseRequired, true);
    const released = await releasePublicSubjectAdmission({ reservation, rpc });
    equal(released.released, true);
    equal(releases, 1);
  }
});

Deno.test("SSE cancellation releases subject reservation exactly once", async () => {
  let releases = 0;
  const rpc: PublicSubjectAdmissionRpc = (name) =>
    name ===
        "reserve_public_subject_admission"
      ? Promise.resolve({
        data: {
          allowed: true,
          reason: "admitted",
          mode: "enforce",
          replayed: false,
          would_reject: false,
          retry_after_seconds: null,
        },
      })
      : (releases++, Promise.resolve({ data: true }));
  const verification = await verifyPublicSubjectProof({
    req: request(await token()),
    readEnv: env(VALUES),
    nowSeconds,
  });
  const reservation = await reservePublicSubjectAdmission({
    verification,
    route: "chat-consultant-v3",
    rpc,
    readEnv: env(VALUES),
  });
  let cancelled = false;
  const response = new Response(
    new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new Uint8Array([1]));
      },
      cancel() {
        cancelled = true;
      },
    }),
    { headers: { "content-type": "text/event-stream" } },
  );
  const wrapped = wrapResponseForAdmissionRelease(
    response,
    () => releasePublicSubjectAdmission({ reservation, rpc }),
  );
  const reader = wrapped.body?.getReader();
  assert(reader, "missing stream");
  await reader.read();
  await reader.cancel();
  equal(cancelled, true);
  equal(releases, 1);
});

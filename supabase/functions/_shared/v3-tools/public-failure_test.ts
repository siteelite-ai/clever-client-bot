import { assert, assertEquals, assertRejects, assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  classifyPublicFailure,
  isConfirmedTransientUpstreamHttp5xx,
  retryConfirmedUpstreamHttp5xxOnce,
  upstreamFailureDiagnosticMeta,
  UpstreamHttpError,
} from "./public-failure.ts";

function assertPublicOutputIsSafe(value: ReturnType<typeof classifyPublicFailure>) {
  const publicOutput = JSON.stringify(value);
  for (const forbidden of ["openrouter", "workspaces/default/keys", "secret-key-fingerprint", "переформулируйте"]) {
    assert(!publicOutput.toLocaleLowerCase("ru-RU").includes(forbidden));
  }
}

Deno.test("quota response keeps raw detail in the server error but exposes only a safe public code", () => {
  const error = new UpstreamHttpError(
    403,
    '{"error":{"message":"Key limit exceeded. Manage https://openrouter.ai/workspaces/default/keys/secret-key-fingerprint"}}',
  );
  assert(error.message.includes("secret-key-fingerprint"));

  const failure = classifyPublicFailure(error);
  assertEquals(failure.kind, "upstream_quota");
  assertEquals(failure.public_code, "upstream_quota_exceeded");
  assertEquals(failure.retryable, false);
  assertPublicOutputIsSafe(failure);
});

Deno.test("rate limiting is safe and retryable", () => {
  const failure = classifyPublicFailure(new UpstreamHttpError(429, "too many requests"));
  assertEquals(failure.kind, "upstream_rate_limit");
  assertEquals(failure.public_code, "upstream_rate_limited");
  assertEquals(failure.retryable, true);
  assertPublicOutputIsSafe(failure);
});

Deno.test("provider outage is safe and retryable", () => {
  const failure = classifyPublicFailure(new UpstreamHttpError(503, "private upstream diagnostics"));
  assertEquals(failure.kind, "upstream_unavailable");
  assertEquals(failure.retryable, true);
  assert(!JSON.stringify(failure).includes("private upstream diagnostics"));
});

Deno.test("an actual HTTP 502 retains transport provenance without changing public failure", () => {
  const error = new UpstreamHttpError(502, "private provider diagnostic", {
    origin: "http_response",
    observedHttpStatus: 502,
    provider: "openrouter",
    failedOver: false,
    primarySkipped: false,
  });
  assertEquals(error.status, 502);
  assertEquals(upstreamFailureDiagnosticMeta(error), {
    upstream_origin: "http_response",
    observed_http_status: 502,
    upstream_provider: "openrouter",
    provider_failed_over: false,
    primary_http_status: null,
    primary_skipped: false,
  });
  assertEquals(
    classifyPublicFailure(error).public_code,
    "upstream_unavailable",
  );
  assertPublicOutputIsSafe(classifyPublicFailure(error));
});

Deno.test("an unusable HTTP 200 completion keeps synthetic 502 separate from observed status", () => {
  const error = new UpstreamHttpError(502, "secret-key-fingerprint", {
    origin: "completion_envelope",
    observedHttpStatus: 200,
    provider: "lovable",
    failedOver: true,
    primaryStatus: 200,
    primarySkipped: false,
  });
  const diagnostics = upstreamFailureDiagnosticMeta(error);
  assertEquals(diagnostics, {
    upstream_origin: "completion_envelope",
    observed_http_status: 200,
    upstream_provider: "lovable",
    provider_failed_over: true,
    primary_http_status: 200,
    primary_skipped: false,
  });
  assert(!JSON.stringify(diagnostics).includes("secret-key-fingerprint"));
  assertEquals(
    classifyPublicFailure(error).public_code,
    "upstream_unavailable",
  );
  assertPublicOutputIsSafe(classifyPublicFailure(error));
});

Deno.test("only a confirmed real HTTP 5xx is eligible for the narrow correction retry", () => {
  assertEquals(isConfirmedTransientUpstreamHttp5xx(
    new UpstreamHttpError(502, "provider unavailable", {
      origin: "http_response",
      observedHttpStatus: 502,
    }),
  ), true);
  for (const error of [
    new UpstreamHttpError(502, "unusable HTTP 200", {
      origin: "completion_envelope",
      observedHttpStatus: 200,
    }),
    new UpstreamHttpError(502, "mismatched status", {
      origin: "http_response",
      observedHttpStatus: 200,
    }),
    new UpstreamHttpError(402, "quota"),
    new UpstreamHttpError(403, "access"),
    new UpstreamHttpError(429, "rate limit"),
    ...[200, 402, 403, 429].map((primaryStatus) =>
      new UpstreamHttpError(502, "fallback down after primary failure", {
        origin: "http_response",
        observedHttpStatus: 502,
        primaryStatus,
        failedOver: true,
      })
    ),
    new UpstreamHttpError(600, "invalid status"),
    new DOMException("llm_call_timeout:derived_reasoning", "TimeoutError"),
    new DOMException("aborted", "AbortError"),
  ]) {
    assertEquals(isConfirmedTransientUpstreamHttp5xx(error), false);
  }
});

Deno.test("confirmed HTTP 5xx gets one same-operation retry with a fresh bounded timeout", async () => {
  const firstFailure = new UpstreamHttpError(503, "private upstream detail", {
    origin: "http_response",
    observedHttpStatus: 503,
    provider: "openrouter",
  });
  const calls: number[] = [];
  const retryTelemetry: Array<{ status: number; timeout: number }> = [];
  const result = await retryConfirmedUpstreamHttp5xxOnce({
    attempt: async (timeoutMs) => {
      calls.push(timeoutMs);
      if (calls.length === 1) throw firstFailure;
      return "recovered";
    },
    initialTimeoutMs: 8_000,
    retryTimeoutMs: () => 3_100,
    signal: new AbortController().signal,
    onRetry: (error, timeout) =>
      retryTelemetry.push({ status: error.status, timeout }),
    now: () => 1_000,
  });
  assertEquals(result, "recovered");
  assertEquals(calls, [8_000, 3_100]);
  assertEquals(retryTelemetry, [{ status: 503, timeout: 3_100 }]);
});

Deno.test("second HTTP failure is final: never issue a third correction call", async () => {
  const first = new UpstreamHttpError(502, "first", {
    origin: "http_response",
    observedHttpStatus: 502,
  });
  const second = new UpstreamHttpError(503, "second", {
    origin: "http_response",
    observedHttpStatus: 503,
    provider: "lovable",
    failedOver: true,
  });
  let calls = 0;
  let caught: unknown = null;
  try {
    await retryConfirmedUpstreamHttp5xxOnce({
      attempt: async () => {
        calls++;
        throw calls === 1 ? first : second;
      },
      initialTimeoutMs: 8_000,
      retryTimeoutMs: () => 3_000,
      signal: new AbortController().signal,
      now: () => 0,
    });
  } catch (error) {
    caught = error;
  }
  assertEquals(calls, 2);
  assertEquals(caught, second);
  assertEquals(upstreamFailureDiagnosticMeta(caught).upstream_provider, "lovable");
});

Deno.test("synthetic 502, quotas, aborts, timeouts and insufficient time never start a second paid call", async () => {
  const real502 = new UpstreamHttpError(502, "real", {
    origin: "http_response",
    observedHttpStatus: 502,
  });
  for (const [failure, remaining, elapsed, abortTurn] of [
    [new UpstreamHttpError(502, "HTTP 200 envelope", {
      origin: "completion_envelope",
      observedHttpStatus: 200,
    }), 3_000, 0, false],
    [new UpstreamHttpError(402, "quota"), 3_000, 0, false],
    [new UpstreamHttpError(403, "access"), 3_000, 0, false],
    [new UpstreamHttpError(429, "rate"), 3_000, 0, false],
    [new DOMException("llm_call_timeout:derived_reasoning", "TimeoutError"), 3_000, 0, false],
    [new DOMException("aborted", "AbortError"), 3_000, 0, false],
    [real502, 2_499, 0, false],
    [real502, null, 0, false],
    [real502, 3_000, 8_000, false],
    [real502, 3_000, 0, true],
  ] as const) {
    const controller = new AbortController();
    if (abortTurn) controller.abort();
    let calls = 0;
    let currentTime = 0;
    await assertRejects(async () => {
      await retryConfirmedUpstreamHttp5xxOnce({
        attempt: async () => {
          calls++;
          currentTime = elapsed;
          throw failure;
        },
        initialTimeoutMs: 8_000,
        retryTimeoutMs: () => remaining,
        signal: controller.signal,
        now: () => currentTime,
      });
    });
    assertEquals(calls, 1);
  }
});

Deno.test("non-upstream failures add no provider metadata", () => {
  assertEquals(
    upstreamFailureDiagnosticMeta(new Error("private user content")),
    {},
  );
});

Deno.test("completion caller and correction log record bounded provenance only", async () => {
  const source = await Deno.readTextFile(
    new URL("../../chat-consultant-v3/index.ts", import.meta.url),
  );
  const caller = source.slice(
    source.indexOf("async function callOpenRouter("),
    source.indexOf("async function callOpenRouterEvidenceFollowup("),
  );
  assertStringIncludes(caller, 'origin: "http_response"');
  assertStringIncludes(caller, 'origin: "completion_envelope"');
  assertStringIncludes(caller, "observedHttpStatus: res.status");

  const stepStart = source.indexOf(
    'step: "v3_product_measurement_correction_failed"',
  );
  const stepEnd = source.indexOf(
    "return stopForUnverifiedProductMeasurement(",
    stepStart,
  );
  assert(stepStart >= 0 && stepEnd > stepStart);
  const correctionStep = source.slice(stepStart, stepEnd);
  assertStringIncludes(
    correctionStep,
    "...upstreamFailureDiagnosticMeta(correctionError)",
  );
  for (
    const forbidden of [
      "response_body",
      "correctionError.message",
      "JSON.stringify",
    ]
  ) {
    assert(!correctionStep.includes(forbidden));
  }
});

Deno.test("timeouts and aborts receive explicit public codes", () => {
  assertEquals(
    classifyPublicFailure(new DOMException("llm_call_timeout:intro", "TimeoutError")).public_code,
    "request_timeout",
  );
  assertEquals(
    classifyPublicFailure(new DOMException("request aborted", "AbortError")).public_code,
    "request_aborted",
  );
});

Deno.test("arbitrary internal errors never echo their message", () => {
  const failure = classifyPublicFailure(new Error("database-password=do-not-leak"));
  assertEquals(failure.public_code, "internal_error");
  assert(!JSON.stringify(failure).includes("database-password"));
  assertPublicOutputIsSafe(failure);
});

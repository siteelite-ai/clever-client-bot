import { assert, assertEquals, assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  classifyPublicFailure,
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

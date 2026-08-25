import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { classifyPublicFailure, UpstreamHttpError } from "./public-failure.ts";

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

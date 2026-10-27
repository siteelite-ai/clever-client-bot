import {
  assert,
  assertEquals,
  assertRejects,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  geminiMeasurementCorrectionInCohort,
  inspectForcedToolEnvelope,
  retryUnusableGeminiEnvelopeOnce,
  UnusableForcedToolEnvelopeError,
} from "./product-measurement-gemini-correction.ts";
import { UpstreamHttpError } from "./public-failure.ts";

const toolName = "declare_selection_reasoning";
const validArguments = JSON.stringify({
  reasoning:
    "Мощность каждого товара требуется проверить по живой характеристике.",
  measurement_scope: "per_product",
  compatible_classifications: [],
  excluded_classifications: [],
  required_facet_values: [],
  explicit_customer_classifications: [],
});

function completion(
  name = toolName,
  argumentsJson = validArguments,
  finishReason = "tool_calls",
): unknown {
  return {
    choices: [{
      finish_reason: finishReason,
      message: {
        content: null,
        tool_calls: [{
          id: "fixture-call",
          type: "function",
          function: { name, arguments: argumentsJson },
        }],
      },
    }],
  };
}

Deno.test("rollout cohort uses only the supplied original session ID", () => {
  const canary = "0439c735-1e87-4a32-8a6f-4f2a71986292";
  assert(geminiMeasurementCorrectionInCohort(canary, 1));
  assert(!geminiMeasurementCorrectionInCohort("off-cohort-session", 1));
  assert(!geminiMeasurementCorrectionInCohort(canary, 0));
  assert(geminiMeasurementCorrectionInCohort(canary, 10_000));
  assert(!geminiMeasurementCorrectionInCohort("", 10_000));
  // Handler wiring separately proves this input precedes new-task rotation.
});

Deno.test("strict forced-tool inspection accepts only the expected parseable declaration", () => {
  assertEquals(
    inspectForcedToolEnvelope(completion(), toolName).status,
    "usable",
  );
  assertEquals(
    inspectForcedToolEnvelope({ choices: [] }, toolName).status,
    "missing_choice",
  );
  assertEquals(
    inspectForcedToolEnvelope(
      { choices: [{ finish_reason: "stop" }] },
      toolName,
    ).status,
    "missing_message",
  );
  assertEquals(
    inspectForcedToolEnvelope(
      completion(toolName, validArguments, "error"),
      toolName,
    ).status,
    "provider_error",
  );
  assertEquals(
    inspectForcedToolEnvelope(
      completion(toolName, validArguments, "length"),
      toolName,
    ).status,
    "truncated",
  );
  assertEquals(
    inspectForcedToolEnvelope(completion("search_catalog"), toolName).status,
    "wrong_tool_name",
  );
  assertEquals(
    inspectForcedToolEnvelope(completion(toolName, "{"), toolName).status,
    "invalid_arguments",
  );
  assertEquals(
    inspectForcedToolEnvelope(completion(toolName, "{}"), toolName).status,
    "invalid_arguments",
  );
  assertEquals(
    inspectForcedToolEnvelope({
      choices: [{ finish_reason: "stop", message: { content: "prose only" } }],
    }, toolName).status,
    "wrong_tool_count",
  );
});

Deno.test("shape diagnostics contain no model text, arguments, or arbitrary names", () => {
  const shape = inspectForcedToolEnvelope(
    completion("private-model-tool", '{"reasoning":"private secret"}'),
    toolName,
  );
  const serialized = JSON.stringify(shape);
  assertEquals(shape.status, "wrong_tool_name");
  assert(!serialized.includes("private-model-tool"));
  assert(!serialized.includes("private secret"));
});

Deno.test("quick unusable HTTP 200 retries the same Gemini call once and accepts recovery", async () => {
  let calls = 0;
  const retryTimeouts: number[] = [];
  const result = await retryUnusableGeminiEnvelopeOnce({
    attempt: async (timeoutMs) => {
      calls++;
      if (calls === 1) {
        throw new UnusableForcedToolEnvelopeError("missing_choice");
      }
      retryTimeouts.push(timeoutMs);
      return "valid Gemini declaration";
    },
    initialTimeoutMs: 8_000,
    retryTimeoutMs: () => 3_200,
    signal: new AbortController().signal,
  });
  assertEquals(result, "valid Gemini declaration");
  assertEquals(calls, 2);
  assertEquals(retryTimeouts, [3_200]);
});

Deno.test("persistent unusable HTTP 200 stops after one repeat", async () => {
  let calls = 0;
  await assertRejects(() =>
    retryUnusableGeminiEnvelopeOnce({
      attempt: () => {
        calls++;
        throw new UnusableForcedToolEnvelopeError("invalid_arguments");
      },
      initialTimeoutMs: 8_000,
      retryTimeoutMs: () => 3_000,
      signal: new AbortController().signal,
    }), UnusableForcedToolEnvelopeError);
  assertEquals(calls, 2);
});

Deno.test("timeout, quota, auth, rate limit, and HTTP 5xx never trigger the envelope retry", async () => {
  const errors = [
    new DOMException("llm_call_timeout:derived_reasoning", "TimeoutError"),
    new UpstreamHttpError(402, "quota"),
    new UpstreamHttpError(401, "auth"),
    new UpstreamHttpError(429, "rate limit"),
    new UpstreamHttpError(503, "provider down"),
  ];
  for (const error of errors) {
    let calls = 0;
    await assertRejects(() =>
      retryUnusableGeminiEnvelopeOnce({
        attempt: () => {
          calls++;
          throw error;
        },
        initialTimeoutMs: 8_000,
        retryTimeoutMs: () => 4_000,
        signal: new AbortController().signal,
      })
    );
    assertEquals(calls, 1);
  }
});

Deno.test("insufficient remaining deadline and turn abort suppress the paid retry", async () => {
  for (const remaining of [null, 2_499]) {
    let calls = 0;
    await assertRejects(() =>
      retryUnusableGeminiEnvelopeOnce({
        attempt: () => {
          calls++;
          throw new UnusableForcedToolEnvelopeError("missing_choice");
        },
        initialTimeoutMs: 8_000,
        retryTimeoutMs: () => remaining,
        signal: new AbortController().signal,
      }), UnusableForcedToolEnvelopeError);
    assertEquals(calls, 1);
  }
  const controller = new AbortController();
  let calls = 0;
  await assertRejects(() =>
    retryUnusableGeminiEnvelopeOnce({
      attempt: () => {
        calls++;
        controller.abort();
        throw new UnusableForcedToolEnvelopeError("missing_choice");
      },
      initialTimeoutMs: 8_000,
      retryTimeoutMs: () => 4_000,
      signal: controller.signal,
    }), UnusableForcedToolEnvelopeError);
  assertEquals(calls, 1);
});

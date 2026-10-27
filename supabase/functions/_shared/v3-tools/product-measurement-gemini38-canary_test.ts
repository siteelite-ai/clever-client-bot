import {
  assert,
  assertEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  gemini38ForcedToolStatus,
  gemini38MeasurementCohort,
  safeGemini38CorrectionTelemetry,
} from "./product-measurement-gemini38-canary.ts";

const originalSession = "0439c735-1e87-4a32-8a6f-4f2a71986292";

Deno.test("Gemini 3.8 cohort is deterministic from incoming session, not rotated new-topic ID", () => {
  assert(gemini38MeasurementCohort(originalSession, 1));
  assert(!gemini38MeasurementCohort("session_rotated_after_new_topic", 1));
  assert(gemini38MeasurementCohort(originalSession, 1));
  assert(!gemini38MeasurementCohort(originalSession, 0));
  assert(!gemini38MeasurementCohort("", 10_000));
});

Deno.test("Gemini 3.8 forced tool accepts only an object argument for the intended declaration", () => {
  const valid = {
    choices: [{
      finish_reason: "tool_calls",
      message: {
        tool_calls: [{
          type: "function",
          function: {
            name: "declare_selection_reasoning",
            arguments: JSON.stringify({ reasoning: "private model reasoning" }),
          },
        }],
      },
    }],
  };
  assertEquals(
    gemini38ForcedToolStatus(valid, "declare_selection_reasoning"),
    "usable",
  );
  assertEquals(
    gemini38ForcedToolStatus({ choices: [] }, "declare_selection_reasoning"),
    "missing_choice",
  );
  assertEquals(
    gemini38ForcedToolStatus({
      choices: [{ finish_reason: "error", message: {} }],
    }, "declare_selection_reasoning"),
    "provider_error",
  );
  assertEquals(
    gemini38ForcedToolStatus({
      choices: [{ finish_reason: "length", message: {} }],
    }, "declare_selection_reasoning"),
    "truncated",
  );
  assertEquals(
    gemini38ForcedToolStatus({
      choices: [{
        message: {
          tool_calls: [{ function: { name: "wrong", arguments: "{}" } }],
        },
      }],
    }, "declare_selection_reasoning"),
    "wrong_tool_name",
  );
  assertEquals(
    gemini38ForcedToolStatus({
      choices: [{
        message: {
          tool_calls: [{
            function: { name: "declare_selection_reasoning", arguments: "[]" },
          }],
        },
      }],
    }, "declare_selection_reasoning"),
    "invalid_arguments",
  );
});

Deno.test("Gemini 3.8 telemetry strips all model/provider text and arbitrary metadata", () => {
  const secret = "SECRET_USER_TEXT_DO_NOT_LOG";
  const meta = safeGemini38CorrectionTelemetry({
    payload: {
      choices: [{
        finish_reason: "error",
        error: {
          message: secret,
          metadata: {
            error_type: "ProviderError " + secret,
            code: 502,
            provider_code: "RESOURCE_EXHAUSTED",
            details: secret,
          },
        },
        message: {
          content: secret,
          tool_calls: [{ function: { name: secret, arguments: secret } }],
        },
      }],
      usage: {
        prompt_tokens: 42,
        completion_tokens: 8,
        total_tokens: 50,
        prompt: secret,
      },
      openrouter_metadata: {
        summary: secret,
        attempts: [{
          provider: "Google AI Studio",
          status: 200,
          message: secret,
        }],
      },
    },
    generationId: "gen-1234567890abcdef",
    httpStatus: 200,
    elapsedMs: 1250,
    envelopeStatus: "provider_error",
  });
  assertEquals(meta.generation_id, "gen-1234567890abcdef");
  assertEquals(meta.choice_error_type, "other");
  assertEquals(meta.choice_error_code, 502);
  assertEquals(meta.choice_provider_code, "RESOURCE_EXHAUSTED");
  assertEquals(meta.provider, "google_ai_studio");
  assertEquals(meta.router_attempt_count, 1);
  assertEquals(meta.tool_call_count, 1);
  assertEquals(meta.total_tokens, 50);
  assert(!JSON.stringify(meta).includes(secret));
  const badId = safeGemini38CorrectionTelemetry({
    payload: { openrouter_metadata: { summary: secret } },
    generationId: "gen-../../" + secret,
    httpStatus: 502,
    elapsedMs: 300,
    envelopeStatus: null,
  });
  assertEquals(badId.generation_id, null);
  assertEquals(badId.provider, null);
  assert(!JSON.stringify(badId).includes(secret));
  const topLevelError = safeGemini38CorrectionTelemetry({
    payload: {
      id: "gen-abcdef1234567890",
      error: {
        code: 503,
        message: secret,
        metadata: { error_type: "provider_unavailable" },
      },
    },
    generationId: null,
    httpStatus: 503,
    elapsedMs: 200,
    envelopeStatus: null,
  });
  assertEquals(topLevelError.generation_id, "gen-abcdef1234567890");
  assertEquals(topLevelError.choice_error_type, "provider_unavailable");
  assertEquals(topLevelError.choice_error_code, 503);
  assert(!JSON.stringify(topLevelError).includes(secret));
});

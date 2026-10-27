import {
  assert,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";

const source = await Deno.readTextFile(new URL("./index.ts", import.meta.url));

function segment(startMarker: string, endMarker: string): string {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start);
  assert(start >= 0 && end > start, `${startMarker} must precede ${endMarker}`);
  return source.slice(start, end);
}

Deno.test("Gemini is limited to measured-product correction canary, not the primary or other repairs", () => {
  assertStringIncludes(source, 'const MODEL = "deepseek/deepseek-v4-flash"');
  assertStringIncludes(
    source,
    'const PRODUCT_MEASUREMENT_GEMINI_MODEL = "google/gemini-2.5-flash"',
  );
  assertStringIncludes(
    source,
    "PRODUCT_MEASUREMENT_GEMINI_PRODUCTION_BUCKETS_PER_10K = 1;",
  );
  const correction = segment(
    "const geminiCorrectionCanary =",
    "const geminiCorrectionAttempt =",
  );
  assertStringIncludes(correction, 'repairReason === "product_measurement"');
  assertStringIncludes(correction, 'ADMISSION_SCOPE === "production"');
  assertStringIncludes(correction, "ctx.originalSessionId,");
  const attempt = segment(
    "const geminiCorrectionAttempt =",
    "try {\n                if (geminiCorrectionCanary)",
  );
  assertStringIncludes(attempt, "PRODUCT_MEASUREMENT_GEMINI_MODEL_ROUTING,");
  assertStringIncludes(attempt, '"openrouter_only",');
  assertStringIncludes(attempt, '["declare_selection_reasoning"],');
  assertStringIncludes(attempt, '"declare_selection_reasoning",');
  // Off-cohort keeps the exact pre-existing correction, including the current
  // environment-controlled HTTP 5xx retry. It does not use the strict path.
  const route = segment(
    "if (geminiCorrectionCanary) {\n                  steps.push",
    "} catch (correctionError) {",
  );
  assertStringIncludes(route, "retryUnusableGeminiEnvelopeOnce({");
  assertStringIncludes(
    route,
    "} else {\n                  structuredReasoning = await runProductMeasurementCorrection({",
  );
  assertStringIncludes(route, "attempt: correctionAttempt,");
  assertStringIncludes(route, "initialTimeoutMs: correctionTimeout,");
});

Deno.test("new-task rotation cannot change the incoming ID used for canary routing", () => {
  const context = segment(
    "const ctx: ToolContext = {",
    "replacementEgressCache = cache;",
  );
  assertStringIncludes(context, "sessionId: effectiveSessionId,");
  assertStringIncludes(context, "originalSessionId: sessionId,");
  assertStringIncludes(source, "const effectiveSessionId = startsNewTask");
});

Deno.test("strict forced-tool route requires provider support, sanitised envelope, bounded retry, and fail-closed egress", () => {
  const openRouter = segment(
    "async function callOpenRouter(",
    "async function callOpenRouterEvidenceFollowup(",
  );
  assertStringIncludes(openRouter, "provider: { require_parameters: true }");
  assertStringIncludes(
    openRouter,
    "inspectForcedToolEnvelope(data, forcedToolName",
  );
  assertStringIncludes(openRouter, "new UnusableForcedToolEnvelopeError(");
  const correction = segment(
    "const geminiCorrectionAttempt =",
    "recordClosureRetryOutcome(true);",
  );
  assertStringIncludes(correction, "retryTimeoutMs: () =>");
  assertStringIncludes(correction, "DERIVED_REASONING_SOFT_DEADLINE_MS,");
  assertStringIncludes(correction, "MIN_AGENT_STEP_BUDGET_MS,");
  assertStringIncludes(
    correction,
    'step: "v3_product_measurement_gemini_envelope"',
  );
  assertStringIncludes(
    correction,
    'step: "v3_product_measurement_gemini_envelope_retry"',
  );
  assertStringIncludes(
    correction,
    'if (repairReason === "product_measurement")',
  );
  assertStringIncludes(
    correction,
    "return stopForUnverifiedProductMeasurement(",
  );
  assertStringIncludes(
    correction,
    "const productMeasurementGap = requiredProductMeasurementGap();",
  );
  assertStringIncludes(
    correction,
    "return stopForUnverifiedProductMeasurement(productMeasurementGap);",
  );
});

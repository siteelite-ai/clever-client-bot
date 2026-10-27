import {
  assert,
  assertEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";

const source = Deno.readTextFileSync(new URL("./index.ts", import.meta.url));

Deno.test("Gemini 3.8 is isolated to product measurement on original incoming session", () => {
  const gate = source.slice(
    source.indexOf("const gemini38Canary ="),
    source.indexOf("try {", source.indexOf("const gemini38Canary =")),
  );
  assert(gate.includes('repairReason === "product_measurement"'));
  assert(gate.includes('ADMISSION_SCOPE === "production"'));
  assert(gate.includes("ctx.originalSessionId"));
  assert(source.includes("originalSessionId: sessionId,"));
  assert(source.includes("const effectiveSessionId = startsNewTask"));
  assert(source.includes("sessionId: effectiveSessionId,"));
  assert(source.includes('const MODEL = "deepseek/deepseek-v4-flash"'));
  assert(
    source.includes(
      'const PRODUCT_MEASUREMENT_GEMINI38_MODEL = "google/gemini-3.8-flash"',
    ),
  );
});

Deno.test("Gemini 3.8 correction is one app call and retains off-cohort correction route", () => {
  const route = source.slice(
    source.indexOf("if (gemini38Canary) {"),
    source.indexOf(
      "} catch (correctionError)",
      source.indexOf("if (gemini38Canary) {"),
    ),
  );
  const canary = route.slice(0, route.indexOf("} else {"));
  const baseline = route.slice(route.indexOf("} else {"));
  assertEquals(canary.match(/await callOpenRouter\(/g)?.length, 1);
  assert(!canary.includes("runProductMeasurementCorrection"));
  assert(!canary.includes("retryTimeoutMs"));
  assert(baseline.includes("runProductMeasurementCorrection"));
  assert(baseline.includes("correctionAttempt"));
  assert(canary.includes("PRODUCT_MEASUREMENT_GEMINI38_MODEL"));
  assert(canary.includes('"openrouter_only"'));
});

Deno.test("Gemini 3.8 bad forced-tool envelope fails closed without a catalog pass", () => {
  const request = source.slice(
    source.indexOf("async function callOpenRouter("),
    source.indexOf("async function callOpenRouterEvidenceFollowup("),
  );
  assert(request.includes('"X-OpenRouter-Metadata": "enabled"'));
  assert(request.includes("require_parameters: true"));
  assert(request.includes("...(canaryTelemetry ? {} : { temperature })"));
  assert(
    request.includes('order: ["google-ai-studio", "google-vertex/global"]'),
  );
  assert(
    request.includes('only: ["google-ai-studio", "google-vertex/global"]'),
  );
  assert(request.includes("gemini38ForcedToolStatus"));
  assert(request.includes('if (shape !== "usable")'));
  assert(request.includes('origin: "completion_envelope"'));
  const catchBlock = source.slice(
    source.indexOf("} catch (correctionError)"),
    source.indexOf(
      "declarationCall = cleanDeclarationCall(",
      source.indexOf("} catch (correctionError)"),
    ),
  );
  assert(catchBlock.includes("return stopForUnverifiedProductMeasurement("));
});

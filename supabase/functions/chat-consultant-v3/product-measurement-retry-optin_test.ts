import {
  assertEquals,
  assertRejects,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import { UpstreamHttpError } from "../_shared/v3-tools/public-failure.ts";
import { restoreOfflineModuleSetup } from "./model-no-search-integration-fixture.ts";

// The offline fixture intercepts Deno.serve and all server env reads. No real
// catalog, database, browser or paid model is contacted by these tests.
const {
  productMeasurementHttpRetryEnabled,
  runProductMeasurementCorrection,
} = await import("./index.ts");
restoreOfflineModuleSetup();

Deno.test("paid measurement retry is OFF by default and scoped to its server lane", () => {
  const none = () => undefined;
  assertEquals(productMeasurementHttpRetryEnabled("preview", none), false);
  assertEquals(productMeasurementHttpRetryEnabled("production", none), false);
  const previewOnly = (name: string) =>
    name === "VOLT220_PRODUCT_MEASUREMENT_HTTP_RETRY_PREVIEW_ENABLED"
      ? "true"
      : undefined;
  assertEquals(
    productMeasurementHttpRetryEnabled("preview", previewOnly),
    true,
  );
  assertEquals(
    productMeasurementHttpRetryEnabled("production", previewOnly),
    false,
  );
  const productionOnly = (name: string) =>
    name === "VOLT220_PRODUCT_MEASUREMENT_HTTP_RETRY_PRODUCTION_ENABLED"
      ? "true"
      : undefined;
  assertEquals(
    productMeasurementHttpRetryEnabled("preview", productionOnly),
    false,
  );
  assertEquals(
    productMeasurementHttpRetryEnabled("production", productionOnly),
    true,
  );
  assertEquals(
    productMeasurementHttpRetryEnabled("preview", () => "TRUE"),
    false,
  );
});

Deno.test("OFF preserves one paid correction call; ON adds at most one real-HTTP retry", async () => {
  const http503 = new UpstreamHttpError(503, "offline error", {
    origin: "http_response",
    observedHttpStatus: 503,
  });
  let calls = 0;
  let retryNotices = 0;
  const input = {
    repairReason: "product_measurement",
    attempt: async () => {
      calls += 1;
      if (calls === 1) throw http503;
      return "corrected";
    },
    initialTimeoutMs: 8_000,
    retryTimeoutMs: () => 3_000,
    signal: new AbortController().signal,
    onRetry: () => {
      retryNotices += 1;
    },
  };

  await assertRejects(
    () => runProductMeasurementCorrection({ ...input, retryEnabled: false }),
    UpstreamHttpError,
  );
  assertEquals(calls, 1);
  assertEquals(retryNotices, 0);

  calls = 0;
  assertEquals(
    await runProductMeasurementCorrection({ ...input, retryEnabled: true }),
    "corrected",
  );
  assertEquals(calls, 2);
  assertEquals(retryNotices, 1);

  calls = 0;
  retryNotices = 0;
  await assertRejects(
    () =>
      runProductMeasurementCorrection({
        ...input,
        repairReason: "paired_fit",
        retryEnabled: true,
      }),
    UpstreamHttpError,
  );
  assertEquals(calls, 1);
  assertEquals(retryNotices, 0);
});

Deno.test("the malformed HTTP-200 retry is limited to product measurement", async () => {
  const malformed = new UpstreamHttpError(502, "unusable HTTP 200", {
    origin: "completion_envelope",
    observedHttpStatus: 200,
    failedOver: false,
    primaryStatus: null,
    primarySkipped: false,
  });
  for (
    const [reason, expectedCalls] of [
      ["product_measurement", 2],
      ["invalid_declaration", 1],
      ["paired_fit", 1],
      ["environmental_protection", 1],
    ] as const
  ) {
    let calls = 0;
    const attempt = async () => {
      calls++;
      if (calls === 1) throw malformed;
      return "valid second contract";
    };
    const input = {
      repairReason: reason,
      retryEnabled: false,
      envelopeRetryEnabled: true,
      attempt,
      initialTimeoutMs: 8_000,
      retryTimeoutMs: () => 3_000,
      signal: new AbortController().signal,
    };
    if (expectedCalls === 2) {
      assertEquals(
        await runProductMeasurementCorrection(input),
        "valid second contract",
      );
    } else {
      await assertRejects(
        () => runProductMeasurementCorrection(input),
        UpstreamHttpError,
      );
    }
    assertEquals(calls, expectedCalls);
  }
});

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
  productMeasurementProCorrectionEnabled,
  productMeasurementProCorrectionRoute,
  runProductMeasurementCorrection,
} = await import("./index.ts");
restoreOfflineModuleSetup();

Deno.test("DeepSeek Pro correction is OFF outside the explicitly opted-in closed preview", () => {
  const enabled = "true";
  assertEquals(
    productMeasurementProCorrectionEnabled({
      admissionScope: "production",
      closureScope: "closure_preview",
      enabled,
    }),
    false,
  );
  assertEquals(
    productMeasurementProCorrectionEnabled({
      admissionScope: "preview",
      closureScope: undefined,
      enabled,
    }),
    false,
  );
  assertEquals(
    productMeasurementProCorrectionEnabled({
      admissionScope: "preview",
      closureScope: "closure_preview",
      enabled: undefined,
    }),
    false,
  );
  assertEquals(
    productMeasurementProCorrectionEnabled({
      admissionScope: "preview",
      closureScope: "closure_preview",
      enabled: "TRUE",
    }),
    false,
  );
  assertEquals(
    productMeasurementProCorrectionEnabled({
      admissionScope: "preview",
      closureScope: "closure_preview",
      enabled,
    }),
    true,
  );
});

Deno.test("pinned Pro route applies only to product_measurement", () => {
  assertEquals(
    productMeasurementProCorrectionRoute({
      repairReason: "product_measurement",
      enabled: false,
    }),
    null,
  );
  for (
    const repairReason of [
      "invalid_declaration",
      "environmental_protection",
      "paired_fit",
    ]
  ) {
    assertEquals(
      productMeasurementProCorrectionRoute({
        repairReason,
        enabled: true,
      }),
      null,
    );
  }
  assertEquals(
    productMeasurementProCorrectionRoute({
      repairReason: "product_measurement",
      enabled: true,
    }),
    {
      modelRouting: { model: "deepseek/deepseek-v4-pro-0813" },
      providerRoute: "openrouter_only",
      requestedModel: "deepseek/deepseek-v4-pro-0813",
    },
  );
});

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

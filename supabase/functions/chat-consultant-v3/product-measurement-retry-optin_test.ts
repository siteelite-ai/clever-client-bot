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
  runProductMeasurementProCorrectionWithFallback,
} = await import("./index.ts");
restoreOfflineModuleSetup();

Deno.test("DeepSeek Pro correction is released only for production or opted-in closed preview", () => {
  const enabled = "true";
  assertEquals(
    productMeasurementProCorrectionEnabled({
      admissionScope: "production",
      closureScope: undefined,
      enabled: undefined,
      productionEnabled: true,
    }),
    true,
  );
  assertEquals(
    productMeasurementProCorrectionEnabled({
      admissionScope: "production",
      closureScope: "closure_preview",
      enabled,
      productionEnabled: false,
    }),
    false,
  );
  assertEquals(
    productMeasurementProCorrectionEnabled({
      admissionScope: "production",
      closureScope: undefined,
      enabled: undefined,
    }),
    false,
  );
  assertEquals(
    productMeasurementProCorrectionEnabled({
      admissionScope: "preview",
      closureScope: undefined,
      enabled,
      productionEnabled: true,
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
      productionEnabled: false,
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

Deno.test("production Pro correction falls back once on HTTP 5xx or unusable completion", async () => {
  for (
    const failure of [
      new UpstreamHttpError(503, "offline provider outage", {
        origin: "http_response",
        observedHttpStatus: 503,
      }),
      new UpstreamHttpError(502, "offline unusable completion", {
        origin: "completion_envelope",
        observedHttpStatus: 200,
      }),
    ]
  ) {
    let proCalls = 0;
    let legacyCalls = 0;
    let notices = 0;
    const result = await runProductMeasurementProCorrectionWithFallback({
      attemptPro: async (timeoutMs) => {
        assertEquals(timeoutMs, 8_000);
        proCalls++;
        throw failure;
      },
      attemptLegacy: async (timeoutMs) => {
        assertEquals(timeoutMs, 3_000);
        legacyCalls++;
        return "legacy-corrected";
      },
      proTimeoutMs: 8_000,
      fallbackTimeoutMs: () => 3_000,
      signal: new AbortController().signal,
      onFallback: (error, timeoutMs) => {
        assertEquals(error, failure);
        assertEquals(timeoutMs, 3_000);
        notices++;
      },
    });
    assertEquals(result, "legacy-corrected");
    assertEquals(proCalls, 1);
    assertEquals(legacyCalls, 1);
    assertEquals(notices, 1);
  }
});

Deno.test("production Pro correction never pays for an ineligible or late fallback", async () => {
  const errors = [
    new UpstreamHttpError(402, "offline quota"),
    new UpstreamHttpError(429, "offline rate limit"),
    new UpstreamHttpError(401, "offline auth"),
    new UpstreamHttpError(400, "offline malformed request"),
    new UpstreamHttpError(429, "offline rate limit envelope", {
      origin: "completion_envelope",
      observedHttpStatus: 200,
    }),
    new UpstreamHttpError(402, "offline quota envelope", {
      origin: "completion_envelope",
      observedHttpStatus: 200,
    }),
    new DOMException("offline aborted", "AbortError"),
    new Error("offline internal error"),
  ];
  for (const failure of errors) {
    let legacyCalls = 0;
    await assertRejects(
      () =>
        runProductMeasurementProCorrectionWithFallback({
          attemptPro: async () => {
            throw failure;
          },
          attemptLegacy: async () => {
            legacyCalls++;
            return "unexpected";
          },
          proTimeoutMs: 8_000,
          fallbackTimeoutMs: () => 3_000,
          signal: new AbortController().signal,
        }),
    );
    assertEquals(legacyCalls, 0, failure.message);
  }

  const transient = new UpstreamHttpError(502, "offline outage");
  for (const budget of [null, 0, 2_499, Number.NaN, Number.POSITIVE_INFINITY]) {
    let legacyCalls = 0;
    await assertRejects(
      () =>
        runProductMeasurementProCorrectionWithFallback({
          attemptPro: async () => {
            throw transient;
          },
          attemptLegacy: async () => {
            legacyCalls++;
            return "unexpected";
          },
          proTimeoutMs: 8_000,
          fallbackTimeoutMs: () => budget,
          signal: new AbortController().signal,
        }),
      UpstreamHttpError,
    );
    assertEquals(legacyCalls, 0);
  }

  const controller = new AbortController();
  let abortedFallbackCalls = 0;
  await assertRejects(
    () =>
      runProductMeasurementProCorrectionWithFallback({
        attemptPro: async () => {
          controller.abort();
          throw transient;
        },
        attemptLegacy: async () => {
          abortedFallbackCalls++;
          return "unexpected";
        },
        proTimeoutMs: 8_000,
        fallbackTimeoutMs: () => 3_000,
        signal: controller.signal,
      }),
    UpstreamHttpError,
  );
  assertEquals(abortedFallbackCalls, 0);

  const callbackController = new AbortController();
  let callbackFallbackCalls = 0;
  await assertRejects(
    () =>
      runProductMeasurementProCorrectionWithFallback({
        attemptPro: async () => {
          throw transient;
        },
        attemptLegacy: async () => {
          callbackFallbackCalls++;
          return "unexpected";
        },
        proTimeoutMs: 8_000,
        fallbackTimeoutMs: () => 3_000,
        signal: callbackController.signal,
        onFallback: () => callbackController.abort(),
      }),
    UpstreamHttpError,
  );
  assertEquals(callbackFallbackCalls, 0);
});

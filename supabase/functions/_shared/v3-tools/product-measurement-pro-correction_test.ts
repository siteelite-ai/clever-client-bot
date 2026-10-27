import {
  assert,
  assertEquals,
  assertRejects,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  inspectForcedToolEnvelope,
  planProductMeasurementProCorrection,
  productMeasurementProCorrectionEnabled,
  proCorrectionSessionInRollout,
  runHedgedProductMeasurementProCorrection,
} from "./product-measurement-pro-correction.ts";
import {
  upstreamFailureDiagnosticMeta,
  UpstreamHttpError,
} from "./public-failure.ts";

const expectedTool = "declare_selection_reasoning";
const validPayload = {
  choices: [{
    finish_reason: "tool_calls",
    message: {
      content: null,
      tool_calls: [{
        function: {
          name: expectedTool,
          arguments: '{"text":"valid"}',
        },
      }],
    },
  }],
};

Deno.test("forced-tool inspector rejects missing, wrong and malformed envelopes without text", () => {
  assertEquals(
    inspectForcedToolEnvelope({}, expectedTool).status,
    "missing_choice",
  );
  assertEquals(
    inspectForcedToolEnvelope({
      choices: [{ message: { content: "private customer text" } }],
    }, expectedTool),
    {
      status: "wrong_tool_count",
      finishReason: "missing",
      toolCallCount: 0,
      contentPresent: true,
    },
  );
  assertEquals(
    inspectForcedToolEnvelope({
      choices: [{
        finish_reason: "tool_calls",
        message: {
          tool_calls: [{ function: { name: "other", arguments: "{}" } }],
        },
      }],
    }, expectedTool).status,
    "wrong_tool_name",
  );
  for (const argumentsText of ["{broken", "null", "[]", "42"]) {
    assertEquals(
      inspectForcedToolEnvelope({
        choices: [{
          finish_reason: "tool_calls",
          message: {
            tool_calls: [{
              function: { name: expectedTool, arguments: argumentsText },
            }],
          },
        }],
      }, expectedTool).status,
      "invalid_arguments",
    );
  }
  assertEquals(
    inspectForcedToolEnvelope({
      choices: [{ ...validPayload.choices[0], finish_reason: "length" }],
    }, expectedTool).status,
    "truncated",
  );
  assertEquals(inspectForcedToolEnvelope(validPayload, expectedTool), {
    status: "usable",
    finishReason: "tool_calls",
    toolCallCount: 1,
    contentPresent: false,
  });
});

Deno.test("completion diagnostics expose only bounded shape, never provider content", () => {
  const shape = inspectForcedToolEnvelope({
    choices: [{
      finish_reason: "unexpected-private-value",
      message: {
        content: "private customer text",
        tool_calls: [{
          function: { name: expectedTool, arguments: "private secret" },
        }],
      },
    }],
  }, expectedTool);
  const error = new UpstreamHttpError(502, "unusable completion", {
    origin: "completion_envelope",
    observedHttpStatus: 200,
    completionShape: shape,
  });
  const metadata = upstreamFailureDiagnosticMeta(error);
  assertEquals(metadata.completion_shape_status, "invalid_arguments");
  assertEquals(metadata.completion_finish_reason, "other");
  assertEquals(metadata.completion_content_present, true);
  assert(!JSON.stringify(metadata).includes("private"));
});

Deno.test("hedge budget preserves eight seconds for Flash at failed-canary timing", () => {
  const atCanaryStart = planProductMeasurementProCorrection({
    elapsedMs: 15_083,
    softDeadlineMs: 26_000,
    legacyTimeoutMs: 8_000,
    proMaxTimeoutMs: 8_000,
  });
  assertEquals(atCanaryStart, {
    route: "hedged",
    proTimeoutMs: 8_000,
    legacyTimeoutMs: 8_000,
    legacyGraceMs: 1_500,
  });
  const early = planProductMeasurementProCorrection({
    elapsedMs: 10_000,
    softDeadlineMs: 26_000,
    legacyTimeoutMs: 8_000,
    proMaxTimeoutMs: 8_000,
  });
  assertEquals(early, {
    route: "hedged",
    proTimeoutMs: 8_000,
    legacyTimeoutMs: 8_000,
    legacyGraceMs: 1_500,
  });
  assertEquals(
    planProductMeasurementProCorrection({
      elapsedMs: 19_000,
      softDeadlineMs: 26_000,
      legacyTimeoutMs: 8_000,
      proMaxTimeoutMs: 8_000,
    }),
    { route: "legacy", timeoutMs: 7_000 },
  );
});

Deno.test("hedge needs the full baseline Flash timeout after grace and reserve", () => {
  const planWithRemaining = (remainingMs: number) =>
    planProductMeasurementProCorrection({
      elapsedMs: 26_000 - remainingMs,
      softDeadlineMs: 26_000,
      legacyTimeoutMs: 8_000,
      proMaxTimeoutMs: 8_000,
    });
  // The optional Pro route must not shorten the legacy 8s request, even when
  // the remaining turn budget could accommodate a 6.5-7.9s Flash attempt.
  assertEquals(planWithRemaining(8_500), { route: "legacy", timeoutMs: 8_000 });
  assertEquals(planWithRemaining(9_900), { route: "legacy", timeoutMs: 8_000 });
  assertEquals(planWithRemaining(9_999), { route: "legacy", timeoutMs: 8_000 });
  assertEquals(planWithRemaining(10_000), {
    route: "hedged",
    proTimeoutMs: 8_000,
    legacyTimeoutMs: 8_000,
    legacyGraceMs: 1_500,
  });
  // Below the original call timeout, the non-hedged branch keeps its prior
  // behavior: only the remaining soft-deadline budget is available.
  assertEquals(planWithRemaining(7_000), { route: "legacy", timeoutMs: 7_000 });
});

Deno.test("production canary cohort is deterministic and zero is always off", () => {
  assertEquals(proCorrectionSessionInRollout("session-1", 0), false);
  assertEquals(proCorrectionSessionInRollout("session-1", 10_000), true);
  assertEquals(proCorrectionSessionInRollout("", 10_000), false);
  const selected = Array.from({ length: 50_000 }, (_, i) => `session-${i}`)
    .find((id) => proCorrectionSessionInRollout(id, 1));
  assert(selected);
  assertEquals(proCorrectionSessionInRollout(selected, 1), true);
  const enabledInput = {
    scope: "production" as const,
    closureScope: null,
    sessionId: selected,
    productionBucketsPer10k: 1,
    readEnv: () => undefined,
  };
  assertEquals(productMeasurementProCorrectionEnabled(enabledInput), true);
  assertEquals(productMeasurementProCorrectionEnabled({
    ...enabledInput,
    productionBucketsPer10k: 0,
  }), false);
  assertEquals(productMeasurementProCorrectionEnabled({
    ...enabledInput,
    readEnv: () => "false",
  }), false);
  assertEquals(productMeasurementProCorrectionEnabled({
    ...enabledInput,
    scope: "preview",
    readEnv: () => "true",
  }), false);
  assertEquals(productMeasurementProCorrectionEnabled({
    ...enabledInput,
    scope: "preview",
    closureScope: "closure_preview",
    readEnv: () => "true",
  }), true);
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

const unusable = () =>
  new UpstreamHttpError(502, "unusable completion", {
    origin: "completion_envelope",
    observedHttpStatus: 200,
  });

Deno.test("valid Pro before grace avoids the extra paid Flash attempt", async () => {
  let legacyCalls = 0;
  const result = await runHedgedProductMeasurementProCorrection({
    attemptPro: async () => "pro declaration",
    attemptLegacy: async () => {
      legacyCalls++;
      return "legacy declaration";
    },
    proTimeoutMs: 8_000,
    legacyTimeoutMs: 8_000,
    legacyGraceMs: 50,
    signal: new AbortController().signal,
  });
  assertEquals(result, { value: "pro declaration", route: "pro" });
  assertEquals(legacyCalls, 0);
});

Deno.test("malformed Pro HTTP 200 starts and returns validated Flash", async () => {
  let legacyCalls = 0;
  let proFailures = 0;
  const result = await runHedgedProductMeasurementProCorrection({
    attemptPro: async () => {
      throw unusable();
    },
    attemptLegacy: async () => {
      legacyCalls++;
      return "legacy declaration";
    },
    proTimeoutMs: 8_000,
    legacyTimeoutMs: 8_000,
    legacyGraceMs: 50,
    signal: new AbortController().signal,
    onProFailure: () => {
      proFailures++;
    },
  });
  assertEquals(result, { value: "legacy declaration", route: "legacy" });
  assertEquals([legacyCalls, proFailures], [1, 1]);
});

Deno.test("valid Flash is buffered and valid Pro is preferred within Pro deadline", async () => {
  const pro = deferred<string>();
  const legacyStarted = deferred<void>();
  const result = runHedgedProductMeasurementProCorrection({
    attemptPro: () => pro.promise,
    attemptLegacy: async () => {
      legacyStarted.resolve();
      return "legacy declaration";
    },
    proTimeoutMs: 8_000,
    legacyTimeoutMs: 8_000,
    legacyGraceMs: 1,
    signal: new AbortController().signal,
  });
  await legacyStarted.promise;
  pro.resolve("pro declaration");
  assertEquals(await result, { value: "pro declaration", route: "pro" });
});

Deno.test("buffered valid Flash rescues Pro timeout; malformed Flash does not beat valid Pro", async () => {
  const pro = deferred<string>();
  const legacyStarted = deferred<void>();
  const rescued = runHedgedProductMeasurementProCorrection({
    attemptPro: () => pro.promise,
    attemptLegacy: async () => {
      legacyStarted.resolve();
      return "legacy declaration";
    },
    proTimeoutMs: 8_000,
    legacyTimeoutMs: 8_000,
    legacyGraceMs: 1,
    signal: new AbortController().signal,
  });
  await legacyStarted.promise;
  pro.reject(new DOMException("model timeout", "TimeoutError"));
  assertEquals(await rescued, { value: "legacy declaration", route: "legacy" });

  const validPro = deferred<string>();
  const flashFailed = deferred<void>();
  const preferred = runHedgedProductMeasurementProCorrection({
    attemptPro: () => validPro.promise,
    attemptLegacy: async () => {
      flashFailed.resolve();
      throw unusable();
    },
    proTimeoutMs: 8_000,
    legacyTimeoutMs: 8_000,
    legacyGraceMs: 1,
    signal: new AbortController().signal,
  });
  await flashFailed.promise;
  validPro.resolve("pro declaration");
  assertEquals(await preferred, { value: "pro declaration", route: "pro" });
});

Deno.test("both malformed corrections surface typed legacy failure, not AggregateError", async () => {
  const legacyError = new UpstreamHttpError(503, "legacy unavailable");
  await assertRejects(
    () =>
      runHedgedProductMeasurementProCorrection({
        attemptPro: async () => {
          throw unusable();
        },
        attemptLegacy: async () => {
          throw legacyError;
        },
        proTimeoutMs: 8_000,
        legacyTimeoutMs: 8_000,
        legacyGraceMs: 1,
        signal: new AbortController().signal,
      }),
    UpstreamHttpError,
    "legacy unavailable",
  );
});

Deno.test("turn abort cancels both hedge branches and does not return buffered Flash", async () => {
  const turn = new AbortController();
  const started = deferred<void>();
  let proAborted = false;
  let legacyAborted = false;
  const pending = runHedgedProductMeasurementProCorrection({
    attemptPro: (_timeout, signal) =>
      new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => {
          proAborted = true;
          reject(new DOMException("aborted", "AbortError"));
        }, { once: true });
      }),
    attemptLegacy: (_timeout, signal) =>
      new Promise((_resolve, reject) => {
        started.resolve();
        signal.addEventListener("abort", () => {
          legacyAborted = true;
          reject(new DOMException("aborted", "AbortError"));
        }, { once: true });
      }),
    proTimeoutMs: 8_000,
    legacyTimeoutMs: 8_000,
    legacyGraceMs: 1,
    signal: turn.signal,
  });
  await started.promise;
  turn.abort(new DOMException("turn aborted", "AbortError"));
  await assertRejects(() => pending, DOMException);
  assertEquals([proAborted, legacyAborted], [true, true]);
});

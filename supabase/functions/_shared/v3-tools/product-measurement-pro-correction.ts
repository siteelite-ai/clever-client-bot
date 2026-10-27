import type { SafeCompletionShape } from "./public-failure.ts";

/** Inspect a forced-tool response without ever retaining provider prose or arguments. */
export function inspectForcedToolEnvelope(
  payload: unknown,
  expectedToolName: string,
): SafeCompletionShape {
  const root = isRecord(payload) ? payload : {};
  const choices = Array.isArray(root.choices) ? root.choices : [];
  const choice = isRecord(choices[0]) ? choices[0] : null;
  const rawFinish = choice?.finish_reason;
  const finishReason = rawFinish === "tool_calls" || rawFinish === "stop" ||
      rawFinish === "length" || rawFinish === "error"
    ? rawFinish
    : rawFinish === null || rawFinish === undefined
    ? "missing"
    : "other";
  const message = isRecord(choice?.message) ? choice.message : null;
  const calls = Array.isArray(message?.tool_calls) ? message.tool_calls : [];
  const shape: SafeCompletionShape = {
    status: "usable",
    finishReason,
    toolCallCount: Math.min(calls.length, 20),
    contentPresent: typeof message?.content === "string" &&
      message.content.length > 0,
  };
  if (!choice) shape.status = "missing_choice";
  else if (!message) shape.status = "missing_message";
  else if (finishReason === "error" || rawFinish === "content_filter") {
    shape.status = "provider_error";
  } else if (finishReason === "length") shape.status = "truncated";
  else if (calls.length !== 1) shape.status = "wrong_tool_count";
  else {
    const call = isRecord(calls[0]) ? calls[0] : {};
    const fn = isRecord(call.function) ? call.function : {};
    if (fn.name !== expectedToolName) shape.status = "wrong_tool_name";
    else {
      try {
        const args = JSON.parse(String(fn.arguments ?? ""));
        if (!isRecord(args)) shape.status = "invalid_arguments";
      } catch {
        shape.status = "invalid_arguments";
      }
    }
  }
  return shape;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export type ProCorrectionBudget =
  | { route: "legacy"; timeoutMs: number }
  | {
    route: "hedged";
    proTimeoutMs: number;
    legacyTimeoutMs: number;
    legacyGraceMs: number;
  };

/** Code-reviewed rollout cohort, not an authentication boundary. Zero means
 * no production user can reach the experimental model after code deployment. */
export function proCorrectionSessionInRollout(
  sessionId: string,
  bucketsPerTenThousand: number,
): boolean {
  const buckets = Number.isFinite(bucketsPerTenThousand)
    ? Math.max(0, Math.min(10_000, Math.floor(bucketsPerTenThousand)))
    : 0;
  if (buckets === 0 || !sessionId) return false;
  let hash = 0x811c9dc5;
  for (let i = 0; i < sessionId.length; i++) {
    hash ^= sessionId.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0) % 10_000 < buckets;
}

/** An experimental route cannot activate in production by deploying its
 * implementation alone. Preview additionally needs the closure wrapper. */
export function productMeasurementProCorrectionEnabled(input: {
  scope: "production" | "preview";
  closureScope: unknown;
  sessionId: string;
  productionBucketsPer10k: number;
  readEnv: (name: string) => string | undefined;
}): boolean {
  if (input.scope === "preview") {
    return input.closureScope === "closure_preview" &&
      input.readEnv("VOLT220_PRODUCT_MEASUREMENT_PRO_CLOSURE_PREVIEW_ENABLED") ===
        "true";
  }
  return input.readEnv("VOLT220_PRODUCT_MEASUREMENT_PRO_PRODUCTION_ENABLED") !==
      "false" &&
    proCorrectionSessionInRollout(
      input.sessionId,
      input.productionBucketsPer10k,
    );
}

/** The optional Pro call cannot delay the original useful Flash correction.
 * Both calls have individual deadlines inside the existing reasoning soft
 * deadline, which already reserves six seconds for catalog work and SSE. */
export function planProductMeasurementProCorrection(input: {
  elapsedMs: number;
  softDeadlineMs: number;
  legacyTimeoutMs: number;
  proMaxTimeoutMs: number;
}): ProCorrectionBudget {
  const remaining = Math.floor(input.softDeadlineMs - input.elapsedMs);
  const legacyTimeoutMs = Math.min(input.legacyTimeoutMs, remaining);
  const minimumLegacyMs = 6_500;
  const legacyGraceMs = 1_500;
  const transitionReserveMs = 500;
  const hedgedLegacyTimeoutMs = Math.min(
    input.legacyTimeoutMs,
    remaining - legacyGraceMs - transitionReserveMs,
  );
  const proTimeoutMs = Math.min(
    input.proMaxTimeoutMs,
    remaining - transitionReserveMs,
  );
  if (
    !Number.isFinite(remaining) || !Number.isFinite(legacyTimeoutMs) ||
    !Number.isFinite(proTimeoutMs) || !Number.isFinite(hedgedLegacyTimeoutMs) ||
    hedgedLegacyTimeoutMs < minimumLegacyMs
  ) {
    return { route: "legacy", timeoutMs: legacyTimeoutMs };
  }
  return {
    route: "hedged",
    proTimeoutMs: Math.floor(proTimeoutMs),
    legacyTimeoutMs: Math.floor(hedgedLegacyTimeoutMs),
    legacyGraceMs,
  };
}

type CorrectionOutcome<T> =
  | { route: "pro" | "legacy"; ok: true; value: T }
  | { route: "pro" | "legacy"; ok: false; error: unknown };

/** Run a rare, opt-in hedge: start Pro now, launch the original model after
 * a short grace if Pro is still unresolved. A valid legacy declaration is
 * buffered until Pro's bounded deadline so a real Pro canary is observable;
 * invalid Pro output then immediately releases that legacy result. Promise
 * rejection handlers are installed before either request starts. */
export async function runHedgedProductMeasurementProCorrection<T>(input: {
  attemptPro: (timeoutMs: number, signal: AbortSignal) => Promise<T>;
  attemptLegacy: (timeoutMs: number, signal: AbortSignal) => Promise<T>;
  proTimeoutMs: number;
  legacyTimeoutMs: number;
  legacyGraceMs: number;
  signal: AbortSignal;
  onLegacyStarted?: () => void;
  onProFailure?: (error: unknown) => void;
}): Promise<{ value: T; route: "pro" | "legacy" }> {
  if (input.signal.aborted) {
    throw input.signal.reason ?? new DOMException("Turn aborted", "AbortError");
  }
  const proController = new AbortController();
  const legacyController = new AbortController();
  const abortChildren = () => {
    proController.abort(input.signal.reason);
    legacyController.abort(input.signal.reason);
  };
  input.signal.addEventListener("abort", abortChildren, { once: true });
  let graceTimer: ReturnType<typeof setTimeout> | undefined;
  const settle = (
    route: "pro" | "legacy",
    run: () => Promise<T>,
  ): Promise<CorrectionOutcome<T>> =>
    Promise.resolve().then(run).then(
      (value) => ({ route, ok: true, value }),
      (error) => {
        if (route === "pro" && !proController.signal.aborted) {
          try {
            input.onProFailure?.(error);
          } catch { /* diagnostics only */ }
        }
        return { route, ok: false, error };
      },
    );
  const pro = settle(
    "pro",
    () => input.attemptPro(input.proTimeoutMs, proController.signal),
  );
  const startLegacy = () => {
    input.onLegacyStarted?.();
    return settle(
      "legacy",
      () => input.attemptLegacy(input.legacyTimeoutMs, legacyController.signal),
    );
  };
  const returnWinner = (outcome: CorrectionOutcome<T>) => {
    if (!outcome.ok) throw outcome.error;
    if (input.signal.aborted) {
      throw input.signal.reason ??
        new DOMException("Turn aborted", "AbortError");
    }
    if (outcome.route === "pro") legacyController.abort();
    else proController.abort();
    return { value: outcome.value, route: outcome.route };
  };
  try {
    const grace = new Promise<"grace">((resolve) => {
      graceTimer = setTimeout(() => resolve("grace"), input.legacyGraceMs);
    });
    const beforeGrace = await Promise.race([pro, grace]);
    if (beforeGrace !== "grace" && beforeGrace.ok) {
      return returnWinner(beforeGrace);
    }
    if (input.signal.aborted) {
      throw input.signal.reason ??
        new DOMException("Turn aborted", "AbortError");
    }
    if (graceTimer !== undefined) clearTimeout(graceTimer);
    const legacy = startLegacy();
    if (beforeGrace !== "grace") {
      return returnWinner(await legacy);
    }
    const first = await Promise.race([pro, legacy]);
    if (first.route === "pro" && first.ok) return returnWinner(first);
    if (first.route === "legacy" && first.ok) {
      // Keep Flash as a valid rescue answer, but give Pro only its already
      // bounded request deadline to prove a better correction.
      const proResult = await pro;
      return returnWinner(proResult.ok ? proResult : first);
    }
    // Both promises settle into data, so the loser never rejects unhandled.
    const second = await (first.route === "pro" ? legacy : pro);
    if (second.ok) return returnWinner(second);
    // The old model's failure is the most useful baseline classification.
    if (first.route === "legacy" && !first.ok) throw first.error;
    if (!second.ok) throw second.error;
    throw new Error("unreachable_correction_outcome");
  } finally {
    if (graceTimer !== undefined) clearTimeout(graceTimer);
    input.signal.removeEventListener("abort", abortChildren);
    proController.abort();
    legacyController.abort();
  }
}

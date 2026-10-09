import { runWithDeadline } from "./turn-deadline.ts";

export interface SettingsReadResult<T> {
  data: T | null;
  status: "ok" | "unavailable";
  attempts: number;
  failure: "query_error" | "timeout" | "missing_row" | null;
}

/**
 * A transient settings-query failure must not masquerade as a missing API key.
 * Retry only the bounded read; never retry catalog/model work or an accepted
 * turn. The caller can still fall back to environment secrets if configured.
 */
export async function readSettingsRowWithRetry<T>(
  read: (signal: AbortSignal) => PromiseLike<{ data: T | null; error?: unknown }>,
  outerSignal: AbortSignal,
  timeoutMs = 2_500,
  maxAttempts = 2,
): Promise<SettingsReadResult<T>> {
  const boundedAttempts = Math.max(1, Math.min(2, Math.trunc(maxAttempts)));
  let failure: SettingsReadResult<T>["failure"] = null;
  for (let attempt = 1; attempt <= boundedAttempts; attempt++) {
    if (outerSignal.aborted) throw outerSignal.reason;
    try {
      const result = await runWithDeadline(
        (attemptSignal) =>
          read(AbortSignal.any([outerSignal, attemptSignal])),
        timeoutMs,
      );
      if (!result.error && result.data) {
        return { data: result.data, status: "ok", attempts: attempt, failure: null };
      }
      failure = result.error ? "query_error" : "missing_row";
    } catch (error) {
      if (outerSignal.aborted) throw outerSignal.reason;
      failure = error instanceof DOMException && error.name === "TimeoutError"
        ? "timeout"
        : "query_error";
    }
  }
  return {
    data: null,
    status: "unavailable",
    attempts: boundedAttempts,
    failure,
  };
}

import {
  type UpstreamFailureDiagnostics,
  UpstreamHttpError,
} from "./public-failure.ts";

/** A rollout switch, not an authentication or spending limit. The caller must
 * pass the incoming session ID before a new-topic boundary rotates it. */
export function geminiMeasurementCorrectionInCohort(
  originalSessionId: string,
  bucketsPerTenThousand: number,
): boolean {
  const buckets = Number.isFinite(bucketsPerTenThousand)
    ? Math.max(0, Math.min(10_000, Math.floor(bucketsPerTenThousand)))
    : 0;
  if (!originalSessionId || buckets === 0) return false;
  let hash = 0x811c9dc5;
  for (let index = 0; index < originalSessionId.length; index++) {
    hash ^= originalSessionId.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0) % 10_000 < buckets;
}

export type ForcedToolEnvelopeStatus =
  | "usable"
  | "missing_choice"
  | "missing_message"
  | "provider_error"
  | "truncated"
  | "wrong_tool_count"
  | "wrong_tool_name"
  | "invalid_json"
  | "invalid_arguments";

export interface SafeForcedToolShape {
  status: ForcedToolEnvelopeStatus;
  finish: "tool_calls" | "stop" | "length" | "error" | "missing" | "other";
  toolCallCount: number;
  contentPresent: boolean;
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

/** The diagnostics contain only bounded shape information. Never retain a
 * provider's text, arguments, arbitrary tool names, or upstream error body. */
export function inspectForcedToolEnvelope(
  payload: unknown,
  expectedToolName: string,
): SafeForcedToolShape {
  const root = record(payload);
  const choices = Array.isArray(root?.choices) ? root.choices : [];
  const choice = record(choices[0]);
  const rawFinish = choice?.finish_reason;
  const finish: SafeForcedToolShape["finish"] =
    rawFinish === "tool_calls" || rawFinish === "stop" ||
      rawFinish === "length" || rawFinish === "error"
      ? rawFinish
      : rawFinish === null || rawFinish === undefined
      ? "missing"
      : "other";
  const message = record(choice?.message);
  const calls = Array.isArray(message?.tool_calls) ? message.tool_calls : [];
  const shape: SafeForcedToolShape = {
    status: "usable",
    finish,
    toolCallCount: Math.min(calls.length, 20),
    contentPresent: typeof message?.content === "string" &&
      message.content.length > 0,
  };
  if (!choice) shape.status = "missing_choice";
  else if (!message) shape.status = "missing_message";
  else if (finish === "error" || rawFinish === "content_filter") {
    shape.status = "provider_error";
  } else if (finish === "length") shape.status = "truncated";
  else if (calls.length !== 1) shape.status = "wrong_tool_count";
  else {
    const call = record(calls[0]);
    const fn = record(call?.function);
    if (call?.type !== undefined && call.type !== "function") {
      shape.status = "wrong_tool_name";
    } else if (fn?.name !== expectedToolName) {
      shape.status = "wrong_tool_name";
    } else if (typeof fn.arguments !== "string") {
      shape.status = "invalid_arguments";
    } else {
      try {
        const args = record(JSON.parse(fn.arguments));
        if (
          !args || typeof args.reasoning !== "string" ||
          args.reasoning.trim().length < 20 ||
          !["per_product", "system_total", "not_applicable"].includes(
            String(args.measurement_scope),
          ) ||
          !Array.isArray(args.compatible_classifications) ||
          !Array.isArray(args.excluded_classifications) ||
          !Array.isArray(args.required_facet_values) ||
          !Array.isArray(args.explicit_customer_classifications)
        ) {
          shape.status = "invalid_arguments";
        }
      } catch {
        shape.status = "invalid_arguments";
      }
    }
  }
  return shape;
}

/** The second request is permitted only after an unusable HTTP 200 completion,
 * never after a transport timeout, quota/auth/rate limit, or an actual 5xx.
 * The caller recomputes the remaining turn deadline before retrying. */
export async function retryUnusableGeminiEnvelopeOnce<T>(input: {
  attempt: (timeoutMs: number) => Promise<T>;
  initialTimeoutMs: number;
  retryTimeoutMs: () => number | null;
  signal: AbortSignal;
  onRetry?: (shape: ForcedToolEnvelopeStatus, timeoutMs: number) => void;
}): Promise<T> {
  try {
    return await input.attempt(input.initialTimeoutMs);
  } catch (error) {
    if (
      !(error instanceof UnusableForcedToolEnvelopeError) ||
      input.signal.aborted
    ) throw error;
    const retryTimeoutMs = input.retryTimeoutMs();
    if (
      retryTimeoutMs === null || !Number.isFinite(retryTimeoutMs) ||
      retryTimeoutMs < 2_500 || input.signal.aborted
    ) throw error;
    input.onRetry?.(error.shape, retryTimeoutMs);
    if (input.signal.aborted) throw error;
    return input.attempt(retryTimeoutMs);
  }
}

/** Safe marker for a strict forced-tool HTTP 200. No provider body is kept. */
export class UnusableForcedToolEnvelopeError extends UpstreamHttpError {
  readonly shape: ForcedToolEnvelopeStatus;

  constructor(
    shape: ForcedToolEnvelopeStatus,
    diagnostics: UpstreamFailureDiagnostics = {},
  ) {
    super(502, `unusable_forced_tool_envelope:${shape}`, {
      ...diagnostics,
      origin: "completion_envelope",
      observedHttpStatus: 200,
    });
    this.name = "UnusableForcedToolEnvelopeError";
    this.shape = shape;
  }
}

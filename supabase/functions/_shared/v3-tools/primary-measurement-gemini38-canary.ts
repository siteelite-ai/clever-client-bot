/** This rollout changes only the FIRST forced selection declaration for a
 * product measurement that cannot be projected from the live facet schema. */
export const PRIMARY_MEASUREMENT_GEMINI38_MODEL = "google/gemini-3.8-flash";
export const PRIMARY_MEASUREMENT_GEMINI38_BUCKETS_PER_10K = 1;

export function primaryMeasurementGemini38Cohort(
  originalSessionId: string,
  bucketsPerTenThousand = PRIMARY_MEASUREMENT_GEMINI38_BUCKETS_PER_10K,
): boolean {
  const buckets = Number.isFinite(bucketsPerTenThousand)
    ? Math.max(0, Math.min(10_000, Math.floor(bucketsPerTenThousand)))
    : 0;
  if (!originalSessionId || buckets === 0) return false;
  let hash = 0x811c9dc5;
  for (let i = 0; i < originalSessionId.length; i++) {
    hash ^= originalSessionId.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0) % 10_000 < buckets;
}

export const PRIMARY_MEASUREMENT_GEMINI38_PROVIDER = {
  require_parameters: true,
  order: ["google-ai-studio", "google-vertex/global"],
  only: ["google-ai-studio", "google-vertex/global"],
} as const;

type JsonObject = Record<string, unknown>;
function object(value: unknown): JsonObject | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as JsonObject
    : null;
}

export type PrimaryMeasurementEnvelopeStatus =
  | "usable"
  | "http_error"
  | "invalid_json"
  | "missing_choice"
  | "provider_error"
  | "truncated"
  | "missing_message"
  | "wrong_tool_count"
  | "wrong_tool_name"
  | "invalid_arguments";

/** Shape only: the existing semantic declaration and catalog proof guards
 * decide whether a product may be shown. */
export function primaryMeasurementForcedToolStatus(
  payload: unknown,
  expectedTool: string,
): PrimaryMeasurementEnvelopeStatus {
  const root = object(payload);
  const choice = Array.isArray(root?.choices) ? object(root.choices[0]) : null;
  if (!choice) return "missing_choice";
  if (choice.error !== undefined && choice.error !== null) {
    return "provider_error";
  }
  if (choice.finish_reason === "error" ||
    choice.finish_reason === "content_filter") return "provider_error";
  if (choice.finish_reason === "length") return "truncated";
  const message = object(choice.message);
  if (!message) return "missing_message";
  const calls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
  if (calls.length !== 1) return "wrong_tool_count";
  const call = object(calls[0]);
  const fn = object(call?.function);
  if (
    (call?.type !== undefined && call.type !== "function") ||
    fn?.name !== expectedTool
  ) return "wrong_tool_name";
  if (typeof fn.arguments !== "string") return "invalid_arguments";
  try {
    if (!object(JSON.parse(fn.arguments))) return "invalid_arguments";
  } catch {
    return "invalid_arguments";
  }
  return "usable";
}

function boundedInteger(value: unknown, max: number): number | null {
  return typeof value === "number" && Number.isInteger(value) &&
      value >= 0 && value <= max ? value : null;
}

function safeErrorType(value: unknown): string | null {
  if (typeof value !== "string") return null;
  switch (value.toLowerCase()) {
    case "provider_error":
    case "provider_unavailable":
    case "provider_overloaded":
    case "rate_limit_exceeded":
    case "model_unavailable":
    case "context_length_exceeded":
    case "max_tokens_exceeded":
    case "timeout":
      return value.toLowerCase();
    default:
      return "other";
  }
}

function safeProvider(value: unknown): string | null {
  if (value === "Google AI Studio" || value === "google-ai-studio") {
    return "google_ai_studio";
  }
  if (value === "Google" || value === "google-vertex/global") {
    return "google_vertex";
  }
  return value == null ? null : "other";
}

/** Explicit allowlist. Never log prompts, completion text, tool arguments,
 * arbitrary router metadata, provider error messages or headers. */
export function safePrimaryMeasurementTelemetry(input: {
  payload: unknown;
  httpStatus: number;
  elapsedMs: number;
  envelopeStatus: PrimaryMeasurementEnvelopeStatus;
}): JsonObject {
  const root = object(input.payload);
  const choice = Array.isArray(root?.choices) ? object(root.choices[0]) : null;
  const error = object(choice?.error) ?? object(root?.error);
  const errorMetadata = object(error?.metadata);
  const router = object(root?.openrouter_metadata);
  const attempts = Array.isArray(router?.attempts) ? router.attempts : [];
  const lastAttempt = attempts.length > 0 ? object(attempts.at(-1)) : null;
  const usage = object(root?.usage);
  const rawId = root?.id;
  const generationId = typeof rawId === "string" &&
      /^gen-[A-Za-z0-9_-]{8,80}$/.test(rawId) ? rawId : null;
  const finish = choice?.finish_reason;
  return {
    generation_id: generationId,
    http_status: boundedInteger(input.httpStatus, 599),
    envelope_status: input.envelopeStatus,
    finish_reason: finish === "tool_calls" || finish === "stop" ||
        finish === "length" || finish === "error" ? finish :
      finish == null ? "missing" : "other",
    choice_error_type: safeErrorType(errorMetadata?.error_type),
    choice_error_code: boundedInteger(error?.code, 599) ??
      boundedInteger(errorMetadata?.code, 599),
    provider: safeProvider(lastAttempt?.provider),
    router_attempt_count: Math.min(attempts.length, 20),
    latency_ms: boundedInteger(input.elapsedMs, 120_000),
    prompt_tokens: boundedInteger(usage?.prompt_tokens, 2_000_000),
    completion_tokens: boundedInteger(usage?.completion_tokens, 2_000_000),
  };
}

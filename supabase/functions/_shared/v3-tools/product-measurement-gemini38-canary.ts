/** Rollout control only. Always hash the incoming ID before new-topic rotation. */
export function gemini38MeasurementCohort(
  originalSessionId: string,
  bucketsPerTenThousand: number,
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

type RecordValue = Record<string, unknown>;
function record(value: unknown): RecordValue | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as RecordValue
    : null;
}

export type Gemini38EnvelopeStatus =
  | "usable"
  | "invalid_json"
  | "missing_choice"
  | "provider_error"
  | "truncated"
  | "missing_message"
  | "wrong_tool_count"
  | "wrong_tool_name"
  | "invalid_arguments";

/** Only shape is inspected here; the existing declaration/authority guards
 * still decide whether any product is actually safe to show. */
export function gemini38ForcedToolStatus(
  payload: unknown,
  expectedTool: string,
): Gemini38EnvelopeStatus {
  const root = record(payload);
  const choice = Array.isArray(root?.choices) ? record(root.choices[0]) : null;
  if (!choice) return "missing_choice";
  if (choice.error !== undefined && choice.error !== null) {
    return "provider_error";
  }
  if (
    choice.finish_reason === "error" ||
    choice.finish_reason === "content_filter"
  ) return "provider_error";
  if (choice.finish_reason === "length") return "truncated";
  const message = record(choice.message);
  if (!message) return "missing_message";
  const calls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
  if (calls.length !== 1) return "wrong_tool_count";
  const call = record(calls[0]);
  const fn = record(call?.function);
  if (
    (call?.type !== undefined && call.type !== "function") ||
    fn?.name !== expectedTool
  ) return "wrong_tool_name";
  if (typeof fn.arguments !== "string") return "invalid_arguments";
  try {
    if (!record(JSON.parse(fn.arguments))) return "invalid_arguments";
  } catch {
    return "invalid_arguments";
  }
  return "usable";
}

function boundedInt(value: unknown, max: number): number | null {
  return typeof value === "number" && Number.isInteger(value) &&
      value >= 0 && value <= max
    ? value
    : null;
}

function httpCode(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) &&
      value >= 100 && value <= 599
    ? value
    : null;
}

function safeErrorType(value: unknown): string | null {
  if (typeof value !== "string") return null;
  switch (value.toLowerCase()) {
    case "provider_error":
    case "provider_unavailable":
    case "provider_overloaded":
    case "rate_limit":
    case "rate_limit_exceeded":
    case "invalid_request":
    case "model_unavailable":
    case "content_filter":
    case "context_length_exceeded":
    case "max_tokens_exceeded":
    case "upstream_error":
    case "timeout":
      return value.toLowerCase();
    default:
      return "other";
  }
}

function safeProviderCode(value: unknown): string | number | null {
  const numeric = boundedInt(value, 9999);
  if (numeric !== null) return numeric;
  if (typeof value !== "string") return null;
  switch (value) {
    case "RESOURCE_EXHAUSTED":
    case "UNAVAILABLE":
    case "INTERNAL":
    case "INVALID_ARGUMENT":
    case "DEADLINE_EXCEEDED":
      return value;
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
  return value === undefined || value === null ? null : "other";
}

function routedProvider(root: RecordValue | null): string | null {
  const routing = record(root?.openrouter_metadata);
  const attempts = Array.isArray(routing?.attempts) ? routing.attempts : [];
  const last = attempts.length > 0 ? record(attempts.at(-1)) : null;
  if (last?.provider !== undefined) return safeProvider(last.provider);
  const endpoints = record(routing?.endpoints);
  const available = Array.isArray(endpoints?.available)
    ? endpoints.available
    : [];
  const selected = available.map(record).find((endpoint) =>
    endpoint?.selected === true
  );
  return safeProvider(selected?.provider);
}

/** Explicit allowlist: never return provider prose, model text, arguments,
 * error messages, router summary, credentials, or arbitrary metadata. */
export function safeGemini38CorrectionTelemetry(input: {
  payload: unknown;
  generationId: string | null;
  httpStatus: number;
  elapsedMs: number;
  envelopeStatus: Gemini38EnvelopeStatus | null;
}): RecordValue {
  const root = record(input.payload);
  const choice = Array.isArray(root?.choices) ? record(root.choices[0]) : null;
  const error = record(choice?.error) ?? record(root?.error);
  const errorMetadata = record(error?.metadata);
  const usage = record(root?.usage);
  const routing = record(root?.openrouter_metadata);
  const calls = record(choice?.message)?.tool_calls;
  const finish = choice?.finish_reason;
  const safeFinish = finish === "tool_calls" || finish === "stop" ||
      finish === "length" || finish === "error"
    ? finish
    : finish == null
    ? "missing"
    : "other";
  const candidateGenerationId = input.generationId ?? root?.id;
  const generationId = typeof candidateGenerationId === "string" &&
      /^gen-[A-Za-z0-9_-]{8,80}$/.test(candidateGenerationId)
    ? candidateGenerationId
    : null;
  return {
    generation_id: generationId,
    http_status: httpCode(input.httpStatus),
    envelope_status: input.envelopeStatus,
    choice_error_type: safeErrorType(errorMetadata?.error_type),
    choice_error_code: httpCode(error?.code) ?? httpCode(errorMetadata?.code),
    choice_provider_code: safeProviderCode(errorMetadata?.provider_code),
    finish_reason: safeFinish,
    tool_call_count: Array.isArray(calls) ? Math.min(calls.length, 20) : 0,
    provider: routedProvider(root),
    router_attempt_count: Array.isArray(routing?.attempts)
      ? Math.min(routing.attempts.length, 20)
      : 0,
    latency_ms: boundedInt(input.elapsedMs, 120_000),
    prompt_tokens: boundedInt(usage?.prompt_tokens, 2_000_000),
    completion_tokens: boundedInt(usage?.completion_tokens, 2_000_000),
    total_tokens: boundedInt(usage?.total_tokens, 4_000_000),
  };
}

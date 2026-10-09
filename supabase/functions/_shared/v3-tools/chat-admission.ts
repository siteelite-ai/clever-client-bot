/**
 * Optional global cost guard for a newly-created v3 chat log claim.
 *
 * Call only after the unique message-id log insert reports `created`, and
 * before settings, catalog, or model work. A replay/existing claim must never
 * call this helper. Configuration comes only from server-side Edge env vars;
 * no browser field is accepted as a mode, threshold, or limiter identity.
 */

export type ChatV3AdmissionMode = "off" | "observe" | "enforce";
export type ChatV3AdmissionFailure =
  | "invalid_mode"
  | "invalid_limit_per_minute"
  | "invalid_limit_in_flight"
  | "missing_enforcement_limit"
  | "invalid_log_id"
  | "rpc_error"
  | "invalid_rpc_response"
  | null;

export type ChatV3AdmissionRpc = (
  name: "check_chat_v3_admission" | "release_chat_v3_admission",
  args: Record<string, string | number | null>,
) => PromiseLike<{ data: unknown; error?: unknown }>;

export interface ChatV3AdmissionResult {
  allowed: boolean;
  /** The committed decision's mode, or the configured mode if no decision exists. */
  mode: ChatV3AdmissionMode | "invalid";
  /** Safe, bounded operational reason; never a raw database error. */
  reason: string;
  replayed: boolean;
  wouldReject: boolean;
  limitReason: string | null;
  retryAfterSeconds: number | null;
  windowCountBefore: number | null;
  inFlightBefore: number | null;
  rpcCalled: boolean;
  /** Await release before SSE close, even if an RPC response was ambiguous. */
  releaseRequired: boolean;
  failure: ChatV3AdmissionFailure;
}

export interface ChatV3AdmissionReleaseResult {
  attempted: boolean;
  released: boolean;
  failure: "rpc_error" | "invalid_rpc_response" | null;
}

type EnvReader = (name: string) => string | undefined;
type Limit = { value: number | null; invalid: boolean };

const MAX_POSTGRES_INTEGER = 2_147_483_647;
const RPC_REASONS = new Set([
  "invalid_claim",
  "claim_not_in_progress",
  "configuration_missing",
  "limit_exceeded",
  "observe_unconfigured",
  "observed_limit",
  "admitted",
]);
const LIMIT_REASONS = new Set([
  "minute_limit",
  "in_flight_limit",
  "minute_and_in_flight_limit",
]);

function parseLimit(raw: string | undefined): Limit {
  if (raw === undefined) return { value: null, invalid: false };
  const value = raw.trim();
  if (!/^\d+$/u.test(value)) return { value: null, invalid: true };
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 1 &&
      parsed <= MAX_POSTGRES_INTEGER
    ? { value: parsed, invalid: false }
    : { value: null, invalid: true };
}

function noDecision(
  allowed: boolean,
  mode: ChatV3AdmissionResult["mode"],
  reason: string,
  failure: ChatV3AdmissionFailure = null,
  rpcCalled = false,
): ChatV3AdmissionResult {
  return {
    allowed,
    mode,
    reason,
    replayed: false,
    wouldReject: false,
    limitReason: null,
    retryAfterSeconds: null,
    windowCountBefore: null,
    inFlightBefore: null,
    rpcCalled,
    releaseRequired: rpcCalled,
    failure,
  };
}

function parseNonNegativeCount(raw: unknown): number | null | undefined {
  if (raw === undefined || raw === null) return null;
  return Number.isSafeInteger(raw) && (raw as number) >= 0
    ? raw as number
    : undefined;
}

function parseDecision(raw: unknown): ChatV3AdmissionResult | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const data = raw as Record<string, unknown>;
  if (
    typeof data.allowed !== "boolean" ||
    typeof data.reason !== "string" || !RPC_REASONS.has(data.reason) ||
    (data.mode !== "observe" && data.mode !== "enforce") ||
    typeof data.replayed !== "boolean" ||
    typeof data.would_reject !== "boolean"
  ) return null;
  // Guard against a malformed response claiming an admission for a denial
  // reason. The database contract never allows these combinations.
  const validOutcome = data.allowed
    ? data.reason === "admitted" ||
      (data.mode === "observe" &&
        (data.reason === "observed_limit" ||
          data.reason === "observe_unconfigured"))
    : data.reason === "invalid_claim" ||
      data.reason === "claim_not_in_progress" ||
      (data.mode === "enforce" &&
        (data.reason === "configuration_missing" ||
          data.reason === "limit_exceeded"));
  if (!validOutcome) return null;

  const limitReason = data.limit_reason ?? null;
  const retryAfterSeconds = data.retry_after_seconds ?? null;
  const windowCountBefore = parseNonNegativeCount(data.window_count_before);
  const inFlightBefore = parseNonNegativeCount(data.in_flight_before);
  if (
    (limitReason !== null &&
      (typeof limitReason !== "string" || !LIMIT_REASONS.has(limitReason))) ||
    (retryAfterSeconds !== null &&
      (!Number.isSafeInteger(retryAfterSeconds) ||
        (retryAfterSeconds as number) < 1)) ||
    windowCountBefore === undefined || inFlightBefore === undefined
  ) return null;

  // The RPC can return a prior decision for this log after an ambiguous first
  // response. Preserve that committed decision (including its original mode).
  return {
    allowed: data.allowed,
    mode: data.mode,
    reason: data.reason,
    replayed: data.replayed,
    wouldReject: data.would_reject,
    limitReason: limitReason as string | null,
    retryAfterSeconds: retryAfterSeconds as number | null,
    windowCountBefore,
    inFlightBefore,
    rpcCalled: true,
    // A committed denial has no in-flight reservation. Ambiguous RPC errors
    // still require a release attempt because admission may have committed.
    releaseRequired: data.allowed,
    failure: null,
  };
}

function rpcFailure(
  mode: "observe" | "enforce",
  failure: "rpc_error" | "invalid_rpc_response",
): ChatV3AdmissionResult {
  // This is deliberately secret-free and independently visible in Edge logs.
  // The same failure code is returned for the caller's structured turn steps.
  console.error("[v3] admission check failed", { mode, failure });
  return noDecision(
    mode === "observe",
    mode,
    mode === "observe" ? "rpc_error_open" : "rpc_error_closed",
    failure,
    true,
  );
}

/**
 * Make one idempotent check RPC for a newly claimed log. Off mode makes zero
 * RPC calls. Observe is fail-open only for transport/malformed-response errors;
 * explicit RPC denials such as `claim_not_in_progress` remain denials.
 */
export async function checkChatV3Admission(
  logId: string,
  rpc: ChatV3AdmissionRpc,
  readEnv: EnvReader = (name) => Deno.env.get(name),
): Promise<ChatV3AdmissionResult> {
  const configuredMode = readEnv("CHAT_V3_ADMISSION_MODE");
  if (configuredMode === undefined || configuredMode === "off") {
    return noDecision(true, "off", "off");
  }
  if (configuredMode !== "observe" && configuredMode !== "enforce") {
    return noDecision(
      false,
      "invalid",
      "invalid_configuration",
      "invalid_mode",
    );
  }

  const perMinute = parseLimit(readEnv("CHAT_V3_ADMISSION_LIMIT_PER_MINUTE"));
  const inFlight = parseLimit(readEnv("CHAT_V3_ADMISSION_LIMIT_IN_FLIGHT"));
  if (perMinute.invalid) {
    return noDecision(
      false,
      configuredMode,
      "invalid_configuration",
      "invalid_limit_per_minute",
    );
  }
  if (inFlight.invalid) {
    return noDecision(
      false,
      configuredMode,
      "invalid_configuration",
      "invalid_limit_in_flight",
    );
  }
  if (
    configuredMode === "enforce" &&
    (perMinute.value === null || inFlight.value === null)
  ) {
    return noDecision(
      false,
      configuredMode,
      "invalid_configuration",
      "missing_enforcement_limit",
    );
  }
  if (typeof logId !== "string" || logId.length === 0) {
    return noDecision(false, configuredMode, "invalid_claim", "invalid_log_id");
  }

  try {
    const { data, error } = await rpc("check_chat_v3_admission", {
      p_log_id: logId,
      p_mode: configuredMode,
      p_limit_per_minute: perMinute.value,
      p_limit_in_flight: inFlight.value,
    });
    if (error) return rpcFailure(configuredMode, "rpc_error");
    return parseDecision(data) ??
      rpcFailure(configuredMode, "invalid_rpc_response");
  } catch {
    return rpcFailure(configuredMode, "rpc_error");
  }
}

/**
 * Await this on every terminal path after an attempted check, before closing
 * SSE. The database release is idempotent: later calls safely return false.
 */
export async function releaseChatV3Admission(
  logId: string,
  admission: ChatV3AdmissionResult,
  rpc: ChatV3AdmissionRpc,
): Promise<ChatV3AdmissionReleaseResult> {
  if (!admission.releaseRequired) {
    return { attempted: false, released: false, failure: null };
  }
  try {
    const { data, error } = await rpc("release_chat_v3_admission", {
      p_log_id: logId,
    });
    if (error) {
      console.error("[v3] admission release failed", { failure: "rpc_error" });
      return { attempted: true, released: false, failure: "rpc_error" };
    }
    if (typeof data !== "boolean") {
      console.error("[v3] admission release failed", {
        failure: "invalid_rpc_response",
      });
      return {
        attempted: true,
        released: false,
        failure: "invalid_rpc_response",
      };
    }
    return { attempted: true, released: data, failure: null };
  } catch {
    console.error("[v3] admission release failed", { failure: "rpc_error" });
    return { attempted: true, released: false, failure: "rpc_error" };
  }
}

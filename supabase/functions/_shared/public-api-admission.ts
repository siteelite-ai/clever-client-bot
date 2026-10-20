/**
 * Cross-route, server-owned reservation for the public model/catalog budget.
 * This is deliberately separate from v3's existing claimed-turn guard. All
 * four public routes must use the same database RPC and server-side settings.
 * Never derive the reservation ID, mode, limits, or lanes from request JSON.
 */
import { runWithDeadline } from "./v3-tools/turn-deadline.ts";

export type PublicApiAdmissionMode = "off" | "observe" | "enforce";
export type PublicApiAdmissionRoute =
  | "chat-consultant"
  | "chat-consultant-v2"
  | "chat-consultant-v3"
  | "search-products";
export type PublicApiAdmissionLane = "catalog" | "model";
export type PublicApiAdmissionRpc = (
  name: "reserve_public_api_admission" | "release_public_api_admission",
  args: Record<string, string | number | null | string[]>,
) => PromiseLike<{ data: unknown; error?: unknown }>;

type EnvReader = (name: string) => string | undefined;

export interface PublicApiAdmissionResult {
  allowed: boolean;
  mode: PublicApiAdmissionMode | "invalid";
  reason: string;
  wouldReject: boolean;
  replayed: boolean;
  retryAfterSeconds: number | null;
  reservationId: string | null;
  /** True on admission or any ambiguous check result; release is idempotent. */
  releaseRequired: boolean;
  rpcCalled: boolean;
  failure:
    | "invalid_route_or_lanes"
    | "invalid_mode"
    | "invalid_limit"
    | "missing_enforcement_limit"
    | "rpc_error"
    | "rpc_timeout"
    | "invalid_rpc_response"
    | null;
}

export interface PublicApiAdmissionReleaseResult {
  attempted: boolean;
  released: boolean;
  failure: "rpc_error" | "rpc_timeout" | "invalid_rpc_response" | null;
}

export interface PublicApiAdmissionOptions {
  route: PublicApiAdmissionRoute;
  lanes: readonly PublicApiAdmissionLane[];
  rpc: PublicApiAdmissionRpc;
  timeoutMs?: number;
  readEnv?: EnvReader;
}

const MAX_POSTGRES_INTEGER = 2_147_483_647;
const DEFAULT_CHECK_RPC_TIMEOUT_MS = 6_000;
const DEFAULT_RELEASE_RPC_TIMEOUT_MS = 1_500;
const VALID_REASONS = new Set([
  "admitted", "observed_limit", "observe_unconfigured",
  "limit_exceeded", "configuration_missing", "reservation_conflict",
  "cancelled",
]);

function parsePositiveLimit(raw: string | undefined): {
  value: number | null;
  invalid: boolean;
} {
  if (raw === undefined) return { value: null, invalid: false };
  const value = raw.trim();
  if (!/^\d+$/u.test(value)) return { value: null, invalid: true };
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 ||
      parsed > MAX_POSTGRES_INTEGER) {
    return { value: null, invalid: true };
  }
  return { value: parsed, invalid: false };
}

function result(
  allowed: boolean,
  mode: PublicApiAdmissionResult["mode"],
  reason: string,
  failure: PublicApiAdmissionResult["failure"] = null,
  reservationId: string | null = null,
  rpcCalled = false,
  releaseRequired = false,
): PublicApiAdmissionResult {
  return {
    allowed,
    mode,
    reason,
    wouldReject: false,
    replayed: false,
    retryAfterSeconds: null,
    reservationId,
    releaseRequired,
    rpcCalled,
    failure,
  };
}

function parseDecision(
  data: unknown,
  mode: "observe" | "enforce",
  reservationId: string,
): PublicApiAdmissionResult | null {
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  const value = data as Record<string, unknown>;
  if (typeof value.allowed !== "boolean" ||
      typeof value.reason !== "string" ||
      !VALID_REASONS.has(value.reason) ||
      value.mode !== mode ||
      typeof value.replayed !== "boolean" ||
      typeof value.would_reject !== "boolean") return null;
  const validOutcome = value.allowed
    ? value.reason === "admitted" ||
      (mode === "observe" && (
        value.reason === "observed_limit" ||
        value.reason === "observe_unconfigured"
      ))
    : mode === "enforce" && (
      value.reason === "limit_exceeded" ||
      value.reason === "configuration_missing"
    ) || value.reason === "reservation_conflict" ||
      value.reason === "cancelled";
  if (!validOutcome) return null;
  const retry = value.retry_after_seconds ?? null;
  if (retry !== null &&
      (!Number.isSafeInteger(retry) || (retry as number) < 1)) return null;
  return {
    allowed: value.allowed,
    mode,
    reason: value.reason,
    wouldReject: value.would_reject,
    replayed: value.replayed,
    retryAfterSeconds: retry as number | null,
    reservationId,
    releaseRequired: value.allowed,
    rpcCalled: true,
    failure: null,
  };
}

function rpcFailure(
  mode: "observe" | "enforce",
  failure: "rpc_error" | "rpc_timeout" | "invalid_rpc_response",
  reservationId: string,
): PublicApiAdmissionResult {
  // A timeout may have committed. Release even when the check result is lost;
  // the database also expires any still-live reservation after 450 seconds,
  // beyond the hosted Edge worker's 400-second maximum lifetime.
  console.error("[public-api-admission] check failed", { mode, failure });
  return result(
    mode === "observe", mode,
    `${failure}_${mode === "observe" ? "open" : "closed"}`,
    failure, reservationId, true, true,
  );
}

/** Off mode makes no RPC call. Enforce fails closed on missing/invalid limits
 * or database uncertainty; observe records limits but fails open on transport
 * problems only. The limits are process configuration, not browser inputs. */
export async function reservePublicApiAdmission({
  route,
  lanes,
  rpc,
  timeoutMs = DEFAULT_CHECK_RPC_TIMEOUT_MS,
  readEnv = (name) => Deno.env.get(name),
}: PublicApiAdmissionOptions): Promise<PublicApiAdmissionResult> {
  const mode = readEnv("PUBLIC_API_ADMISSION_MODE");
  if (mode === undefined || mode === "off") {
    return result(true, "off", "off");
  }
  if (mode !== "observe" && mode !== "enforce") {
    return result(false, "invalid", "invalid_configuration", "invalid_mode");
  }
  const expectedLanes = route === "search-products"
    ? "catalog"
    : ["chat-consultant", "chat-consultant-v2", "chat-consultant-v3"]
        .includes(route)
    ? "catalog,model"
    : null;
  if (!expectedLanes || [...new Set(lanes)].sort().join(",") !==
      expectedLanes) {
    return result(false, mode, "invalid_configuration", "invalid_route_or_lanes");
  }
  const modelPerMinute = parsePositiveLimit(
    readEnv("PUBLIC_API_MODEL_LIMIT_PER_MINUTE"),
  );
  const modelInFlight = parsePositiveLimit(
    readEnv("PUBLIC_API_MODEL_LIMIT_IN_FLIGHT"),
  );
  const catalogPerMinute = parsePositiveLimit(
    readEnv("PUBLIC_API_CATALOG_LIMIT_PER_MINUTE"),
  );
  const catalogInFlight = parsePositiveLimit(
    readEnv("PUBLIC_API_CATALOG_LIMIT_IN_FLIGHT"),
  );
  const relevant = route === "search-products"
    ? [catalogPerMinute, catalogInFlight]
    : [modelPerMinute, modelInFlight, catalogPerMinute, catalogInFlight];
  if (relevant.some((limit) => limit.invalid)) {
    return result(false, mode, "invalid_configuration", "invalid_limit");
  }
  if (mode === "enforce" && relevant.some((limit) => limit.value === null)) {
    return result(false, mode, "invalid_configuration", "missing_enforcement_limit");
  }

  const reservationId = crypto.randomUUID();
  const args = {
    p_reservation_id: reservationId,
    p_route: route,
    p_mode: mode,
    p_lanes: [...new Set(lanes)].sort(),
    p_model_limit_per_minute: modelPerMinute.value,
    p_model_limit_in_flight: modelInFlight.value,
    p_catalog_limit_per_minute: catalogPerMinute.value,
    p_catalog_limit_in_flight: catalogInFlight.value,
  };
  let expired = false;
  try {
    const response = await runWithDeadline(
      () => rpc("reserve_public_api_admission", args),
      timeoutMs,
      () => { expired = true; },
    );
    if (response.error) return rpcFailure(mode, "rpc_error", reservationId);
    return parseDecision(response.data, mode, reservationId) ??
      rpcFailure(mode, "invalid_rpc_response", reservationId);
  } catch {
    return rpcFailure(
      mode, expired ? "rpc_timeout" : "rpc_error", reservationId,
    );
  }
}

/** This remains safe after a lost reserve response, multiple terminal paths,
 * and duplicate release calls. A release arriving before a slow reserve
 * leaves a bounded cancellation tombstone; one arriving after it closes the
 * reservation. Both RPCs use the same database advisory lock. */
export async function releasePublicApiAdmission({
  reservation,
  rpc,
  timeoutMs = DEFAULT_RELEASE_RPC_TIMEOUT_MS,
}: {
  reservation: PublicApiAdmissionResult;
  rpc: PublicApiAdmissionRpc;
  timeoutMs?: number;
}): Promise<PublicApiAdmissionReleaseResult> {
  if (!reservation.releaseRequired || !reservation.reservationId) {
    return { attempted: false, released: false, failure: null };
  }
  let lastFailure: PublicApiAdmissionReleaseResult["failure"] = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    let expired = false;
    try {
      const response = await runWithDeadline(
        () => rpc("release_public_api_admission", {
          p_reservation_id: reservation.reservationId,
        }),
        timeoutMs,
        () => { expired = true; },
      );
      if (response.error) {
        lastFailure = "rpc_error";
      } else if (typeof response.data === "boolean") {
        return { attempted: true, released: response.data, failure: null };
      } else {
        lastFailure = "invalid_rpc_response";
      }
    } catch {
      lastFailure = expired ? "rpc_timeout" : "rpc_error";
    }
  }
  console.error("[public-api-admission] release failed", {
    failure: lastFailure,
  });
  return { attempted: true, released: false, failure: lastFailure };
}

/** Preserve status and headers while tying a streamed response's reservation
 * lifetime to body completion or cancellation, not handler return. The
 * database TTL is the safety net if a browser vanishes without cancellation. */
export function wrapResponseForAdmissionRelease(
  response: Response,
  release: () => PromiseLike<unknown> | void,
): Response {
  let finished = false;
  const finish = async () => {
    if (finished) return;
    finished = true;
    try {
      await release();
    } catch {
      console.error("[public-api-admission] terminal release failed");
    }
  };
  if (!response.body) {
    void finish();
    return response;
  }
  const reader = response.body.getReader();
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await reader.read();
        if (next.done) {
          await finish();
          controller.close();
        } else {
          controller.enqueue(next.value);
        }
      } catch (error) {
        await finish();
        controller.error(error);
      }
    },
    async cancel(reason) {
      try {
        await reader.cancel(reason);
      } finally {
        await finish();
      }
    },
  });
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

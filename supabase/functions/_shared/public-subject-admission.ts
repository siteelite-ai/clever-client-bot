/**
 * A second, subject-scoped public API gate. It complements (never replaces)
 * the global model/catalog gate. The issuer must be a trusted server ingress;
 * a browser must never receive the signing key or choose the subject hash.
 *
 * Default OFF: only the mode is read, with no proof parsing or database call.
 * Observe never blocks a request for a missing/invalid proof, an exceeded
 * limit, or an uncertain database result. Enforce fails closed on all three.
 *
 * Proof protocol: v1.<base64url(JSON)>.<base64url(HMAC-SHA256 of the first
 * two segments)>. JSON has exactly v, kid, aud, sub, iat, exp, jti. `sub` is
 * an opaque 64-character lowercase HMAC hex pseudonym, not a raw IP, session
 * ID, forwarded header, or browser-supplied identity. The fixed audience is
 * shared by the four routes; SQL counts the subject across all four routes.
 */
import { runWithDeadline } from "./v3-tools/turn-deadline.ts";
import type { PublicApiAdmissionRoute } from "./public-api-admission.ts";

export type PublicSubjectAdmissionMode = "off" | "observe" | "enforce";
export type PublicSubjectAdmissionRpc = (
  name: "reserve_public_subject_admission" | "release_public_subject_admission",
  args: Record<string, string | number | null>,
) => PromiseLike<{ data: unknown; error?: unknown }>;

type EnvReader = (name: string) => string | undefined;
type Mode = PublicSubjectAdmissionMode | "invalid";
type ProofFailure =
  | "invalid_mode"
  | "missing_proof"
  | "invalid_proof"
  | "invalid_proof_config"
  | null;
type AdmissionFailure =
  | ProofFailure
  | "invalid_route"
  | "invalid_limit"
  | "missing_enforcement_limit"
  | "rpc_error"
  | "rpc_timeout"
  | "invalid_rpc_response";

export interface PublicSubjectProofResult {
  allowed: boolean;
  mode: Mode;
  reason: string;
  wouldReject: boolean;
  failure: ProofFailure;
  /** Pseudonym only. Bind v3 claimed-turn replay to this value before reuse. */
  subjectHash: string | null;
}

export interface PublicSubjectAdmissionResult {
  allowed: boolean;
  mode: Mode;
  reason: string;
  wouldReject: boolean;
  replayed: boolean;
  retryAfterSeconds: number | null;
  reservationId: string | null;
  /** A timed-out reserve may have committed; release even after ambiguity. */
  releaseRequired: boolean;
  rpcCalled: boolean;
  failure: AdmissionFailure;
}

export interface PublicSubjectAdmissionReleaseResult {
  attempted: boolean;
  released: boolean;
  failure: "rpc_error" | "rpc_timeout" | "invalid_rpc_response" | null;
}

export interface PublicSubjectProofOptions {
  req: Request;
  readEnv?: EnvReader;
  nowSeconds?: () => number;
}

export interface PublicSubjectAdmissionOptions {
  verification: PublicSubjectProofResult;
  route: PublicApiAdmissionRoute;
  rpc: PublicSubjectAdmissionRpc;
  timeoutMs?: number;
  readEnv?: EnvReader;
}

const PROOF_HEADER = "x-volt-subject-proof";
const PROOF_AUDIENCE = "volt220-public-api";
const MAX_PROOF_LENGTH = 1024;
const MAX_PROOF_AGE_SECONDS = 60;
const CLOCK_SKEW_SECONDS = 5;
const WINDOW_SECONDS = 60;
// SQL rejects limits above one million; reject them before the RPC too.
const MAX_SUBJECT_LIMIT = 1_000_000;
const DEFAULT_CHECK_RPC_TIMEOUT_MS = 6_000;
const DEFAULT_RELEASE_RPC_TIMEOUT_MS = 1_500;
const SUBJECT_HEX = /^[0-9a-f]{64}$/u;
const KID = /^[A-Za-z0-9_-]{1,32}$/u;
const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const BASE64URL = /^[A-Za-z0-9_-]+$/u;
const VALID_ROUTES = new Set<PublicApiAdmissionRoute>([
  "chat-consultant",
  "chat-consultant-v2",
  "chat-consultant-v3",
  "search-products",
]);
const VALID_REASONS = new Set([
  "admitted",
  "observed_limit",
  "observe_unconfigured",
  "limit_exceeded",
  "configuration_missing",
  "reservation_conflict",
  "cancelled",
]);

function proofResult(
  allowed: boolean,
  mode: Mode,
  reason: string,
  failure: ProofFailure = null,
  subjectHash: string | null = null,
): PublicSubjectProofResult {
  return {
    allowed,
    mode,
    reason,
    wouldReject: !allowed || (mode === "observe" && failure !== null),
    failure,
    subjectHash,
  };
}

function admissionResult(
  allowed: boolean,
  mode: Mode,
  reason: string,
  failure: AdmissionFailure = null,
  reservationId: string | null = null,
  rpcCalled = false,
  releaseRequired = false,
  wouldReject = false,
): PublicSubjectAdmissionResult {
  return {
    allowed,
    mode,
    reason,
    failure,
    reservationId,
    rpcCalled,
    releaseRequired,
    wouldReject,
    replayed: false,
    retryAfterSeconds: null,
  };
}

function decodeBase64Url(encoded: string): Uint8Array | null {
  if (!BASE64URL.test(encoded) || encoded.length > MAX_PROOF_LENGTH) {
    return null;
  }
  try {
    const standard = encoded.replace(/-/gu, "+").replace(/_/gu, "/");
    const bytes = Uint8Array.from(
      atob(standard.padEnd(
        Math.ceil(standard.length / 4) * 4,
        "=",
      )),
      (char) => char.charCodeAt(0),
    );
    // Reject noncanonical encodings rather than allowing multiple spellings.
    const canonical = btoa(String.fromCharCode(...bytes))
      .replace(/\+/gu, "-").replace(/\//gu, "_").replace(/=+$/u, "");
    return canonical === encoded ? bytes : null;
  } catch {
    return null;
  }
}

function proofKey(raw: string | undefined): Uint8Array | null {
  if (!raw || raw.length > 128) return null;
  const bytes = decodeBase64Url(raw);
  return bytes && bytes.length >= 32 && bytes.length <= 64 ? bytes : null;
}

function exactProofClaims(value: unknown): value is {
  v: 1;
  kid: string;
  aud: string;
  sub: string;
  iat: number;
  exp: number;
  jti: string;
} {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const obj = value as Record<string, unknown>;
  if (
    Object.keys(obj).sort().join(",") !==
      "aud,exp,iat,jti,kid,sub,v"
  ) return false;
  return obj.v === 1 && typeof obj.kid === "string" &&
    typeof obj.aud === "string" && typeof obj.sub === "string" &&
    Number.isSafeInteger(obj.iat) && Number.isSafeInteger(obj.exp) &&
    typeof obj.jti === "string";
}

/**
 * Verify before v3's claimed-turn replay lookup. Enforced requests with no
 * trusted identity stop before any cached reply or paid work is exposed.
 * This helper never reads Origin, X-Forwarded-For, CF-Connecting-IP, or JSON.
 */
export async function verifyPublicSubjectProof({
  req,
  readEnv = (name) => Deno.env.get(name),
  nowSeconds = () => Math.floor(Date.now() / 1000),
}: PublicSubjectProofOptions): Promise<PublicSubjectProofResult> {
  const mode = readEnv("PUBLIC_SUBJECT_ADMISSION_MODE");
  if (mode === undefined || mode === "off") {
    return proofResult(true, "off", "off");
  }
  if (mode !== "observe" && mode !== "enforce") {
    return proofResult(
      false,
      "invalid",
      "invalid_configuration",
      "invalid_mode",
    );
  }
  const onInvalid = (
    reason: "missing_proof" | "invalid_proof" | "invalid_proof_config",
  ) =>
    proofResult(
      mode === "observe",
      mode,
      reason === "invalid_proof_config" ? "invalid_configuration" : reason,
      reason,
    );
  const kid = readEnv("PUBLIC_SUBJECT_PROOF_KID");
  const keyBytes = proofKey(readEnv("PUBLIC_SUBJECT_PROOF_HMAC_KEY"));
  if (!kid || !KID.test(kid) || !keyBytes) {
    return onInvalid("invalid_proof_config");
  }
  const token = req.headers.get(PROOF_HEADER);
  if (!token) return onInvalid("missing_proof");
  if (
    token.length > MAX_PROOF_LENGTH ||
    !/^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u.test(token)
  ) {
    return onInvalid("invalid_proof");
  }
  const [, payloadSegment, signatureSegment] = token.split(".");
  const payloadBytes = decodeBase64Url(payloadSegment);
  const signatureBytes = decodeBase64Url(signatureSegment);
  if (!payloadBytes || !signatureBytes || signatureBytes.length !== 32) {
    return onInvalid("invalid_proof");
  }
  try {
    const key = await crypto.subtle.importKey(
      "raw",
      keyBytes,
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["verify"],
    );
    const verified = await crypto.subtle.verify(
      "HMAC",
      key,
      signatureBytes,
      new TextEncoder().encode(`v1.${payloadSegment}`),
    );
    if (!verified) return onInvalid("invalid_proof");
    const claims: unknown = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(payloadBytes),
    );
    if (
      !exactProofClaims(claims) ||
      claims.kid !== kid || claims.aud !== PROOF_AUDIENCE ||
      !SUBJECT_HEX.test(claims.sub) || !UUID_V4.test(claims.jti)
    ) {
      return onInvalid("invalid_proof");
    }
    const now = nowSeconds();
    if (
      !Number.isSafeInteger(now) ||
      claims.iat > now + CLOCK_SKEW_SECONDS ||
      claims.exp <= now || claims.exp <= claims.iat ||
      claims.exp - claims.iat > MAX_PROOF_AGE_SECONDS ||
      claims.exp - now > MAX_PROOF_AGE_SECONDS + CLOCK_SKEW_SECONDS
    ) {
      return onInvalid("invalid_proof");
    }
    return proofResult(true, mode, "verified", null, claims.sub);
  } catch {
    return onInvalid("invalid_proof");
  }
}

function parsePositiveLimit(raw: string | undefined): {
  value: number | null;
  invalid: boolean;
} {
  if (raw === undefined) return { value: null, invalid: false };
  const value = raw.trim();
  if (!/^\d+$/u.test(value)) return { value: null, invalid: true };
  const parsed = Number(value);
  if (
    !Number.isSafeInteger(parsed) || parsed < 1 ||
    parsed > MAX_SUBJECT_LIMIT
  ) {
    return { value: null, invalid: true };
  }
  return { value: parsed, invalid: false };
}

function parseDecision(
  data: unknown,
  mode: "observe" | "enforce",
  reservationId: string,
): PublicSubjectAdmissionResult | null {
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  const value = data as Record<string, unknown>;
  if (
    typeof value.allowed !== "boolean" ||
    typeof value.reason !== "string" || !VALID_REASONS.has(value.reason) ||
    value.mode !== mode || typeof value.replayed !== "boolean" ||
    typeof value.would_reject !== "boolean"
  ) return null;
  const validOutcome = value.allowed
    ? value.reason === "admitted" ||
      (mode === "observe" && (
        value.reason === "observed_limit" ||
        value.reason === "observe_unconfigured"
      ))
    : (mode === "enforce" && (
      value.reason === "limit_exceeded" ||
      value.reason === "configuration_missing"
    )) || value.reason === "reservation_conflict" ||
      value.reason === "cancelled";
  if (!validOutcome) return null;
  const retry = value.retry_after_seconds ?? null;
  if (
    retry !== null &&
    (!Number.isSafeInteger(retry) || (retry as number) < 1)
  ) return null;
  // Observe is telemetry, not a second access-control layer. Even an unusual
  // SQL denial (for example a cancellation tombstone) must not block a
  // request solely because this rollout is being observed.
  const admitted = mode === "observe" ? true : value.allowed;
  return {
    allowed: admitted,
    mode,
    reason: value.reason,
    wouldReject: value.would_reject || !value.allowed,
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
): PublicSubjectAdmissionResult {
  // The RPC may have committed despite timeout. Release by server UUID; SQL
  // handles release-before-reserve with an idempotent cancellation tombstone.
  console.error("[public-subject-admission] check failed", { mode, failure });
  return admissionResult(
    mode === "observe",
    mode,
    `${failure}_${mode === "observe" ? "open" : "closed"}`,
    failure,
    reservationId,
    true,
    true,
    true,
  );
}

/** Reserve once after identity verification and, for v3, after claimed-turn
 * replay has been bound to the same verified subject. No browser-controlled
 * ID or route is accepted; UUID is minted here and quota is cross-route. */
export async function reservePublicSubjectAdmission({
  verification,
  route,
  rpc,
  timeoutMs = DEFAULT_CHECK_RPC_TIMEOUT_MS,
  readEnv = (name) => Deno.env.get(name),
}: PublicSubjectAdmissionOptions): Promise<PublicSubjectAdmissionResult> {
  if (verification.mode === "off") {
    const currentMode = readEnv("PUBLIC_SUBJECT_ADMISSION_MODE");
    if (currentMode !== undefined && currentMode !== "off") {
      return admissionResult(
        false,
        "invalid",
        "invalid_configuration",
        "invalid_mode",
      );
    }
    return admissionResult(true, "off", "off");
  }
  if (!verification.allowed || !verification.subjectHash) {
    return admissionResult(
      verification.allowed,
      verification.mode,
      verification.reason,
      verification.failure,
      null,
      false,
      false,
      verification.wouldReject,
    );
  }
  const mode = verification.mode;
  if (mode !== "observe" && mode !== "enforce") {
    return admissionResult(
      false,
      "invalid",
      "invalid_configuration",
      "invalid_mode",
    );
  }
  if (!VALID_ROUTES.has(route)) {
    return admissionResult(
      mode === "observe",
      mode,
      "invalid_configuration",
      "invalid_route",
      null,
      false,
      false,
      true,
    );
  }
  // Fail closed on a mode flip between proof verification and reserve.
  if (readEnv("PUBLIC_SUBJECT_ADMISSION_MODE") !== mode) {
    return admissionResult(
      false,
      mode,
      "invalid_configuration",
      "invalid_mode",
    );
  }
  const perMinute = parsePositiveLimit(
    readEnv("PUBLIC_SUBJECT_LIMIT_PER_MINUTE"),
  );
  const inFlight = parsePositiveLimit(
    readEnv("PUBLIC_SUBJECT_LIMIT_IN_FLIGHT"),
  );
  if (perMinute.invalid || inFlight.invalid) {
    return admissionResult(
      mode === "observe",
      mode,
      "invalid_configuration",
      "invalid_limit",
      null,
      false,
      false,
      true,
    );
  }
  if (
    mode === "enforce" &&
    (perMinute.value === null || inFlight.value === null)
  ) {
    return admissionResult(
      false,
      mode,
      "invalid_configuration",
      "missing_enforcement_limit",
    );
  }

  const reservationId = crypto.randomUUID();
  let expired = false;
  try {
    const response = await runWithDeadline(
      () =>
        rpc("reserve_public_subject_admission", {
          p_subject_hash: verification.subjectHash as string,
          p_route: route,
          p_reservation_id: reservationId,
          p_mode: mode,
          p_window_seconds: WINDOW_SECONDS,
          p_max_requests: perMinute.value,
          p_max_inflight: inFlight.value,
        }),
      timeoutMs,
      () => {
        expired = true;
      },
    );
    if (response.error) return rpcFailure(mode, "rpc_error", reservationId);
    return parseDecision(response.data, mode, reservationId) ??
      rpcFailure(mode, "invalid_rpc_response", reservationId);
  } catch {
    return rpcFailure(
      mode,
      expired ? "rpc_timeout" : "rpc_error",
      reservationId,
    );
  }
}

/** Safe after a lost reserve response, cancellation, or duplicate terminal
 * paths. No subject hash or signed proof is needed for release. */
export async function releasePublicSubjectAdmission({
  reservation,
  rpc,
  timeoutMs = DEFAULT_RELEASE_RPC_TIMEOUT_MS,
}: {
  reservation: PublicSubjectAdmissionResult;
  rpc: PublicSubjectAdmissionRpc;
  timeoutMs?: number;
}): Promise<PublicSubjectAdmissionReleaseResult> {
  if (!reservation.releaseRequired || !reservation.reservationId) {
    return { attempted: false, released: false, failure: null };
  }
  let lastFailure: PublicSubjectAdmissionReleaseResult["failure"] = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    let expired = false;
    try {
      const response = await runWithDeadline(
        () =>
          rpc("release_public_subject_admission", {
            p_reservation_id: reservation.reservationId as string,
          }),
        timeoutMs,
        () => {
          expired = true;
        },
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
  console.error("[public-subject-admission] release failed", {
    failure: lastFailure,
  });
  return { attempted: true, released: false, failure: lastFailure };
}

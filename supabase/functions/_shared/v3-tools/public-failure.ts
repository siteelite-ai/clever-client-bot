/**
 * Boundary between operational failures and browser-visible output.
 *
 * Raw upstream bodies remain available in server logs through Error.message,
 * but callers must expose only PublicFailure.public_code and customer_message.
 */

export type PublicFailureKind =
  | "request_aborted"
  | "request_timeout"
  | "upstream_quota"
  | "upstream_auth"
  | "upstream_rate_limit"
  | "upstream_unavailable"
  | "upstream_rejected"
  | "internal";

export interface PublicFailure {
  kind: PublicFailureKind;
  public_code: string;
  customer_message: string;
  retryable: boolean;
}

export type UpstreamFailureOrigin = "http_response" | "completion_envelope";
export type UpstreamProvider = "openrouter" | "lovable" | "other";

export interface UpstreamFailureDiagnostics {
  origin?: UpstreamFailureOrigin;
  observedHttpStatus?: number;
  provider?: UpstreamProvider;
  failedOver?: boolean;
  primaryStatus?: number | null;
  primarySkipped?: boolean;
}

/** Structured transport error: classification never depends on its rendered message. */
export class UpstreamHttpError extends Error {
  readonly status: number;
  readonly response_body: string;
  readonly origin: UpstreamFailureOrigin;
  readonly observed_http_status: number;
  readonly provider: UpstreamProvider | null;
  readonly failed_over: boolean | null;
  readonly primary_status: number | null;
  readonly primary_skipped: boolean | null;

  constructor(
    status: number,
    responseBody: string,
    diagnostics: UpstreamFailureDiagnostics = {},
  ) {
    const boundedBody = String(responseBody ?? "").slice(0, 500);
    super(`model_upstream_http_${status}: ${boundedBody}`);
    this.name = "UpstreamHttpError";
    this.status = status;
    this.response_body = boundedBody;
    this.origin = diagnostics.origin ?? "http_response";
    this.observed_http_status = diagnostics.observedHttpStatus ?? status;
    this.provider = diagnostics.provider ?? null;
    this.failed_over = diagnostics.failedOver ?? null;
    this.primary_status = diagnostics.primaryStatus ?? null;
    this.primary_skipped = diagnostics.primarySkipped ?? null;
  }
}

/** Bounded operational metadata only; never includes provider text or request content. */
export function upstreamFailureDiagnosticMeta(
  error: unknown,
): Record<string, unknown> {
  if (!(error instanceof UpstreamHttpError)) return {};
  return {
    upstream_origin: error.origin,
    observed_http_status: error.observed_http_status,
    upstream_provider: error.provider,
    provider_failed_over: error.failed_over,
    primary_http_status: error.primary_status,
    primary_skipped: error.primary_skipped,
  };
}

/** A provider's actual HTTP 5xx, not a synthetic 502 from an unusable HTTP 200.
 * A primary quota/rate-limit or malformed HTTP 200 followed by a failing
 * fallback must not be hidden by another paid attempt either. */
export function isConfirmedTransientUpstreamHttp5xx(
  error: unknown,
): error is UpstreamHttpError {
  return error instanceof UpstreamHttpError &&
    error.origin === "http_response" &&
    Number.isInteger(error.status) &&
    error.status >= 500 && error.status <= 599 &&
    error.observed_http_status === error.status &&
    (error.primary_status === null ||
      Number.isInteger(error.primary_status) &&
        error.primary_status >= 500 && error.primary_status <= 599);
}

/** A syntactically successful primary HTTP response without a usable choice.
 * Keep this distinct from a real HTTP 502 and from any provider failover: a
 * fallback response must not reopen the correction call budget. */
export function isPrimaryUnusableCompletionEnvelope(
  error: unknown,
): error is UpstreamHttpError {
  return error instanceof UpstreamHttpError &&
    error.status === 502 &&
    error.origin === "completion_envelope" &&
    error.observed_http_status === 200 &&
    error.failed_over === false &&
    error.primary_status === null &&
    error.primary_skipped === false;
}

type BoundedRetryInput<T> = {
  attempt: (timeoutMs: number) => Promise<T>;
  initialTimeoutMs: number;
  retryTimeoutMs: () => number | null;
  signal: AbortSignal;
  onRetry?: (error: UpstreamHttpError, timeoutMs: number) => void;
  now?: () => number;
};

async function retryEligibleUpstreamFailureOnce<T>(
  input: BoundedRetryInput<T>,
  eligible: (error: unknown) => error is UpstreamHttpError,
): Promise<T> {
  const now = input.now ?? (() => performance.now());
  const startedAt = now();
  try {
    return await input.attempt(input.initialTimeoutMs);
  } catch (error) {
    if (
      !eligible(error) || input.signal.aborted ||
      !Number.isFinite(input.initialTimeoutMs) ||
      !Number.isFinite(startedAt)
    ) throw error;
    const elapsedMs = now() - startedAt;
    if (
      !Number.isFinite(elapsedMs) || elapsedMs < 0 ||
      elapsedMs >= input.initialTimeoutMs
    ) throw error;
    const retryTimeoutMs = input.retryTimeoutMs();
    if (
      retryTimeoutMs === null || !Number.isFinite(retryTimeoutMs) ||
      retryTimeoutMs < 2_500 || input.signal.aborted
    ) throw error;
    input.onRetry?.(error, retryTimeoutMs);
    if (input.signal.aborted) throw error;
    // A second failure is final, even if it would independently be eligible.
    return await input.attempt(retryTimeoutMs);
  }
}

/** One bounded correction retry for an exact primary HTTP-200 envelope fault.
 * Real HTTP 5xx remains an explicit, independent opt-in. */
export function retryProductMeasurementUpstreamOnce<T>(
  input: BoundedRetryInput<T> & {
    retryRealHttp5xx: boolean;
    retryUnusableEnvelope: boolean;
  },
): Promise<T> {
  return retryEligibleUpstreamFailureOnce(
    input,
    (error): error is UpstreamHttpError =>
      (input.retryRealHttp5xx && isConfirmedTransientUpstreamHttp5xx(error)) ||
      (input.retryUnusableEnvelope &&
        isPrimaryUnusableCompletionEnvelope(error)),
  );
}

/** At most one extra attempt, with a fresh caller-supplied deadline budget.
 * Never start a second paid call after the first call's timeout or turn abort.
 * The same `attempt` closure keeps messages, tool schema, and model identical. */
export function retryConfirmedUpstreamHttp5xxOnce<T>(
  input: BoundedRetryInput<T>,
): Promise<T> {
  return retryEligibleUpstreamFailureOnce(
    input,
    isConfirmedTransientUpstreamHttp5xx,
  );
}

const TEMPORARILY_UNAVAILABLE =
  "Онлайн-консультант временно недоступен из-за ограничения внешнего сервиса. Ваш запрос сформулирован нормально — повторите его позже или свяжитесь с менеджером.";

const OVERLOADED =
  "Онлайн-консультант сейчас перегружен. Ваш запрос сформулирован нормально — повторите его немного позже или свяжитесь с менеджером.";

const TIMED_OUT =
  "Консультант не успел завершить подбор за отведённое время. Ваш запрос сформулирован нормально — повторите его позже или свяжитесь с менеджером.";

const INTERNAL_FAILURE =
  "Не удалось завершить ответ из-за внутренней ошибки. Ваш запрос сформулирован нормально — повторите его позже или свяжитесь с менеджером.";

function namedError(error: unknown): { name: string; message: string } {
  if (error instanceof Error || error instanceof DOMException) {
    return {
      name: String(error.name ?? ""),
      message: String(error.message ?? ""),
    };
  }
  return { name: "", message: String(error ?? "") };
}

/** Returns a data-only, secret-free description suitable for SSE and UI text. */
export function classifyPublicFailure(error: unknown): PublicFailure {
  const named = namedError(error);
  const normalizedName = named.name.toLocaleLowerCase("en-US");
  const normalizedMessage = named.message.toLocaleLowerCase("en-US");
  if (
    normalizedName === "aborterror" ||
    /\babort(?:ed)?\b/u.test(normalizedMessage)
  ) {
    return {
      kind: "request_aborted",
      public_code: "request_aborted",
      customer_message: TIMED_OUT,
      retryable: true,
    };
  }
  if (
    normalizedName === "timeouterror" ||
    normalizedMessage.includes("llm_call_timeout")
  ) {
    return {
      kind: "request_timeout",
      public_code: "request_timeout",
      customer_message: TIMED_OUT,
      retryable: true,
    };
  }

  if (error instanceof UpstreamHttpError) {
    const body = error.response_body.toLocaleLowerCase("en-US");
    const quota = /(?:quota|limit exceeded|credit|budget|insufficient)/u.test(
      body,
    );
    if (error.status === 402 || (error.status === 403 && quota)) {
      return {
        kind: "upstream_quota",
        public_code: "upstream_quota_exceeded",
        customer_message: TEMPORARILY_UNAVAILABLE,
        retryable: false,
      };
    }
    if (error.status === 401 || error.status === 403) {
      return {
        kind: "upstream_auth",
        public_code: "upstream_access_unavailable",
        customer_message: TEMPORARILY_UNAVAILABLE,
        retryable: false,
      };
    }
    if (error.status === 429) {
      return {
        kind: "upstream_rate_limit",
        public_code: "upstream_rate_limited",
        customer_message: OVERLOADED,
        retryable: true,
      };
    }
    if (error.status >= 500) {
      return {
        kind: "upstream_unavailable",
        public_code: "upstream_unavailable",
        customer_message: TEMPORARILY_UNAVAILABLE,
        retryable: true,
      };
    }
    return {
      kind: "upstream_rejected",
      public_code: "upstream_request_rejected",
      customer_message: TEMPORARILY_UNAVAILABLE,
      retryable: false,
    };
  }

  return {
    kind: "internal",
    public_code: "internal_error",
    customer_message: INTERNAL_FAILURE,
    retryable: false,
  };
}

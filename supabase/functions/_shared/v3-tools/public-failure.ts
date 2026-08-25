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

/** Structured transport error: classification never depends on its rendered message. */
export class UpstreamHttpError extends Error {
  readonly status: number;
  readonly response_body: string;

  constructor(status: number, responseBody: string) {
    const boundedBody = String(responseBody ?? "").slice(0, 500);
    super(`model_upstream_http_${status}: ${boundedBody}`);
    this.name = "UpstreamHttpError";
    this.status = status;
    this.response_body = boundedBody;
  }
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
    return { name: String(error.name ?? ""), message: String(error.message ?? "") };
  }
  return { name: "", message: String(error ?? "") };
}

/** Returns a data-only, secret-free description suitable for SSE and UI text. */
export function classifyPublicFailure(error: unknown): PublicFailure {
  const named = namedError(error);
  const normalizedName = named.name.toLocaleLowerCase("en-US");
  const normalizedMessage = named.message.toLocaleLowerCase("en-US");
  if (normalizedName === "aborterror" || /\babort(?:ed)?\b/u.test(normalizedMessage)) {
    return {
      kind: "request_aborted",
      public_code: "request_aborted",
      customer_message: TIMED_OUT,
      retryable: true,
    };
  }
  if (normalizedName === "timeouterror" || normalizedMessage.includes("llm_call_timeout")) {
    return {
      kind: "request_timeout",
      public_code: "request_timeout",
      customer_message: TIMED_OUT,
      retryable: true,
    };
  }

  if (error instanceof UpstreamHttpError) {
    const body = error.response_body.toLocaleLowerCase("en-US");
    const quota = /(?:quota|limit exceeded|credit|budget|insufficient)/u.test(body);
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

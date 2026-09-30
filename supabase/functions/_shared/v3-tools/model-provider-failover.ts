export interface ChatCompletionProvider {
  id: string;
  url: string;
  apiKey: string;
  model?: string;
  headers?: Record<string, string>;
}

export interface ChatCompletionRequest {
  primary: ChatCompletionProvider;
  fallback?: ChatCompletionProvider | null;
  body: Record<string, unknown>;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
  quotaCooldown?: ProviderQuotaCooldown | null;
}

export interface ChatCompletionResponse {
  response: Response;
  provider: string;
  failedOver: boolean;
  primaryStatus?: number;
  primarySkipped?: boolean;
}

export interface ProviderQuotaCooldown {
  blockedStatus(provider: ChatCompletionProvider): number | null;
  record(provider: ChatCompletionProvider, response: Response): void;
  clear(provider: ChatCompletionProvider): void;
}

export type ChatCompletionDeploymentVariant = "production" | "preview";

export interface ChatCompletionFailoverPolicyInput {
  deploymentVariant: ChatCompletionDeploymentVariant;
  globalEnabled?: string | null;
  previewEnabled?: string | null;
}

/**
 * Resolves the provider failover switch without letting a preview-only test
 * flag alter the production function. The legacy global flag remains an
 * explicit project-wide opt-in; otherwise only the preview wrapper may use
 * LOVABLE_AGENT_FAILOVER_PREVIEW_ENABLED.
 */
export function isChatCompletionFailoverEnabled(
  input: ChatCompletionFailoverPolicyInput,
): boolean {
  if (input.globalEnabled === "true") return true;
  return input.deploymentVariant === "preview" &&
    input.previewEnabled === "true";
}

interface ProviderQuotaCooldownOptions {
  now?: () => number;
  quotaCooldownMs?: number;
  rateLimitCooldownMs?: number;
  maxCooldownMs?: number;
}

function providerKey(provider: ChatCompletionProvider): string {
  return `${provider.id}\u0000${provider.url}`;
}

function boundedRetryAfterMs(
  value: string | null,
  now: number,
  fallbackMs: number,
  maxMs: number,
): number {
  if (!value) return Math.min(fallbackMs, maxMs);
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.min(Math.max(Math.ceil(seconds * 1000), 1_000), maxMs);
  }
  const date = Date.parse(value);
  if (Number.isFinite(date) && date > now) {
    return Math.min(Math.max(date - now, 1_000), maxMs);
  }
  return Math.min(fallbackMs, maxMs);
}

/**
 * Keeps a short, isolate-local memory of confirmed quota failures. It does not
 * change a successful request path and never persists credentials or customer
 * data. The bounded TTL lets service recover automatically after a top-up.
 */
export function createProviderQuotaCooldown(
  options: ProviderQuotaCooldownOptions = {},
): ProviderQuotaCooldown {
  const now = options.now ?? Date.now;
  const quotaCooldownMs = Math.max(1_000, options.quotaCooldownMs ?? 30_000);
  const rateLimitCooldownMs = Math.max(
    1_000,
    options.rateLimitCooldownMs ?? 10_000,
  );
  const maxCooldownMs = Math.max(1_000, options.maxCooldownMs ?? 60_000);
  const blocked = new Map<string, { status: number; until: number }>();

  return {
    blockedStatus(provider) {
      const key = providerKey(provider);
      const state = blocked.get(key);
      if (!state) return null;
      if (state.until <= now()) {
        blocked.delete(key);
        return null;
      }
      return state.status;
    },
    record(provider, response) {
      if (response.status !== 402 && response.status !== 429) return;
      const current = now();
      const fallbackMs = response.status === 402
        ? quotaCooldownMs
        : rateLimitCooldownMs;
      const duration = boundedRetryAfterMs(
        response.headers.get("retry-after"),
        current,
        fallbackMs,
        maxCooldownMs,
      );
      blocked.set(providerKey(provider), {
        status: response.status,
        until: current + duration,
      });
    },
    clear(provider) {
      blocked.delete(providerKey(provider));
    },
  };
}

const SHARED_PROVIDER_QUOTA_COOLDOWN = createProviderQuotaCooldown();

/** Only capacity and transient upstream failures may switch providers. Client
 * validation and authentication errors stay visible instead of being hidden by
 * a second destination. */
export function shouldFailoverChatCompletion(status: number): boolean {
  return status === 402 || status === 408 || status === 409 || status === 429 ||
    status >= 500;
}

/** Some OpenAI-compatible gateways report a provider failure as HTTP 200 with
 * an unusable choice whose finish_reason is `error`. Treat that envelope as a
 * transport failure instead of allowing callers to mark an empty completion
 * as recovered. */
export function isProviderErrorFinishReason(value: unknown): boolean {
  return typeof value === "string" && value.trim().toLowerCase() === "error";
}

function providerBody(
  body: Record<string, unknown>,
  provider: ChatCompletionProvider,
): Record<string, unknown> {
  if (!provider.model) return { ...body };
  const copy: Record<string, unknown> = { ...body, model: provider.model };
  delete copy.models;
  return copy;
}

async function callProvider(
  provider: ChatCompletionProvider,
  body: Record<string, unknown>,
  signal: AbortSignal | undefined,
  fetchImpl: typeof fetch,
): Promise<Response> {
  return fetchImpl(provider.url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${provider.apiKey}`,
      "Content-Type": "application/json",
      ...(provider.headers ?? {}),
    },
    body: JSON.stringify(providerBody(body, provider)),
    signal,
  });
}

/**
 * Executes one OpenAI-compatible completion with a bounded provider failover.
 * The primary response body is cancelled before retrying so edge connections
 * do not leak. The request payload, tools and tool choice are preserved; only
 * the provider-specific model identifier is replaced.
 */
export async function fetchChatCompletionWithFailover(
  input: ChatCompletionRequest,
): Promise<ChatCompletionResponse> {
  const fetchImpl = input.fetchImpl ?? fetch;
  // Injected fetch implementations are normally tests. They opt into a
  // registry explicitly so test calls cannot leak cooldown state into one
  // another, while production calls share one bounded isolate-local registry.
  const cooldown = input.quotaCooldown === undefined
    ? (input.fetchImpl ? null : SHARED_PROVIDER_QUOTA_COOLDOWN)
    : input.quotaCooldown;
  const blockedStatus = cooldown?.blockedStatus(input.primary) ?? null;
  if (blockedStatus !== null) {
    if (input.fallback?.apiKey) {
      const fallback = await callProvider(
        input.fallback,
        input.body,
        input.signal,
        fetchImpl,
      );
      return {
        response: fallback,
        provider: input.fallback.id,
        failedOver: true,
        primaryStatus: blockedStatus,
        primarySkipped: true,
      };
    }
    return {
      response: Response.json(
        { error: { code: "provider_quota_cooldown", status: blockedStatus } },
        { status: blockedStatus },
      ),
      provider: input.primary.id,
      failedOver: false,
      primaryStatus: blockedStatus,
      primarySkipped: true,
    };
  }

  const primary = await callProvider(
    input.primary,
    input.body,
    input.signal,
    fetchImpl,
  );
  if (primary.ok) cooldown?.clear(input.primary);
  else cooldown?.record(input.primary, primary);
  if (
    primary.ok ||
    !input.fallback?.apiKey ||
    !shouldFailoverChatCompletion(primary.status)
  ) {
    return {
      response: primary,
      provider: input.primary.id,
      failedOver: false,
      primarySkipped: false,
    };
  }

  const primaryStatus = primary.status;
  await primary.body?.cancel();
  const fallback = await callProvider(
    input.fallback,
    input.body,
    input.signal,
    fetchImpl,
  );
  return {
    response: fallback,
    provider: input.fallback.id,
    failedOver: true,
    primaryStatus,
    primarySkipped: false,
  };
}

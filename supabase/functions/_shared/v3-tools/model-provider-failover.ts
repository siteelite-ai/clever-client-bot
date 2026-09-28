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
}

export interface ChatCompletionResponse {
  response: Response;
  provider: string;
  failedOver: boolean;
  primaryStatus?: number;
}

/** Only capacity and transient upstream failures may switch providers. Client
 * validation and authentication errors stay visible instead of being hidden by
 * a second destination. */
export function shouldFailoverChatCompletion(status: number): boolean {
  return status === 402 || status === 408 || status === 409 || status === 429 || status >= 500;
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
  const primary = await callProvider(input.primary, input.body, input.signal, fetchImpl);
  if (
    primary.ok ||
    !input.fallback?.apiKey ||
    !shouldFailoverChatCompletion(primary.status)
  ) {
    return { response: primary, provider: input.primary.id, failedOver: false };
  }

  const primaryStatus = primary.status;
  await primary.body?.cancel();
  const fallback = await callProvider(input.fallback, input.body, input.signal, fetchImpl);
  return {
    response: fallback,
    provider: input.fallback.id,
    failedOver: true,
    primaryStatus,
  };
}

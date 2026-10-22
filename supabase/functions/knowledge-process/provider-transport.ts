/**
 * Keep provider response bodies and thrown error objects out of Edge logs.
 * A provider or intermediary can reflect the Authorization header in either.
 */
export type ProviderFailure =
  | { kind: 'http_error'; status: number }
  | { kind: 'invalid_response'; status: number }
  | { kind: 'network_error' };

export async function requestOpenRouterEmbedding(
  model: string,
  input: string,
  apiKey: string,
  reportFailure: (failure: ProviderFailure) => void,
  fetchImpl: typeof fetch = fetch,
): Promise<number[] | null> {
  let response: Response;
  try {
    response = await fetchImpl('https://openrouter.ai/api/v1/embeddings', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ model, input, dimensions: 768 }),
    });
  } catch {
    reportFailure({ kind: 'network_error' });
    return null;
  }

  if (!response.ok) {
    // Never read the error body: it may echo the bearer credential.
    reportFailure({ kind: 'http_error', status: response.status });
    return null;
  }

  try {
    const data = await response.json();
    const embedding = data?.data?.[0]?.embedding;
    if (
      Array.isArray(embedding) && embedding.length > 0 &&
      embedding.every((value: unknown) =>
        typeof value === 'number' && Number.isFinite(value)
      )
    ) {
      return embedding;
    }
  } catch {
    // Parsing errors can contain a sample of the response body.
  }

  reportFailure({ kind: 'invalid_response', status: response.status });
  return null;
}

/** The PDF gateway uses a different key but has the same reflected-error risk. */
export async function requestPdfCompletion(
  base64Content: string,
  apiKey: string,
  reportFailure: (failure: ProviderFailure) => void,
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  let response: Response;
  try {
    response = await fetchImpl('https://ai.gateway.lovable.dev/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'google/gemini-3-flash-preview',
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'text',
                text: 'Извлеки весь текст из этого PDF документа. Верни структурированный текст с сохранением заголовков и параграфов. В начале укажи заголовок документа если он есть.',
              },
              {
                type: 'image_url',
                image_url: { url: `data:application/pdf;base64,${base64Content}` },
              },
            ],
          },
        ],
      }),
    });
  } catch {
    reportFailure({ kind: 'network_error' });
    throw new Error('Ошибка обработки PDF: сеть');
  }

  if (!response.ok) {
    reportFailure({ kind: 'http_error', status: response.status });
    throw new Error(`Ошибка обработки PDF: ${response.status}`);
  }

  try {
    const data = await response.json();
    const content = data?.choices?.[0]?.message?.content;
    return typeof content === 'string' ? content : '';
  } catch {
    reportFailure({ kind: 'invalid_response', status: response.status });
    throw new Error('Ошибка обработки PDF: некорректный ответ');
  }
}

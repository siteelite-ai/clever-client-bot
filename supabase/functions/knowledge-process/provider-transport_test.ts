import {
  type ProviderFailure,
  requestOpenRouterEmbedding,
  requestPdfCompletion,
} from './provider-transport.ts';

function assertEquals(actual: unknown, expected: unknown): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

const dummyKey = 'ci-reflected-bearer-must-not-appear-in-logs';

Deno.test('embedding transport reports only HTTP status when error body reflects the key', async () => {
  const failures: ProviderFailure[] = [];
  let authorization: string | null = null;
  const response = new Response(`Authorization: Bearer ${dummyKey}`, { status: 429 });
  const fetchImpl: typeof fetch = async (_input, init) => {
    authorization = new Headers(init?.headers).get('Authorization');
    return response;
  };

  const result = await requestOpenRouterEmbedding(
    'ci-model', 'fixture text', dummyKey,
    (failure) => failures.push(failure), fetchImpl,
  );
  assertEquals(result, null);
  assertEquals(authorization, `Bearer ${dummyKey}`);
  assertEquals(failures, [{ kind: 'http_error', status: 429 }]);
  assertEquals(response.bodyUsed, false);
  if (JSON.stringify(failures).includes(dummyKey)) {
    throw new Error('Provider credential appeared in safe diagnostics');
  }
});

Deno.test('embedding transport never reports a thrown error containing the key', async () => {
  const failures: ProviderFailure[] = [];
  const fetchImpl: typeof fetch = async () => {
    throw new Error(`Proxy failed after Authorization: Bearer ${dummyKey}`);
  };
  const result = await requestOpenRouterEmbedding(
    'ci-model', 'fixture text', dummyKey,
    (failure) => failures.push(failure), fetchImpl,
  );
  assertEquals(result, null);
  assertEquals(failures, [{ kind: 'network_error' }]);
  if (JSON.stringify(failures).includes(dummyKey)) {
    throw new Error('Thrown credential appeared in safe diagnostics');
  }
});

Deno.test('embedding transport retains successful numeric responses and rejects malformed ones', async () => {
  const successFailures: ProviderFailure[] = [];
  const success = await requestOpenRouterEmbedding(
    'ci-model', 'fixture text', dummyKey,
    (failure) => successFailures.push(failure),
    async () => Response.json({ data: [{ embedding: [0.1, 0.2] }] }),
  );
  assertEquals(success, [0.1, 0.2]);
  assertEquals(successFailures, []);

  const invalidFailures: ProviderFailure[] = [];
  const invalid = await requestOpenRouterEmbedding(
    'ci-model', 'fixture text', dummyKey,
    (failure) => invalidFailures.push(failure),
    async () => new Response(`not-json ${dummyKey}`, { status: 200 }),
  );
  assertEquals(invalid, null);
  assertEquals(invalidFailures, [{ kind: 'invalid_response', status: 200 }]);
  if (JSON.stringify(invalidFailures).includes(dummyKey)) {
    throw new Error('Malformed provider body appeared in safe diagnostics');
  }
});

Deno.test('PDF gateway reports status without reading an error body that reflects its key', async () => {
  const failures: ProviderFailure[] = [];
  const pdfKey = 'ci-reflected-pdf-key-must-not-appear-in-logs';
  const response = new Response(`Authorization: Bearer ${pdfKey}`, { status: 503 });
  let authorization: string | null = null;
  const fetchImpl: typeof fetch = async (_input, init) => {
    authorization = new Headers(init?.headers).get('Authorization');
    return response;
  };
  let errorMessage: string | null = null;
  try {
    await requestPdfCompletion('fixture-base64', pdfKey, (failure) => failures.push(failure), fetchImpl);
  } catch (error) {
    errorMessage = error instanceof Error ? error.message : String(error);
  }
  assertEquals(authorization, `Bearer ${pdfKey}`);
  assertEquals(failures, [{ kind: 'http_error', status: 503 }]);
  assertEquals(errorMessage, 'Ошибка обработки PDF: 503');
  assertEquals(response.bodyUsed, false);
  if (`${JSON.stringify(failures)} ${errorMessage}`.includes(pdfKey)) {
    throw new Error('PDF credential appeared in diagnostics');
  }
});

Deno.test('PDF gateway rejects a secret-bearing network exception without reflecting it', async () => {
  const failures: ProviderFailure[] = [];
  const pdfKey = 'ci-reflected-pdf-key-must-not-appear-in-logs';
  const fetchImpl: typeof fetch = async () => {
    throw new Error(`Proxy echoed Authorization: Bearer ${pdfKey}`);
  };
  let errorMessage: string | null = null;
  try {
    await requestPdfCompletion('fixture-base64', pdfKey, (failure) => failures.push(failure), fetchImpl);
  } catch (error) {
    errorMessage = error instanceof Error ? error.message : String(error);
  }
  assertEquals(failures, [{ kind: 'network_error' }]);
  assertEquals(errorMessage, 'Ошибка обработки PDF: сеть');
  if (`${JSON.stringify(failures)} ${errorMessage}`.includes(pdfKey)) {
    throw new Error('PDF network exception leaked a credential');
  }
});

Deno.test('PDF gateway preserves successful completion text', async () => {
  const failures: ProviderFailure[] = [];
  const content = await requestPdfCompletion(
    'fixture-base64', 'ci-pdf-key',
    (failure) => failures.push(failure),
    async () => Response.json({ choices: [{ message: { content: 'Заголовок\nТекст' } }] }),
  );
  assertEquals(content, 'Заголовок\nТекст');
  assertEquals(failures, []);
});

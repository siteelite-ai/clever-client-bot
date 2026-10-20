import { handleRequest as productionHandleRequest, resetCatalogCachesForTest } from './index.ts';

function handleRequest(req: Request, deps: Parameters<typeof productionHandleRequest>[1] = {}): Promise<Response> {
  // Existing compatibility tests exercise off mode explicitly, without needing
  // Deno env access. Admission-specific tests override this reader below.
  return productionHandleRequest(req, { publicAdmissionReadEnv: () => undefined, ...deps });
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function assertEquals(actual: unknown, expected: unknown): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

const endpoint = 'https://example.test/functions/v1/search-products';

function post(body: unknown): Request {
  return new Request(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function forbiddenUpstream() {
  let tokenCalls = 0;
  let fetchCalls = 0;
  return {
    deps: {
      getApiToken: async () => {
        tokenCalls++;
        throw new Error('No token read expected');
      },
      fetch: async () => {
        fetchCalls++;
        throw new Error('No catalog call expected');
      },
    },
    assertUnused: () => assertEquals({ tokenCalls, fetchCalls }, { tokenCalls: 0, fetchCalls: 0 }),
  };
}

Deno.test('search-products rejects unsupported methods before reading token or catalog', async () => {
  const upstream = forbiddenUpstream();
  const get = await handleRequest(new Request(endpoint), upstream.deps);
  assertEquals(get.status, 405);
  assertEquals(get.headers.get('Allow'), 'POST, OPTIONS');
  assertEquals(get.headers.get('Access-Control-Allow-Origin'), '*');
  const preflight = await handleRequest(new Request(endpoint, { method: 'OPTIONS' }), upstream.deps);
  assertEquals(preflight.status, 200);
  assertEquals(await preflight.text(), 'ok');
  upstream.assertUnused();
});

Deno.test('search-products rejects malformed, non-object and oversized bodies before upstream', async () => {
  const upstream = forbiddenUpstream();
  for (const body of ['{', 'null', '[]', '']) {
    const response = await handleRequest(new Request(endpoint, { method: 'POST', body }), upstream.deps);
    assertEquals(response.status, 400);
    assert(Array.isArray((await response.json()).results), 'error retains results envelope');
  }
  const oversized = await handleRequest(new Request(endpoint, {
    method: 'POST',
    body: JSON.stringify({ query: 'x'.repeat(66_000) }),
  }), upstream.deps);
  assertEquals(oversized.status, 413);
  const declaredOversized = await handleRequest(new Request(endpoint, {
    method: 'POST',
    headers: { 'Content-Length': '999999' },
    body: '{}',
  }), upstream.deps);
  assertEquals(declaredOversized.status, 413);
  upstream.assertUnused();
});

Deno.test('search-products times out trickling ingress before admission or catalog work', async () => {
  const upstream = forbiddenUpstream();
  let cancelled = false;
  let rpcCalls = 0;
  const response = await handleRequest(new Request(endpoint, {
    method: 'POST',
    body: new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new TextEncoder().encode('{')); },
      cancel() { cancelled = true; },
    }),
  }), {
    ...upstream.deps,
    bodyReadTimeoutMs: 15,
    publicAdmissionRpc: () => { rpcCalls++; throw new Error('body not validated'); },
  });
  assertEquals(response.status, 408);
  const body = await response.json();
  assertEquals(body.error, 'Request body timed out');
  assert(Array.isArray(body.results), 'error retains the search response envelope');
  assertEquals(cancelled, true);
  assertEquals(rpcCalls, 0);
  upstream.assertUnused();
});

Deno.test('search-products validates action, selectors and pagination before upstream', async () => {
  const upstream = forbiddenUpstream();
  const invalid = [
    { action: 'not_supported' },
    { query: { nested: true } },
    { query: 'x'.repeat(513) },
    { page: 0 },
    { page: 1001 },
    { perPage: 201 },
    { perPage: 'Infinity' },
    { minPrice: -1 },
    { action: 'category_facets' },
    { action: 'category_facets', categoryId: '../../products' },
  ];
  for (const body of invalid) {
    const response = await handleRequest(post(body), upstream.deps);
    assertEquals(response.status, 400);
  }
  upstream.assertUnused();
});

Deno.test('search-products preserves legacy v2 POST search fields and response envelope', async () => {
  let tokenCalls = 0;
  const urls: URL[] = [];
  const response = await handleRequest(post({
    action: 'search', query: 'кабель ВВГ 3*1,5', page: '2', perPage: 200,
    category: 'Кабель и провод', minPrice: 0, maxPrice: '4000', brand: 'IEK',
  }), {
    getApiToken: async () => {
      tokenCalls++;
      return 'catalog-test-token';
    },
    fetch: async (input, init) => {
      urls.push(new URL(String(input)));
      assertEquals((init?.headers as Record<string, string>).Authorization, 'Bearer catalog-test-token');
      return Response.json({ data: { results: [{ id: 1 }], pagination: { page: 2, per_page: 200, total: 1 } } });
    },
  });
  assertEquals(response.status, 200);
  assertEquals(tokenCalls, 1);
  assertEquals(urls.length, 1);
  assertEquals(urls[0].searchParams.get('query'), 'кабель ВВГ 3*1,5');
  assertEquals(urls[0].searchParams.get('page'), '2');
  assertEquals(urls[0].searchParams.get('per_page'), '200');
  assertEquals(urls[0].searchParams.get('category'), 'Кабель и провод');
  assertEquals(urls[0].searchParams.get('max_price'), '4000');
  assertEquals(urls[0].searchParams.get('options[brend__brend][]'), 'IEK');
  assertEquals(await response.json(), { results: [{ id: 1 }], pagination: { page: 2, per_page: 200, total: 1 } });
});

Deno.test('search-products still accepts the original POST body without an action', async () => {
  let catalogCalls = 0;
  const response = await handleRequest(post({}), {
    getApiToken: async () => 'catalog-test-token',
    fetch: async (input) => {
      catalogCalls++;
      const url = new URL(String(input));
      assertEquals(url.searchParams.get('page'), '1');
      assertEquals(url.searchParams.get('per_page'), '12');
      return Response.json({ data: { results: [] } });
    },
  });
  assertEquals(response.status, 200);
  assertEquals(catalogCalls, 1);
  assertEquals((await response.json()).results, []);
});

Deno.test('search-products preserves legacy by_sku, category facets and category listing', async () => {
  const urls: URL[] = [];
  const deps = {
    getApiToken: async () => 'catalog-test-token',
    fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      assert(init?.signal instanceof AbortSignal, `${url.pathname} must receive a cancellation signal`);
      urls.push(url);
      if (url.pathname.endsWith('/options')) {
        return Response.json({ data: { category: { id: 742 }, options: [{ key: 'brand' }] } });
      }
      if (url.pathname.endsWith('/categories')) {
        return Response.json({ data: { results: [{ pagetitle: 'Розетки', children: [] }], pagination: { pages: 1 } } });
      }
      return Response.json({ data: { results: [{ article: 'A-123' }], pagination: { total: 1 } } });
    },
  };
  const sku = await handleRequest(post({ action: 'by_sku', article: 'A-123', query: 'ignored' }), deps);
  assertEquals(sku.status, 200);
  assertEquals(urls[0].searchParams.get('article'), 'A-123');
  assertEquals(urls[0].searchParams.get('query'), null);
  assertEquals((await sku.json()).results, [{ article: 'A-123' }]);

  const facets = await handleRequest(post({ action: 'category_facets', categoryId: 742 }), deps);
  assertEquals(facets.status, 200);
  assertEquals(urls[1].pathname, '/api/categories/742/options');
  assertEquals((await facets.json()).options, [{ key: 'brand' }]);

  const categories = await handleRequest(post({ action: 'list_categories' }), deps);
  assertEquals(categories.status, 200);
  assertEquals((await categories.json()).categories, ['Розетки']);
});

Deno.test('list_categories rejects implausible upstream page counts without returning a truncated list', async () => {
  resetCatalogCachesForTest();
  let calls = 0;
  const response = await handleRequest(post({ action: 'list_categories' }), {
    getApiToken: async () => 'catalog-test-token',
    fetch: async () => {
      calls++;
      return Response.json({ data: { results: [{ pagetitle: 'Светильники' }], pagination: { pages: 1_000_000 } } });
    },
  });
  assertEquals(response.status, 500);
  assertEquals(calls, 1);
  assert((await response.json()).error.includes('safe page limit'), 'safe page limit is explicit');
});

Deno.test('list_categories bounds fan-out, coalesces cold requests and serves the cached full list', async () => {
  resetCatalogCachesForTest();
  const calls: number[] = [];
  let active = 0;
  let peakActive = 0;
  const deps = {
    getApiToken: async () => 'catalog-test-token',
    fetch: async (input: RequestInfo | URL) => {
      const page = Number(new URL(String(input)).searchParams.get('page'));
      calls.push(page);
      active++;
      peakActive = Math.max(peakActive, active);
      await new Promise((resolve) => setTimeout(resolve, 1));
      active--;
      return Response.json({ data: { results: [{ pagetitle: `Категория ${page}` }], pagination: { pages: 9 } } });
    },
  };
  const [first, second] = await Promise.all([
    handleRequest(post({ action: 'list_categories' }), deps),
    handleRequest(post({ action: 'list_categories' }), deps),
  ]);
  assertEquals(first.status, 200);
  assertEquals(second.status, 200);
  assertEquals((await first.json()).count, 9);
  assertEquals((await second.json()).count, 9);
  assertEquals(calls.sort((a, b) => a - b), [1, 2, 3, 4, 5, 6, 7, 8, 9]);
  assert(peakActive <= 4, `expected at most four concurrent catalog calls, got ${peakActive}`);
  const cached = await handleRequest(post({ action: 'list_categories' }), deps);
  assertEquals(cached.status, 200);
  assertEquals((await cached.json()).count, 9);
  assertEquals(calls.length, 9);
});

Deno.test('category_facets coalesces duplicate misses and bounds its LRU cache', async () => {
  resetCatalogCachesForTest();
  const calls = new Map<number, number>();
  const deps = {
    getApiToken: async () => 'catalog-test-token',
    fetch: async (input: RequestInfo | URL) => {
      const categoryId = Number(new URL(String(input)).pathname.split('/').at(-2));
      calls.set(categoryId, (calls.get(categoryId) || 0) + 1);
      await new Promise((resolve) => setTimeout(resolve, 1));
      return Response.json({ data: { category: { id: categoryId }, options: [] } });
    },
  };
  const requestFor = (categoryId: number) => handleRequest(post({ action: 'category_facets', categoryId }), deps);
  const [first, second] = await Promise.all([requestFor(10_001), requestFor(10_001)]);
  assertEquals(first.status, 200);
  assertEquals(second.status, 200);
  assertEquals(calls.get(10_001), 1);
  assertEquals((await first.json()).cacheHit, false);
  assertEquals((await second.json()).cacheHit, false);

  for (let id = 10_002; id <= 10_128; id++) {
    assertEquals((await requestFor(id)).status, 200);
  }
  assertEquals((await (await requestFor(10_001)).json()).cacheHit, true);
  assertEquals((await requestFor(10_129)).status, 200);
  assertEquals((await (await requestFor(10_002)).json()).cacheHit, false);
  assertEquals(calls.get(10_001), 1);
  assertEquals(calls.get(10_002), 2);
});

Deno.test('category_facets bounds unique in-flight upstream calls without blocking duplicate requests', async () => {
  resetCatalogCachesForTest();
  const release: Array<() => void> = [];
  let upstreamCalls = 0;
  const deps = {
    getApiToken: async () => 'catalog-test-token',
    fetch: async () => {
      upstreamCalls++;
      await new Promise<void>((resolve) => release.push(resolve));
      return Response.json({ data: { category: null, options: [] } });
    },
  };
  const requestFor = (categoryId: number) => handleRequest(post({ action: 'category_facets', categoryId }), deps);
  const admitted = Array.from({ length: 32 }, (_, index) => requestFor(20_001 + index));
  await new Promise((resolve) => setTimeout(resolve, 0));
  assertEquals(upstreamCalls, 32);
  const duplicate = requestFor(20_001);
  const overflow = await requestFor(20_033);
  assertEquals(overflow.status, 502);
  assert((await overflow.json()).error.includes('busy'), 'overflow fails without reaching catalog');
  assertEquals(upstreamCalls, 32);
  for (const resolve of release) resolve();
  const completed = await Promise.all([...admitted, duplicate]);
  assert(completed.every((response) => response.status === 200), 'admitted and duplicate requests complete');
  assertEquals(upstreamCalls, 32);
});

Deno.test('search-products off admission preserves search response without an admission RPC', async () => {
  let tokenCalls = 0;
  let catalogCalls = 0;
  let admissionCalls = 0;
  const response = await handleRequest(post({ query: 'кабель ВВГ', page: 1 }), {
    publicAdmissionReadEnv: () => 'off',
    publicAdmissionRpc: async () => {
      admissionCalls++;
      throw new Error('off mode must not call admission RPC');
    },
    getApiToken: async () => {
      tokenCalls++;
      return 'catalog-test-token';
    },
    fetch: async () => {
      catalogCalls++;
      return Response.json({ data: { results: [{ id: 5 }], pagination: { total: 1 } } });
    },
  });
  assertEquals(response.status, 200);
  assertEquals((await response.json()).results, [{ id: 5 }]);
  assertEquals({ admissionCalls, tokenCalls, catalogCalls }, { admissionCalls: 0, tokenCalls: 1, catalogCalls: 1 });
});

const enforceCatalogEnv = (name: string): string | undefined => ({
  PUBLIC_API_ADMISSION_MODE: 'enforce',
  PUBLIC_API_CATALOG_LIMIT_PER_MINUTE: '60',
  PUBLIC_API_CATALOG_LIMIT_IN_FLIGHT: '4',
} as Record<string, string>)[name];

Deno.test('search-products admission denies before reading catalog token or making catalog calls', async () => {
  let tokenCalls = 0;
  let catalogCalls = 0;
  let reserveCalls = 0;
  let releaseCalls = 0;
  const response = await handleRequest(post({ action: 'list_categories' }), {
    publicAdmissionReadEnv: enforceCatalogEnv,
    publicAdmissionRpc: async (name, args) => {
      if (name === 'release_public_api_admission') {
        releaseCalls++;
        return { data: true };
      }
      reserveCalls++;
      assertEquals(args.p_route, 'search-products');
      assertEquals(args.p_lanes, ['catalog']);
      return { data: {
        allowed: false, reason: 'limit_exceeded', mode: 'enforce', replayed: false,
        would_reject: true, retry_after_seconds: 5,
      } };
    },
    getApiToken: async () => {
      tokenCalls++;
      return 'catalog-test-token';
    },
    fetch: async () => {
      catalogCalls++;
      return Response.json({ data: { results: [] } });
    },
  });
  assertEquals(response.status, 429);
  assertEquals(response.headers.get('Retry-After'), '5');
  assertEquals((await response.json()).categories, []);
  assertEquals({ reserveCalls, releaseCalls, tokenCalls, catalogCalls }, {
    reserveCalls: 1, releaseCalls: 0, tokenCalls: 0, catalogCalls: 0,
  });
});

Deno.test('search-products rejects invalid requests before reserving admission', async () => {
  let reserveCalls = 0;
  let tokenCalls = 0;
  const response = await handleRequest(post({ action: 'search', page: 1001 }), {
    publicAdmissionReadEnv: enforceCatalogEnv,
    publicAdmissionRpc: async () => {
      reserveCalls++;
      throw new Error('invalid request must not reserve');
    },
    getApiToken: async () => {
      tokenCalls++;
      throw new Error('invalid request must not read catalog token');
    },
  });
  assertEquals(response.status, 400);
  assertEquals({ reserveCalls, tokenCalls }, { reserveCalls: 0, tokenCalls: 0 });
});

Deno.test('search-products releases admission after both successful and failed catalog calls', async () => {
  const events: string[] = [];
  let upstreamShouldFail = false;
  const deps = {
    publicAdmissionReadEnv: enforceCatalogEnv,
    publicAdmissionRpc: async (name: string, args: Record<string, string | number | null | string[]>) => {
      if (name === 'release_public_api_admission') {
        events.push('release');
        assert(typeof args.p_reservation_id === 'string', 'release uses server-owned reservation ID');
        return { data: true };
      }
      events.push('reserve');
      assertEquals(args.p_route, 'search-products');
      return { data: {
        allowed: true, reason: 'admitted', mode: 'enforce', replayed: false,
        would_reject: false, retry_after_seconds: null,
      } };
    },
    getApiToken: async () => {
      events.push('token');
      return 'catalog-test-token';
    },
    fetch: async () => {
      events.push('catalog');
      return upstreamShouldFail
        ? new Response('unavailable', { status: 503 })
        : Response.json({ data: { results: [{ id: 9 }] } });
    },
  };
  const successful = await handleRequest(post({ query: 'кабель' }), deps);
  assertEquals(successful.status, 200);
  assertEquals(events, ['reserve', 'token', 'catalog', 'release']);
  events.length = 0;
  upstreamShouldFail = true;
  const failed = await handleRequest(post({ query: 'кабель' }), deps);
  assertEquals(failed.status, 500);
  assertEquals(events, ['reserve', 'token', 'catalog', 'release']);
});

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

Deno.test('hung search aborts upstream before its reservation is released', async () => {
  const events: string[] = [];
  const aborted = deferred();
  const finishAbort = deferred();
  const pending = handleRequest(post({ action: 'search', query: 'кабель' }), {
    catalogDeadlineMs: 10,
    publicAdmissionReadEnv: enforceCatalogEnv,
    publicAdmissionRpc: async (name) => {
      events.push(name === 'release_public_api_admission' ? 'release' : 'reserve');
      return name === 'release_public_api_admission'
        ? { data: true }
        : { data: {
          allowed: true, reason: 'admitted', mode: 'enforce', replayed: false,
          would_reject: false, retry_after_seconds: null,
        } };
    },
    getApiToken: async () => 'catalog-test-token',
    fetch: async (_input, init) => {
      events.push('search-start');
      const signal = init?.signal;
      assert(signal, 'search must pass abort signal to upstream');
      return await new Promise<Response>((_resolve, reject) => {
        signal.addEventListener('abort', async () => {
          events.push('search-abort');
          aborted.resolve();
          await finishAbort.promise;
          events.push('search-settled');
          reject(abortReasonForTest(signal));
        }, { once: true });
      });
    },
  });
  await aborted.promise;
  assert(!events.includes('release'), 'reservation must stay held while abort is settling');
  finishAbort.resolve();
  const response = await pending;
  assertEquals(response.status, 504);
  const body = await response.json();
  assertEquals(body.error, 'Catalog request timed out');
  assertEquals(body.results, []);
  assertEquals(events, ['reserve', 'search-start', 'search-abort', 'search-settled', 'release']);
});

function abortReasonForTest(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException('Aborted', 'AbortError');
}

Deno.test('multi-page category deadline aborts and drains every active page before release', async () => {
  resetCatalogCachesForTest();
  const events: string[] = [];
  const bothAborted = deferred();
  const finishPage2 = deferred();
  const finishPage3 = deferred();
  const page2Settled = deferred();
  let abortedCount = 0;
  const pending = handleRequest(post({ action: 'list_categories' }), {
    catalogDeadlineMs: 20,
    publicAdmissionReadEnv: enforceCatalogEnv,
    publicAdmissionRpc: async (name) => {
      events.push(name === 'release_public_api_admission' ? 'release' : 'reserve');
      return name === 'release_public_api_admission'
        ? { data: true }
        : { data: {
          allowed: true, reason: 'admitted', mode: 'enforce', replayed: false,
          would_reject: false, retry_after_seconds: null,
        } };
    },
    getApiToken: async () => 'catalog-test-token',
    fetch: async (input, init) => {
      const page = Number(new URL(String(input)).searchParams.get('page'));
      events.push(`page-${page}-start`);
      const signal = init?.signal;
      assert(signal, `page ${page} must pass abort signal to upstream`);
      if (page === 1) {
        return Response.json({ data: {
          results: [{ pagetitle: 'First page only' }],
          pagination: { pages: 3 },
        } });
      }
      return await new Promise<Response>((_resolve, reject) => {
        signal.addEventListener('abort', async () => {
          events.push(`page-${page}-abort`);
          abortedCount++;
          if (abortedCount === 2) bothAborted.resolve();
          await (page === 2 ? finishPage2.promise : finishPage3.promise);
          events.push(`page-${page}-settled`);
          if (page === 2) page2Settled.resolve();
          reject(abortReasonForTest(signal));
        }, { once: true });
      });
    },
  });
  await bothAborted.promise;
  assert(!events.includes('release'), 'reservation must be held while both pages abort');
  finishPage2.resolve();
  await page2Settled.promise;
  assert(!events.includes('release'), 'one settled page must not release while sibling is active');
  finishPage3.resolve();
  const response = await pending;
  assertEquals(response.status, 504);
  const body = await response.json();
  assertEquals(body.error, 'Catalog request timed out');
  assertEquals(body.categories, []);
  assert(events.indexOf('release') > events.indexOf('page-2-settled'), 'release follows page 2 settlement');
  assert(events.indexOf('release') > events.indexOf('page-3-settled'), 'release follows page 3 settlement');
});

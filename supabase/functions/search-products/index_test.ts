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

Deno.test('search taxonomy retries one 502 before serving and caching verified complete names', async () => {
  resetCatalogCachesForTest();
  let calls = 0;
  const deps = {
    getApiToken: async () => 'catalog-test-token',
    fetch: async () => {
      calls++;
      if (calls === 1) return new Response('gateway unavailable', { status: 502 });
      return Response.json({ data: {
        results: [{ id: 1, pagetitle: 'Кабель', alias: 'kabel', parent: 0, children: [] }],
        pagination: { page: 1, per_page: 200, pages: 1, total: 1 },
      } });
    },
  };
  const first = await handleRequest(post({ action: 'list_categories' }), deps);
  assertEquals(first.status, 200);
  assertEquals((await first.json()).categories, ['Кабель']);
  assertEquals((await (await handleRequest(post({ action: 'list_categories' }), deps)).json()).categories, ['Кабель']);
  assertEquals(calls, 2);
});

Deno.test('search facets retry one 502 then cache only verified category options', async () => {
  resetCatalogCachesForTest();
  let calls = 0;
  const deps = {
    getApiToken: async () => 'catalog-test-token',
    fetch: async () => {
      calls++;
      if (calls === 1) return new Response('gateway unavailable', { status: 502 });
      return Response.json({ data: {
        category: { id: 742, total_products: 1 },
        options: [{ key: 'diameter', values: [{ value_ru: '10 мм' }] }],
      } });
    },
  };
  const first = await handleRequest(post({ action: 'category_facets', categoryId: 742 }), deps);
  assertEquals(first.status, 200);
  assertEquals((await first.json()).options[0].key, 'diameter');
  assertEquals((await (await handleRequest(post({ action: 'category_facets', categoryId: 742 }), deps)).json()).cacheHit, true);
  assertEquals(calls, 2);
});

Deno.test('search-products rejects unsupported methods before reading token or catalog', async () => {
  const upstream = forbiddenUpstream();
  const get = await handleRequest(new Request(endpoint), upstream.deps);
  assertEquals(get.status, 405);
  assertEquals(get.headers.get('Allow'), 'POST, OPTIONS');
  assertEquals(get.headers.get('Access-Control-Allow-Origin'), '*');
  const preflight = await handleRequest(new Request(endpoint, { method: 'OPTIONS' }), upstream.deps);
  assertEquals(preflight.status, 200);
  assertEquals(await preflight.text(), 'ok');
  assertEquals(preflight.headers.get('access-control-allow-headers')?.includes('x-volt-subject-proof'), false);
  const signedPreflight = await handleRequest(new Request(endpoint, {
    method: 'OPTIONS',
    headers: { 'Access-Control-Request-Headers': 'content-type, X-Volt-Subject-Proof' },
  }), upstream.deps);
  assertEquals(signedPreflight.headers.get('access-control-allow-headers')?.includes('x-volt-subject-proof'), true);
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
  resetCatalogCachesForTest();
  const urls: URL[] = [];
  const deps = {
    getApiToken: async () => 'catalog-test-token',
    fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      assert(init?.signal instanceof AbortSignal, `${url.pathname} must receive a cancellation signal`);
      urls.push(url);
      if (url.pathname.endsWith('/options')) {
        return Response.json({ data: { category: { id: 742, total_products: 1 }, options: [{ key: 'brand', values: [{ value_ru: 'IEK' }] }] } });
      }
      if (url.pathname.endsWith('/categories')) {
        return Response.json({ data: { results: [{ id: 1, pagetitle: 'Розетки', alias: 'rozetki', parent: 0, children: [] }], pagination: { page: 1, per_page: 200, pages: 1, total: 1 } } });
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
  assertEquals((await facets.json()).options, [{ key: 'brand', values: [{ value_ru: 'IEK' }] }]);

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
      return Response.json({ data: { results: [{ id: 1, pagetitle: 'Светильники', alias: 'svetilniki', parent: 0 }], pagination: { page: 1, per_page: 1, pages: 1_000_000, total: 1_000_000 } } });
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
      return Response.json({ data: { results: [{ id: page, pagetitle: `Категория ${page}`, alias: `category-${page}`, parent: 0, children: [] }], pagination: { page, per_page: 1, pages: 9, total: 9 } } });
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

Deno.test('list_categories never caches failed or malformed page 1/page N as a partial catalog', async () => {
  for (const failure of ['page1-http', 'page1-success-false', 'page1-malformed', 'page1-null-data', 'page1-missing-id', 'page1-missing-alias', 'page2-http', 'page2-success-false', 'page2-malformed', 'page2-invalid-parent']) {
    resetCatalogCachesForTest();
    let failedOnce = false;
    const calls: number[] = [];
    const deps = {
      getApiToken: async () => 'catalog-test-token',
      fetch: async (input: RequestInfo | URL) => {
        const page = Number(new URL(String(input)).searchParams.get('page'));
        calls.push(page);
        const failPage = failure.startsWith('page1') ? 1 : 2;
        if (!failedOnce && page === failPage) {
          failedOnce = true;
          if (failure.endsWith('http')) return new Response('unavailable', { status: 503 });
          if (failure.endsWith('success-false')) {
            return Response.json({ success: false, data: { results: [], pagination: { page, per_page: 1, pages: 2, total: 2 } } });
          }
          if (failure.endsWith('null-data')) {
            return Response.json({ success: true, data: null, results: [{ pagetitle: 'Ложная категория' }], pagination: { page, per_page: 1, pages: 2, total: 2 } });
          }
          if (failure.endsWith('missing-id') || failure.endsWith('missing-alias') || failure.endsWith('invalid-parent')) {
            return Response.json({ success: true, data: {
              results: [{ ...(failure.endsWith('missing-id') ? {} : { id: page }),
                pagetitle: `Категория ${page}`,
                ...(failure.endsWith('missing-alias') ? {} : { alias: `category-${page}` }),
                parent: failure.endsWith('invalid-parent') ? null : 0 }],
              pagination: { page, per_page: 1, pages: 2, total: 2 },
            } });
          }
          return Response.json({ success: true, data: { results: null, pagination: { page, per_page: 1, pages: 2, total: 2 } } });
        }
        return Response.json({ success: true, data: {
          results: [{ id: page, pagetitle: `Категория ${page}`, alias: `category-${page}`, parent: 0, children: [] }],
          pagination: { page, per_page: 1, pages: 2, total: 2 },
        } });
      },
    };
    const first = await handleRequest(post({ action: 'list_categories' }), deps);
    assertEquals(first.status, 500);
    assert((await first.json()).error, `${failure} must surface an error`);
    const recovered = await handleRequest(post({ action: 'list_categories' }), deps);
    assertEquals(recovered.status, 200);
    assertEquals((await recovered.json()).categories, ['Категория 1', 'Категория 2']);
    const beforeCacheHit = calls.length;
    const cached = await handleRequest(post({ action: 'list_categories' }), deps);
    assertEquals((await cached.json()).categories, ['Категория 1', 'Категория 2']);
    assertEquals(calls.length, beforeCacheHit);
  }
});

Deno.test('list_categories rejects nonempty truncated pages and pagination drift before caching', async () => {
  for (const failure of ['short-page1', 'short-page2', 'changed-total']) {
    resetCatalogCachesForTest();
    let failedOnce = false;
    let calls = 0;
    const deps = {
      getApiToken: async () => 'catalog-test-token',
      fetch: async (input: RequestInfo | URL) => {
        const page = Number(new URL(String(input)).searchParams.get('page'));
        calls++;
        const shouldFail = !failedOnce && (failure === 'short-page1' ? page === 1 : page === 2);
        if (shouldFail) failedOnce = true;
        const titles = page === 1 ? ['Категория 1', 'Категория 2'] : ['Категория 3', 'Категория 4'];
        return Response.json({ data: {
          results: (shouldFail && failure.startsWith('short') ? titles.slice(0, 1) : titles)
            .map((pagetitle, index) => ({ id: (page - 1) * 2 + index + 1,
              pagetitle, alias: `category-${(page - 1) * 2 + index + 1}`, parent: 0, children: [] })),
          pagination: {
            page,
            per_page: 2,
            pages: shouldFail && failure === 'changed-total' ? 3 : 2,
            total: shouldFail && failure === 'changed-total' ? 5 : 4,
          },
        } });
      },
    };
    const failed = await handleRequest(post({ action: 'list_categories' }), deps);
    assertEquals(failed.status, 500);
    const recovered = await handleRequest(post({ action: 'list_categories' }), deps);
    assertEquals(recovered.status, 200);
    assertEquals((await recovered.json()).categories, [
      'Категория 1', 'Категория 2', 'Категория 3', 'Категория 4',
    ]);
    const beforeHit = calls;
    assertEquals((await (await handleRequest(post({ action: 'list_categories' }), deps)).json()).count, 4);
    assertEquals(calls, beforeHit);
  }
});

Deno.test('list_categories retains visible names but never caches unproven children on any root page or leaf', async () => {
  for (const location of ['root-page1', 'root-page2', 'leaf']) {
    for (const absence of ['missing', 'null']) {
      resetCatalogCachesForTest();
      const calls: number[] = [];
      let incomplete = true;
      const deps = {
        getApiToken: async () => 'catalog-test-token',
        fetch: async (input: RequestInfo | URL) => {
          const page = Number(new URL(String(input)).searchParams.get('page'));
          calls.push(page);
          const leaf: Record<string, unknown> = { id: 3, pagetitle: 'Двойные розетки', alias: 'double', parent: 1, children: [] };
          const firstRoot: Record<string, unknown> = { id: 1, pagetitle: 'Розетки', alias: 'rozetki', parent: 0, children: [leaf] };
          const secondRoot: Record<string, unknown> = { id: 2, pagetitle: 'Кабель', alias: 'cable', parent: 0, children: [] };
          if (incomplete) {
            const target = location === 'root-page2' ? secondRoot : location === 'leaf' ? leaf : firstRoot;
            if (absence === 'missing') delete target.children;
            else target.children = null;
          }
          return Response.json({ data: {
            results: [page === 1 ? firstRoot : secondRoot],
            pagination: { page, per_page: 1, pages: 2, total: 2 },
          } });
        },
      };
      const visible = location === 'root-page1'
        ? ['Кабель', 'Розетки']
        : ['Двойные розетки', 'Кабель', 'Розетки'];
      for (let attempt = 0; attempt < 2; attempt++) {
        const response = await handleRequest(post({ action: 'list_categories' }), deps);
        assertEquals(response.status, 200);
        const listing = await response.json();
        assertEquals(listing.categories, visible);
        assertEquals(listing.count, visible.length);
        assertEquals(listing.coverage, 'visible_only');
        assertEquals(listing.count_is_complete, false);
      }
      assertEquals(calls, [1, 2, 1, 2]);
      incomplete = false;
      const recovered = await handleRequest(post({ action: 'list_categories' }), deps);
      const completeListing = await recovered.json();
      assertEquals(completeListing.categories, ['Двойные розетки', 'Кабель', 'Розетки']);
      assertEquals(completeListing.coverage, 'complete');
      assertEquals(completeListing.count_is_complete, true);
      const cached = await handleRequest(post({ action: 'list_categories' }), deps);
      const cachedListing = await cached.json();
      assertEquals(cachedListing.categories, ['Двойные розетки', 'Кабель', 'Розетки']);
      assertEquals(cachedListing.coverage, 'complete');
      assertEquals(cachedListing.count_is_complete, true);
      assertEquals(calls, [1, 2, 1, 2, 1, 2]);
    }
  }
});

Deno.test('list_categories rejects duplicate IDs across pages and descendants without poisoning cache', async () => {
  for (const duplicate of ['page', 'child']) {
    resetCatalogCachesForTest();
    const calls: number[] = [];
    let malformed = true;
    const deps = {
      getApiToken: async () => 'catalog-test-token',
      fetch: async (input: RequestInfo | URL) => {
        const page = Number(new URL(String(input)).searchParams.get('page'));
        calls.push(page);
        return Response.json({ data: {
          results: [page === 1
            ? { id: 1, pagetitle: 'Розетки', alias: 'rozetki', parent: 0,
              children: [{ id: malformed && duplicate === 'child' ? 1 : 3,
                pagetitle: 'Двойные розетки', alias: 'double', parent: 1, children: [] }] }
            : { id: malformed && duplicate === 'page' ? 1 : 2,
              pagetitle: 'Кабель', alias: 'cable', parent: 0, children: [] }],
          pagination: { page, per_page: 1, pages: 2, total: 2 },
        } });
      },
    };
    const rejected = await handleRequest(post({ action: 'list_categories' }), deps);
    assertEquals(rejected.status, 500);
    malformed = false;
    const recovered = await handleRequest(post({ action: 'list_categories' }), deps);
    assertEquals((await recovered.json()).categories, ['Двойные розетки', 'Кабель', 'Розетки']);
    const cached = await handleRequest(post({ action: 'list_categories' }), deps);
    assertEquals((await cached.json()).categories, ['Двойные розетки', 'Кабель', 'Розетки']);
    assertEquals(calls, duplicate === 'child' ? [1, 1, 2] : [1, 2, 1, 2]);
  }
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
      return Response.json({ data: { category: { id: categoryId, total_products: 0 }, options: [] } });
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

Deno.test('category_facets does not cache malformed HTTP 200 or success:false as empty facets', async () => {
  for (const malformed of [
    { success: false, data: { category: { id: 742, total_products: 1 }, options: [] } },
    { success: true, data: { category: null, options: [] } },
    { success: true, data: { category: { id: 742, total_products: 1 }, options: null } },
    { success: true, data: { category: { id: 742, total_products: 1 }, options: [{ key: 'brand' }] } },
    { success: true, data: { category: { id: 742, total_products: 10 }, options: [{ key: 'color', values: [] }] } },
    { success: true, data: { category: { id: 742, total_products: 10 }, options: [{ key: 'color', values: [] }, { key: 'brand', values: [] }] } },
    { success: true, data: { category: { id: 742, total_products: null }, options: [] } },
    { success: true, data: null, category: { id: 742, total_products: 1 }, options: [{ key: 'brand', values: [] }] },
    { success: true, data: { category: { id: 742, total_products: 1 }, options: [{ key: 'brand', values: [{ value_ru: { x: 1 } }] }] } },
    { success: true, data: { category: { id: 742, total_products: 1 }, options: [{ key: 'brand', values: [{ value_ru: 'IEK', value_kz: { x: 1 } }] }] } },
    { success: true, data: { category: { id: 742, total_products: 1 }, options: [
      { key: 'brand', values: [{ value_ru: 'IEK' }] },
      { key: 'size', values: [{ value_ru: { x: 1 } }] },
    ] } },
  ]) {
    resetCatalogCachesForTest();
    let calls = 0;
    const deps = {
      getApiToken: async () => 'catalog-test-token',
      fetch: async () => {
        calls++;
        return Response.json(calls === 1 ? malformed : {
          success: true,
          data: { category: { id: 742, total_products: 1 }, options: [{ key: 'brand', values: [{ value_ru: 'IEK' }] }] },
        });
      },
    };
    const first = await handleRequest(post({ action: 'category_facets', categoryId: 742 }), deps);
    assertEquals(first.status, 502);
    const recovered = await handleRequest(post({ action: 'category_facets', categoryId: 742 }), deps);
    assertEquals(recovered.status, 200);
    assertEquals((await recovered.json()).options, [{ key: 'brand', values: [{ value_ru: 'IEK' }] }]);
    const cached = await handleRequest(post({ action: 'category_facets', categoryId: 742 }), deps);
    assertEquals((await cached.json()).cacheHit, true);
    assertEquals(calls, 2);
  }
});

Deno.test('category_facets accepts numeric catalog option values and nullable translations', async () => {
  resetCatalogCachesForTest();
  let calls = 0;
  const deps = {
    getApiToken: async () => 'catalog-test-token',
    fetch: async () => {
      calls++;
      return Response.json({ success: true, data: {
        category: { id: 743, total_products: 1 },
        options: [{ key: 'rating', values: [{ value_ru: 16, value_kz: null, products_count: 1 }] }],
      } });
    },
  };
  const request = () => handleRequest(post({ action: 'category_facets', categoryId: 743 }), deps);
  const first = await request();
  assertEquals(first.status, 200);
  assertEquals((await first.json()).options[0].values[0].value_ru, 16);
  const cached = await request();
  assertEquals((await cached.json()).cacheHit, true);
  assertEquals(calls, 1);
});

Deno.test('category_facets by pagetitle rejects another category and retries instead of caching it', async () => {
  resetCatalogCachesForTest();
  let calls = 0;
  const deps = {
    getApiToken: async () => 'catalog-test-token',
    fetch: async () => {
      calls++;
      return Response.json({ success: true, data: {
        category: { id: calls === 1 ? 7 : 8, pagetitle: calls === 1 ? 'Розетки' : 'Кабель', total_products: 1 },
        options: [{ key: 'size', values: [{ value_ru: '10' }] }],
      } });
    },
  };
  const request = () => handleRequest(post({ action: 'category_facets', pagetitle: 'Кабель' }), deps);
  const first = await request();
  assertEquals(first.status, 502);
  const recovered = await request();
  assertEquals(recovered.status, 200);
  assertEquals((await recovered.json()).category.pagetitle, 'Кабель');
  const cached = await request();
  assertEquals((await cached.json()).cacheHit, true);
  assertEquals(calls, 2);
});

Deno.test('category_facets bounds unique in-flight upstream calls without blocking duplicate requests', async () => {
  resetCatalogCachesForTest();
  const release: Array<() => void> = [];
  let upstreamCalls = 0;
  const deps = {
    getApiToken: async () => 'catalog-test-token',
    fetch: async (input: RequestInfo | URL) => {
      upstreamCalls++;
      await new Promise<void>((resolve) => release.push(resolve));
      const categoryId = Number(new URL(String(input)).pathname.split('/').at(-2));
      return Response.json({ data: { category: { id: categoryId, total_products: 0 }, options: [] } });
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
          results: [{ id: 1, pagetitle: 'First page only', alias: 'first-page-only', parent: 0 }],
          pagination: { page: 1, per_page: 1, pages: 3, total: 3 },
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

const SUBJECT_PROOF_ENV = {
  PUBLIC_API_ADMISSION_MODE: 'off',
  PUBLIC_SUBJECT_PROOF_KID: 'test-key',
  PUBLIC_SUBJECT_PROOF_HMAC_KEY: btoa('a'.repeat(32)).replace(/=+$/u, ''),
  PUBLIC_SUBJECT_LIMIT_PER_MINUTE: '5',
  PUBLIC_SUBJECT_LIMIT_IN_FLIGHT: '2',
};

Deno.test('search-products subject enforcement blocks unsigned request before token/catalog access', async () => {
  const upstream = forbiddenUpstream();
  const response = await handleRequest(post({ action: 'search', query: 'кабель' }), {
    ...upstream.deps,
    publicAdmissionReadEnv: (name) => ({ ...SUBJECT_PROOF_ENV,
      PUBLIC_SUBJECT_ADMISSION_MODE: 'enforce' } as Record<string, string>)[name],
    publicAdmissionRpc: () => { throw new Error('global admission must not run'); },
    subjectAdmissionRpc: () => { throw new Error('subject admission must not run without proof'); },
  });
  assertEquals(response.status, 403);
  assert(Array.isArray((await response.json()).results), 'search error envelope remains intact');
  upstream.assertUnused();
});

Deno.test('search-products subject observation preserves an unsigned catalog response', async () => {
  let catalogCalls = 0;
  const observed: unknown[][] = [];
  const originalWarn = console.warn;
  const originalInfo = console.info;
  try {
    console.warn = (...args) => { observed.push(args); };
    console.info = (...args) => { observed.push(args); };
    const response = await handleRequest(post({ action: 'search', query: 'кабель' }), {
      publicAdmissionReadEnv: (name) => ({ ...SUBJECT_PROOF_ENV,
        PUBLIC_SUBJECT_ADMISSION_MODE: 'observe' } as Record<string, string>)[name],
      publicAdmissionRpc: () => { throw new Error('global admission is off'); },
      subjectAdmissionRpc: () => { throw new Error('unsigned observe must not reserve'); },
      getApiToken: async () => 'fixture-token',
      fetch: async () => {
        catalogCalls++;
        return Response.json({ data: { results: [{ id: 17 }], pagination: { total: 1 } } });
      },
    });
    assertEquals(response.status, 200);
    assertEquals((await response.json()).results, [{ id: 17 }]);
    assertEquals(catalogCalls, 1);
    assertEquals(observed.some(([label, data]) =>
      label === '[search-products] subject proof would reject' &&
      (data as { reason?: string }).reason === 'missing_proof'
    ), true);
  } finally {
    console.warn = originalWarn;
    console.info = originalInfo;
  }
});

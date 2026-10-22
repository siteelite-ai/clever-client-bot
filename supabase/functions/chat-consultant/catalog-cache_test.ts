import {
  buildCatalogUnavailableResponse,
  getCategoriesCache,
  getCategoryOptionsSchema,
  resetLegacyCatalogCachesForTest,
  shouldEmitCatalogUnavailableResponse,
} from './index.ts';

function assertEquals(actual: unknown, expected: unknown): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function categoryPage(page: number, total = 2, perPage = 1): Response {
  return Response.json({ success: true, data: {
    results: [{ id: page, pagetitle: `Категория ${page}`, alias: `category-${page}`, parent: 0, children: [] }],
    pagination: { page, per_page: perPage, pages: Math.ceil(total / perPage), total },
  } });
}

Deno.test('cold catalog outage renders an honest final reply, not an absence claim, in both wire formats', async () => {
  assertEquals(shouldEmitCatalogUnavailableResponse('catalog', 0, true), true);
  assertEquals(shouldEmitCatalogUnavailableResponse('brands', 0, true), true);
  assertEquals(shouldEmitCatalogUnavailableResponse('catalog', 1, true), false);
  assertEquals(shouldEmitCatalogUnavailableResponse('catalog', 0, false), false);
  assertEquals(shouldEmitCatalogUnavailableResponse('info', 0, true), false);
  for (const streaming of [false, true]) {
    const response = buildCatalogUnavailableResponse(streaming, { test: 'slot' });
    assertEquals(response.status, 200);
    const raw = streaming ? await response.text() : JSON.stringify(await response.json());
    if (!raw.includes('Каталог сейчас временно недоступен') || raw.includes('товаров нет') || raw.includes('не нашёл')) {
      throw new Error('Technical outage must not become an unverified absence claim');
    }
    if (!raw.includes('slot_update')) throw new Error('Slot updates must remain available');
    if (streaming && !raw.endsWith('data: [DONE]\n\n')) throw new Error('SSE response must terminate');
  }
});

Deno.test('legacy taxonomy retries a transient 502 once and caches only a verified full tree', async () => {
  resetLegacyCatalogCachesForTest();
  let calls = 0;
  const httpFetch = (async () => {
    calls++;
    if (calls === 1) return new Response('gateway unavailable', { status: 502 });
    return Response.json({ data: {
      results: [{ id: 1, pagetitle: 'Кабель', alias: 'kabel', parent: 0, children: [] }],
      pagination: { page: 1, per_page: 200, pages: 1, total: 1 },
    } });
  }) as typeof fetch;
  assertEquals(await getCategoriesCache('test-token', httpFetch), ['Кабель']);
  assertEquals(await getCategoriesCache('test-token', httpFetch), ['Кабель']);
  assertEquals(calls, 2);
});

Deno.test('legacy facets retry a transient 502 once without persisting degraded sampling', async () => {
  resetLegacyCatalogCachesForTest();
  let calls = 0;
  const httpFetch = (async (input: RequestInfo | URL) => {
    if (!new URL(String(input)).pathname.endsWith('/categories/options')) {
      throw new Error('no product sample needed after retry succeeds');
    }
    calls++;
    if (calls === 1) return new Response('gateway unavailable', { status: 502 });
    return Response.json({ data: {
      category: { pagetitle: 'Кабель', total_products: 1 },
      options: [{ key: 'diameter', values: [{ value_ru: '10 мм' }] }],
    } });
  }) as typeof fetch;
  assertEquals((await getCategoryOptionsSchema('Кабель', 'test-token', httpFetch)).confidence, 'full');
  assertEquals((await getCategoryOptionsSchema('Кабель', 'test-token', httpFetch)).cacheHit, true);
  assertEquals(calls, 2);
});

Deno.test('legacy category cache does not store page 1 or page N failures and retries cleanly', async () => {
  for (const failure of ['page1-http', 'page1-success-false', 'page1-malformed', 'page1-null-data', 'page1-missing-id', 'page1-missing-alias', 'page2-http', 'page2-success-false', 'page2-malformed', 'page2-invalid-parent']) {
    resetLegacyCatalogCachesForTest();
    let failedOnce = false;
    const calls: number[] = [];
    const httpFetch = (async (input: RequestInfo | URL) => {
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
      return categoryPage(page);
    }) as typeof fetch;
    assertEquals(await getCategoriesCache('test-token', httpFetch), []);
    assertEquals(await getCategoriesCache('test-token', httpFetch), ['Категория 1', 'Категория 2']);
    const beforeHit = calls.length;
    assertEquals(await getCategoriesCache('test-token', httpFetch), ['Категория 1', 'Категория 2']);
    assertEquals(calls.length, beforeHit);
  }
});

Deno.test('legacy category cache rejects truncated nonempty pages and changing totals', async () => {
  for (const failure of ['short-page1', 'short-page2', 'changed-total']) {
    resetLegacyCatalogCachesForTest();
    let failedOnce = false;
    let calls = 0;
    const httpFetch = (async (input: RequestInfo | URL) => {
      const page = Number(new URL(String(input)).searchParams.get('page'));
      calls++;
      const shouldFail = !failedOnce && (failure === 'short-page1' ? page === 1 : page === 2);
      if (shouldFail) failedOnce = true;
      const titles = page === 1 ? ['Категория 1', 'Категория 2'] : ['Категория 3', 'Категория 4'];
      return Response.json({ success: true, data: {
        results: (shouldFail && failure.startsWith('short') ? titles.slice(0, 1) : titles)
          .map((pagetitle, index) => ({ id: (page - 1) * 2 + index + 1,
            pagetitle, alias: `category-${(page - 1) * 2 + index + 1}`, parent: 0, children: [] })),
        pagination: {
          page, per_page: 2,
          pages: shouldFail && failure === 'changed-total' ? 3 : 2,
          total: shouldFail && failure === 'changed-total' ? 5 : 4,
        },
      } });
    }) as typeof fetch;
    assertEquals(await getCategoriesCache('test-token', httpFetch), []);
    assertEquals(await getCategoriesCache('test-token', httpFetch), [
      'Категория 1', 'Категория 2', 'Категория 3', 'Категория 4',
    ]);
    const beforeHit = calls;
    await getCategoriesCache('test-token', httpFetch);
    assertEquals(calls, beforeHit);
  }
});

Deno.test('legacy category cache uses visible names but does not cache unproven children across root pages', async () => {
  for (const location of ['root', 'leaf']) {
    for (const absence of ['missing', 'null']) {
      resetLegacyCatalogCachesForTest();
      const calls: number[] = [];
      const incompleteReasons: string[] = [];
      let incomplete = true;
      const httpFetch = (async (input: RequestInfo | URL) => {
        const page = Number(new URL(String(input)).searchParams.get('page'));
        calls.push(page);
        const leaf: Record<string, unknown> = { id: 3, pagetitle: 'Двойные розетки', alias: 'double', parent: 1, children: [] };
        const root: Record<string, unknown> = { id: 1, pagetitle: 'Розетки', alias: 'rozetki', parent: 0, children: [leaf] };
        if (incomplete) {
          const target = location === 'root' ? root : leaf;
          if (absence === 'missing') delete target.children;
          else target.children = null;
        }
        return Response.json({ data: {
          results: [page === 1 ? root : { id: 2, pagetitle: 'Кабель', alias: 'cable', parent: 0, children: [] }],
          pagination: { page, per_page: 1, pages: 2, total: 2 },
        } });
      }) as typeof fetch;
      const visible = location === 'root' ? ['Кабель', 'Розетки'] : ['Двойные розетки', 'Кабель', 'Розетки'];
      assertEquals(await getCategoriesCache('test-token', httpFetch, (reason) => incompleteReasons.push(reason)), visible);
      assertEquals(await getCategoriesCache('test-token', httpFetch, (reason) => incompleteReasons.push(reason)), visible);
      assertEquals(incompleteReasons, [
        'CategoriesCache:visible_only_child_coverage',
        'CategoriesCache:visible_only_child_coverage',
      ]);
      // Positive visible names may be searched, but empty downstream results
      // cannot be promoted to a verified catalog absence.
      assertEquals(shouldEmitCatalogUnavailableResponse('catalog', 0, incompleteReasons.length > 0), true);
      assertEquals(calls, [1, 2, 1, 2]);
      incomplete = false;
      assertEquals(await getCategoriesCache('test-token', httpFetch, (reason) => incompleteReasons.push(reason)), ['Двойные розетки', 'Кабель', 'Розетки']);
      assertEquals(await getCategoriesCache('test-token', httpFetch, (reason) => incompleteReasons.push(reason)), ['Двойные розетки', 'Кабель', 'Розетки']);
      assertEquals(incompleteReasons.length, 2);
      assertEquals(calls, [1, 2, 1, 2, 1, 2]);
    }
  }
});

Deno.test('legacy category cache rejects duplicate IDs across root pages or descendants', async () => {
  for (const duplicate of ['page', 'child']) {
    resetLegacyCatalogCachesForTest();
    const calls: number[] = [];
    let malformed = true;
    const httpFetch = (async (input: RequestInfo | URL) => {
      const page = Number(new URL(String(input)).searchParams.get('page'));
      calls.push(page);
      const child = { id: malformed && duplicate === 'child' ? 1 : 3,
        pagetitle: 'Двойные розетки', alias: 'double', parent: 1, children: [] };
      return Response.json({ data: {
        results: [page === 1
          ? { id: 1, pagetitle: 'Розетки', alias: 'rozetki', parent: 0, children: [child] }
          : { id: malformed && duplicate === 'page' ? 1 : 2,
            pagetitle: 'Кабель', alias: 'cable', parent: 0, children: [] }],
        pagination: { page, per_page: 1, pages: 2, total: 2 },
      } });
    }) as typeof fetch;
    assertEquals(await getCategoriesCache('test-token', httpFetch), []);
    malformed = false;
    assertEquals(await getCategoriesCache('test-token', httpFetch), ['Двойные розетки', 'Кабель', 'Розетки']);
    assertEquals(await getCategoriesCache('test-token', httpFetch), ['Двойные розетки', 'Кабель', 'Розетки']);
    assertEquals(calls, duplicate === 'child' ? [1, 1, 2] : [1, 2, 1, 2]);
  }
});

Deno.test('legacy facets primary malformed 200 and incomplete fallback do not poison cache', async () => {
  for (const failure of ['primary-success-false', 'primary-null-category', 'fallback-page1-malformed', 'fallback-page1-null-data', 'fallback-page2-http']) {
    resetLegacyCatalogCachesForTest();
    let firstAttempt = true;
    let primaryCalls = 0;
    const httpFetch = (async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith('/categories/options')) {
        primaryCalls++;
        if (!firstAttempt) return Response.json({ success: true, data: {
          category: { pagetitle: 'Кабель', total_products: 2 },
          options: [{ key: 'diameter', caption_ru: 'Диаметр', values: [{ value_ru: '10 мм' }] }],
        } });
        if (failure === 'primary-success-false') return Response.json({ success: false, data: null });
        if (failure === 'primary-null-category') return Response.json({ success: true, data: { category: null, options: [] } });
        return new Response('unavailable', { status: 503 });
      }
      const page = Number(url.searchParams.get('page'));
      if (failure === 'fallback-page1-malformed' && page === 1) {
        return Response.json({ success: false, data: { results: [], pagination: { pages: 1 } } });
      }
      if (failure === 'fallback-page1-null-data' && page === 1) {
        return Response.json({ success: true, data: null, results: [{ category: { pagetitle: 'Кабель' }, options: [] }] });
      }
      if (failure === 'fallback-page2-http' && page === 2) {
        return new Response('unavailable', { status: 503 });
      }
      return Response.json({ success: true, data: {
        results: [{ category: { pagetitle: 'Кабель' }, options: [{ key: 'diameter', caption_ru: 'Диаметр', value_ru: '10 мм' }] }],
        pagination: {
          page, per_page: failure === 'fallback-page2-http' ? 1 : 200,
          pages: failure === 'fallback-page2-http' ? 2 : 1,
          total: failure === 'fallback-page2-http' ? 2 : 1,
        },
      } });
    }) as typeof fetch;
    const first = await getCategoryOptionsSchema('Кабель', 'test-token', httpFetch);
    // A valid one-page product fallback remains available, but never masquerades
    // as a complete facets response. Broken product sampling is not cached.
    assertEquals(first.confidence, failure.startsWith('primary') ? 'partial' : 'empty');
    assertEquals(first.source, 'legacy-sampling');
    firstAttempt = false;
    const recovered = await getCategoryOptionsSchema('Кабель', 'test-token', httpFetch);
    if (failure.startsWith('primary')) {
      assertEquals(recovered.confidence, 'full');
      assertEquals(primaryCalls, 2); // useful partial fallback was not persisted
    } else {
      assertEquals(recovered.confidence, 'full');
      assertEquals(recovered.schema.get('diameter')?.values.has('10 мм'), true);
      assertEquals(primaryCalls, 2);
    }
  }
});

Deno.test('legacy facet fallback may answer partially but cannot cache a short nonempty page', async () => {
  resetLegacyCatalogCachesForTest();
  let primaryCalls = 0;
  const httpFetch = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith('/categories/options')) {
      primaryCalls++;
      if (primaryCalls === 1) return new Response('unavailable', { status: 503 });
      return Response.json({ success: true, data: {
        category: { pagetitle: 'Кабель', total_products: 3 },
        options: [{ key: 'diameter', caption_ru: 'Диаметр', values: [{ value_ru: '10 мм' }] }],
      } });
    }
    const page = Number(url.searchParams.get('page'));
    return Response.json({ success: true, data: {
      results: [{ category: { pagetitle: 'Кабель' }, options: [{ key: 'diameter', caption_ru: 'Диаметр', value_ru: '10 мм' }] }],
      pagination: { page, per_page: 2, pages: 2, total: 3 },
    } });
  }) as typeof fetch;
  const partial = await getCategoryOptionsSchema('Кабель', 'test-token', httpFetch);
  assertEquals(partial.confidence, 'partial');
  assertEquals(partial.cacheHit, false);
  const recovered = await getCategoryOptionsSchema('Кабель', 'test-token', httpFetch);
  assertEquals(recovered.confidence, 'full');
  assertEquals(primaryCalls, 2);
});

Deno.test('legacy facets reject wrong-category, null-total and nested failure without caching ignored-filter products', async () => {
  for (const malformed of [
    { success: true, data: { category: { pagetitle: 'Розетки', total_products: 1 }, options: [{ key: 'size', values: [{ value_ru: '10' }] }] } },
    { success: true, data: { category: { pagetitle: 'Кабель', total_products: null }, options: [{ key: 'size', values: [{ value_ru: '10' }] }] } },
    { success: true, data: { success: false, data: { category: { pagetitle: 'Кабель', total_products: 1 }, options: [{ key: 'size', values: [{ value_ru: '10' }] }] } } },
    { success: true, data: null, category: { pagetitle: 'Кабель', total_products: 1 }, options: [{ key: 'size', values: [{ value_ru: '10' }] }] },
    { success: true, data: { category: { pagetitle: 'Кабель', total_products: 1 }, options: [{ key: 'size', values: [{ value_ru: { x: 1 } }] }] } },
    { success: true, data: { category: { pagetitle: 'Кабель', total_products: 1 }, options: [{ key: 'size', values: [{ value_ru: '10', value_kz: { x: 1 } }] }] } },
  ]) {
    resetLegacyCatalogCachesForTest();
    let primaryCalls = 0;
    const httpFetch = (async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith('/categories/options')) {
        primaryCalls++;
        return Response.json(primaryCalls === 1 ? malformed : { success: true, data: {
          category: { pagetitle: 'Кабель', total_products: 1 },
          options: [{ key: 'size', values: [{ value_ru: '10' }] }],
        } });
      }
      // Simulates a 200 from /products which silently ignored category=Кабель.
      return Response.json({ success: true, data: {
        results: [{ category: { pagetitle: 'Розетки' }, options: [{ key: 'size', value_ru: '10' }] }],
        pagination: { page: 1, per_page: 200, pages: 1, total: 1 },
      } });
    }) as typeof fetch;
    const unavailable = await getCategoryOptionsSchema('Кабель', 'test-token', httpFetch);
    assertEquals(unavailable.confidence, 'empty');
    assertEquals(unavailable.cacheHit, false);
    const recovered = await getCategoryOptionsSchema('Кабель', 'test-token', httpFetch);
    assertEquals(recovered.confidence, 'full');
    assertEquals(recovered.source, 'facets-api');
    assertEquals(primaryCalls, 2);
    const cached = await getCategoryOptionsSchema('Кабель', 'test-token', httpFetch);
    assertEquals(cached.cacheHit, true);
    assertEquals(primaryCalls, 2);
  }
});

Deno.test('legacy full facets preserve numeric catalog values without object coercion', async () => {
  resetLegacyCatalogCachesForTest();
  let calls = 0;
  const httpFetch = (async () => {
    calls++;
    return Response.json({ success: true, data: {
      category: { pagetitle: 'Кабель', total_products: 1 },
      options: [{ key: 'diameter', caption_ru: 'Диаметр', values: [{ value_ru: 12, value_kz: null, products_count: 1 }] }],
    } });
  }) as typeof fetch;
  const first = await getCategoryOptionsSchema('Кабель', 'test-token', httpFetch);
  assertEquals(first.confidence, 'full');
  assertEquals(first.schema.get('diameter')?.values.has('12'), true);
  const cached = await getCategoryOptionsSchema('Кабель', 'test-token', httpFetch);
  assertEquals(cached.cacheHit, true);
  assertEquals(calls, 1);
});

Deno.test('legacy product fallback does not cache a mixed valid and malformed option sample', async () => {
  resetLegacyCatalogCachesForTest();
  let primaryCalls = 0;
  const httpFetch = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith('/categories/options')) {
      primaryCalls++;
      if (primaryCalls === 1) return new Response('unavailable', { status: 503 });
      return Response.json({ success: true, data: {
        category: { pagetitle: 'Кабель', total_products: 1 },
        options: [{ key: 'diameter', values: [{ value_ru: '10 мм' }] }],
      } });
    }
    return Response.json({ success: true, data: {
      results: [{ category: { pagetitle: 'Кабель' }, options: [
        { key: 'diameter', value_ru: '10 мм' },
        { key: 'diameter', value_ru: { malformed: true } },
      ] }],
      pagination: { page: 1, per_page: 200, pages: 1, total: 1 },
    } });
  }) as typeof fetch;
  const partial = await getCategoryOptionsSchema('Кабель', 'test-token', httpFetch);
  assertEquals(partial.confidence, 'partial');
  assertEquals(partial.cacheHit, false);
  const recovered = await getCategoryOptionsSchema('Кабель', 'test-token', httpFetch);
  assertEquals(recovered.confidence, 'full');
  assertEquals(primaryCalls, 2);
});

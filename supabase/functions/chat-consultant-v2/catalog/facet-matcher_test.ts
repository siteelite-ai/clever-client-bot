// chat-consultant-v2 / catalog/facet-matcher_test.ts
// Stage 6C tests. Все фикстуры — синтетические, ZERO real 220volt данных.

import { assertEquals, assert } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import {
  matchFacets,
  type FacetMatcherDeps,
} from './facet-matcher.ts';
import type {
  ApiClientDeps,
  CategoryOptionsResult,
  RawOption,
} from './api-client.ts';

// ─── Helpers ────────────────────────────────────────────────────────────────

function makeCacheStub() {
  const store = new Map<string, unknown>();
  let computeCalls = 0;
  const cacheGetOrCompute: FacetMatcherDeps['cacheGetOrCompute'] = async (
    ns,
    rawKey,
    _ttl,
    compute,
  ) => {
    const k = `${ns}::${rawKey}`;
    if (store.has(k)) {
      return { value: store.get(k) as never, cacheHit: true };
    }
    computeCalls++;
    const value = await compute();
    store.set(k, value);
    return { value, cacheHit: false };
  };
  return { cacheGetOrCompute, getCalls: () => computeCalls };
}

function stubApiClient(result: CategoryOptionsResult, fetchCounter: { n: number }): ApiClientDeps {
  // Подсовываем fetch, который не используется (cache stub перехватывает),
  // но api-client требует его наличия. На случай если cache miss → реальный
  // fetch будет вызван — мы возвращаем готовый JSON.
  const fakeFetch: typeof fetch = async (_url, _init) => {
    fetchCounter.n++;
    // Эмулируем double-wrapping (Q2): { data: { data: { options, category } } }
    const body = JSON.stringify({
      data: {
        data: {
          options: result.options,
          category: { total_products: result.totalProducts },
        },
      },
    });
    return new Response(body, { status: 200, headers: { 'content-type': 'application/json' } });
  };
  return {
    baseUrl: 'https://test.local/api',
    apiToken: 'test-token',
    fetch: fakeFetch,
  };
}

function makeOptions(options: RawOption[]): CategoryOptionsResult {
  return { status: 'ok', options, totalProducts: 100, ms: 1 };
}

// ─── Tests ──────────────────────────────────────────────────────────────────

Deno.test('Test 1: точный матч одного модификатора → один фильтр', async () => {
  const facets = makeOptions([
    {
      key: 'attr_a',
      caption: 'Attribute A',
      caption_ru: 'Атрибут А',
      values: [{ value_ru: 'Альфа' }, { value_ru: 'Бета' }],
    },
  ]);
  const fc = { n: 0 };
  const cache = makeCacheStub();
  const r = await matchFacets('test_cat', ['альфа'], {
    apiClient: stubApiClient(facets, fc),
    cacheGetOrCompute: cache.cacheGetOrCompute,
  });
  assertEquals(r.status, 'ok');
  assertEquals(r.optionFilters, { attr_a: ['Альфа'] });
  assertEquals(r.matchedModifiers, ['альфа']);
  assertEquals(r.unmatchedModifiers, []);
});

Deno.test('Test 2: два модификатора в разных опциях → два фильтра', async () => {
  const facets = makeOptions([
    { key: 'color', caption_ru: 'Цвет', values: [{ value_ru: 'Чёрный' }] },
    { key: 'size', caption_ru: 'Размер', values: [{ value_ru: 'Большой' }] },
  ]);
  const fc = { n: 0 };
  const cache = makeCacheStub();
  const r = await matchFacets('cat', ['чёрный', 'большой'], {
    apiClient: stubApiClient(facets, fc),
    cacheGetOrCompute: cache.cacheGetOrCompute,
  });
  assertEquals(r.status, 'ok');
  assertEquals(Object.keys(r.optionFilters).sort(), ['color', 'size']);
  assertEquals(r.matchedModifiers.sort(), ['большой', 'чёрный']);
});

Deno.test('Test 3: не-ASCII ключ → попадает в optionAliases', async () => {
  const facets = makeOptions([
    {
      key: 'cvet__tүs',  // не-ASCII (Q3)
      caption_ru: 'Цвет',
      values: [{ value_ru: 'Красный' }],
    },
  ]);
  const fc = { n: 0 };
  const cache = makeCacheStub();
  const r = await matchFacets('cat', ['красный'], {
    apiClient: stubApiClient(facets, fc),
    cacheGetOrCompute: cache.cacheGetOrCompute,
  });
  assertEquals(r.status, 'ok');
  // canonical = первый ASCII-only; здесь все не-ASCII → берём как есть.
  const canonical = Object.keys(r.optionFilters)[0];
  assertEquals(canonical, 'cvet__tүs');
  assertEquals(r.optionAliases[canonical], ['cvet__tүs']);
});

Deno.test('Test 4: alias collapse — 2 опции с одинаковым caption', async () => {
  const facets = makeOptions([
    { key: 'color_ascii', caption_ru: 'Цвет', values: [{ value_ru: 'Синий' }] },
    { key: 'cvet__tүs',   caption_ru: 'Цвет', values: [{ value_ru: 'Синий' }] },
  ]);
  const fc = { n: 0 };
  const cache = makeCacheStub();
  const r = await matchFacets('cat', ['синий'], {
    apiClient: stubApiClient(facets, fc),
    cacheGetOrCompute: cache.cacheGetOrCompute,
  });
  assertEquals(r.status, 'ok');
  // canonical = ASCII-only ключ.
  assertEquals(r.optionFilters, { color_ascii: ['Синий'] });
  // aliases содержат оба ключа, canonical первым.
  assertEquals(r.optionAliases.color_ascii, ['color_ascii', 'cvet__tүs']);
});

Deno.test('Test 5: модификатор без матча → unmatchedModifiers', async () => {
  const facets = makeOptions([
    { key: 'color', caption_ru: 'Цвет', values: [{ value_ru: 'Чёрный' }] },
  ]);
  const fc = { n: 0 };
  const cache = makeCacheStub();
  const r = await matchFacets('cat', ['чёрный', 'квадратный'], {
    apiClient: stubApiClient(facets, fc),
    cacheGetOrCompute: cache.cacheGetOrCompute,
  });
  assertEquals(r.status, 'ok');
  assertEquals(r.optionFilters, { color: ['Чёрный'] });
  assertEquals(r.matchedModifiers, ['чёрный']);
  assertEquals(r.unmatchedModifiers, ['квадратный']);
});

Deno.test('Test 6: cache hit → 2-й вызов не зовёт compute', async () => {
  const facets = makeOptions([
    { key: 'color', caption_ru: 'Цвет', values: [{ value_ru: 'Белый' }] },
  ]);
  const fc = { n: 0 };
  const cache = makeCacheStub();
  const deps: FacetMatcherDeps = {
    apiClient: stubApiClient(facets, fc),
    cacheGetOrCompute: cache.cacheGetOrCompute,
  };
  const r1 = await matchFacets('cat', ['белый'], deps);
  const r2 = await matchFacets('cat', ['белый'], deps);
  assertEquals(r1.source, 'live');
  assertEquals(r2.source, 'cache');
  assertEquals(cache.getCalls(), 1);  // compute вызван только 1 раз
});

Deno.test('Test 7: API status=empty → no_facets', async () => {
  const empty: CategoryOptionsResult = { status: 'empty', options: [], totalProducts: 0, ms: 1 };
  const fc = { n: 0 };
  const cache = makeCacheStub();
  const r = await matchFacets('cat', ['что-то'], {
    apiClient: stubApiClient(empty, fc),
    cacheGetOrCompute: cache.cacheGetOrCompute,
  });
  assertEquals(r.status, 'no_facets');
  assertEquals(r.optionFilters, {});
  assertEquals(r.unmatchedModifiers, ['что-то']);
});

Deno.test('Test 8: API status=timeout → category_unavailable', async () => {
  const timeout: CategoryOptionsResult = {
    status: 'timeout', options: [], totalProducts: 0, ms: 1, errorMessage: 'aborted',
  };
  const fc = { n: 0 };
  const cache = makeCacheStub();
  const r = await matchFacets('cat', ['что-то'], {
    apiClient: stubApiClient(timeout, fc),
    cacheGetOrCompute: cache.cacheGetOrCompute,
  });
  assertEquals(r.status, 'category_unavailable');
  assertEquals(r.source, 'unavailable');
  assertEquals(r.optionFilters, {});
});

Deno.test('Test 9: пустой modifiers[] → no_matches, всё пустое', async () => {
  const facets = makeOptions([
    { key: 'color', caption_ru: 'Цвет', values: [{ value_ru: 'Чёрный' }] },
  ]);
  const fc = { n: 0 };
  const cache = makeCacheStub();
  const r = await matchFacets('cat', [], {
    apiClient: stubApiClient(facets, fc),
    cacheGetOrCompute: cache.cacheGetOrCompute,
  });
  assertEquals(r.status, 'no_matches');
  assertEquals(r.optionFilters, {});
  assertEquals(r.matchedModifiers, []);
  assertEquals(r.unmatchedModifiers, []);
});

Deno.test('Test 10: facetCaptions из caption_ru, не из raw key', async () => {
  const facets = makeOptions([
    {
      key: 'attr_xyz_123',  // techy raw key
      caption_ru: 'Материал корпуса',
      values: [{ value_ru: 'Пластик' }],
    },
  ]);
  const fc = { n: 0 };
  const cache = makeCacheStub();
  const r = await matchFacets('cat', ['пластик'], {
    apiClient: stubApiClient(facets, fc),
    cacheGetOrCompute: cache.cacheGetOrCompute,
  });
  assertEquals(r.status, 'ok');
  assertEquals(r.facetCaptions.attr_xyz_123, 'Материал корпуса');
  // Caption — ровно UI-строка, без raw-key.
  assert(!r.facetCaptions.attr_xyz_123.includes('attr_'));
});

Deno.test('Test 11: KZ-локаль — match по value_kz', async () => {
  const facets = makeOptions([
    {
      key: 'color',
      caption_ru: 'Цвет',
      values: [{ value_ru: 'Чёрный', value_kz: 'Қара' }],
    },
  ]);
  const fc = { n: 0 };
  const cache = makeCacheStub();
  const r = await matchFacets('cat', ['қара'], {
    apiClient: stubApiClient(facets, fc),
    cacheGetOrCompute: cache.cacheGetOrCompute,
  });
  assertEquals(r.status, 'ok');
  // Возвращаем оригинальную форму value (RU), которую нашли первой в индексе.
  assertEquals(Object.keys(r.optionFilters), ['color']);
  assertEquals(r.optionFilters.color.length, 1);
});

Deno.test('Test 12: пунктуация в модификаторе нормализуется', async () => {
  const facets = makeOptions([
    { key: 'brand', caption_ru: 'Бренд', values: [{ value_ru: 'Acme Pro' }] },
  ]);
  const fc = { n: 0 };
  const cache = makeCacheStub();
  const r = await matchFacets('cat', ['  Acme  Pro!  '], {
    apiClient: stubApiClient(facets, fc),
    cacheGetOrCompute: cache.cacheGetOrCompute,
  });
  assertEquals(r.status, 'ok');
  assertEquals(r.optionFilters, { brand: ['Acme Pro'] });
});

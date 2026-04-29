// chat-consultant-v2 / catalog/facet-matcher-llm_test.ts
// §9.3 LLM Facet Matcher — все фикстуры синтетические, ZERO real 220volt.

import { assertEquals, assert } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import {
  matchFacetsWithLLM,
  type FacetMatcherLLMDeps,
} from './facet-matcher-llm.ts';
import type { ApiClientDeps, CategoryOptionsResult, RawOption } from './api-client.ts';

// ─── Helpers ────────────────────────────────────────────────────────────────

function makeCacheStub() {
  const store = new Map<string, unknown>();
  const cacheGetOrCompute: FacetMatcherLLMDeps['cacheGetOrCompute'] = async (ns, k, _ttl, compute) => {
    const key = `${ns}::${k}`;
    if (store.has(key)) return { value: store.get(key) as never, cacheHit: true };
    const v = await compute();
    store.set(key, v);
    return { value: v, cacheHit: false };
  };
  return cacheGetOrCompute;
}

function stubApiClient(result: CategoryOptionsResult): ApiClientDeps {
  return {
    baseUrl: 'https://test.local/api',
    apiToken: 't',
    fetch: async () => {
      if (result.status === 'timeout') {
        throw new DOMException('timed out', 'AbortError');
      }
      if (result.status === 'network_error' || result.status === 'upstream_unavailable') {
        throw new TypeError('network down');
      }
      if (result.status === 'http_error') {
        return new Response('upstream error', { status: 500 });
      }
      const body = JSON.stringify({
        data: {
          data: {
            options: result.options,
            category: { total_products: result.totalProducts },
          },
        },
      });
      return new Response(body, { status: 200, headers: { 'content-type': 'application/json' } });
    },
  };
}

function makeOptions(opts: RawOption[]): CategoryOptionsResult {
  return { status: 'ok', options: opts, totalProducts: 100, ms: 1 };
}

function stubLLM(reply: string | (() => string), opts: { fail?: boolean } = {}) {
  return (async () => {
    if (opts.fail) throw new Error('llm down');
    const text = typeof reply === 'function' ? reply() : reply;
    return { text, model: 'test-model' };
  });
}

function deps(opts: {
  api: CategoryOptionsResult;
  llmReply?: string;
  llmFail?: boolean;
}): FacetMatcherLLMDeps {
  return {
    apiClient: stubApiClient(opts.api),
    cacheGetOrCompute: makeCacheStub(),
    callLLM: stubLLM(opts.llmReply ?? '{"items":[]}', { fail: opts.llmFail }) as never,
  };
}

// ─── Tests ──────────────────────────────────────────────────────────────────

Deno.test('LLM-1: resolved → optionFilters заполнен', async () => {
  const facets = makeOptions([
    { key: 'color', caption_ru: 'Цвет', values: [{ value_ru: 'Чёрный' }, { value_ru: 'Белый' }] },
  ]);
  const llm = JSON.stringify({
    items: [{ trait: 'черный', classification: 'resolved', facet_key: 'color', value: 'Чёрный', confidence: 0.95 }],
  });
  const r = await matchFacetsWithLLM(
    { pagetitle: 'cat', traits: ['черный'], user_query_raw: 'черный' },
    deps({ api: facets, llmReply: llm }),
  );
  assertEquals(r.mode, 'ok');
  assertEquals(r.resolved.length, 1);
  assertEquals(r.optionFilters, { color: ['Чёрный'] });
  assertEquals(r.unresolved, []);
});

Deno.test('LLM-2: soft_match → попадает в optionFilters И в soft_matches', async () => {
  const facets = makeOptions([
    { key: 'count', caption_ru: 'Количество', values: [{ value_ru: '2' }, { value_ru: '3' }] },
  ]);
  const llm = JSON.stringify({
    items: [{ trait: 'двухгнёздная', classification: 'soft_match', facet_key: 'count', value: '2', confidence: 0.78, reason: 'numeric_equivalent' }],
  });
  const r = await matchFacetsWithLLM(
    { pagetitle: 'cat', traits: ['двухгнёздная'], user_query_raw: 'двухгнёздная' },
    deps({ api: facets, llmReply: llm }),
  );
  assertEquals(r.mode, 'ok');
  assertEquals(r.soft_matches.length, 1);
  assertEquals(r.soft_matches[0].reason, 'numeric_equivalent');
  assertEquals(r.optionFilters, { count: ['2'] });
});

Deno.test('LLM-3: unresolved с nearest_facet_key → available_values заполнены', async () => {
  const facets = makeOptions([
    { key: 'color', caption_ru: 'Цвет', values: [{ value_ru: 'Чёрный' }, { value_ru: 'Серый' }, { value_ru: 'Белый' }] },
  ]);
  const llm = JSON.stringify({
    items: [{ trait: 'графитовый', classification: 'unresolved', facet_key: 'color', value: null, confidence: 0 }],
  });
  const r = await matchFacetsWithLLM(
    { pagetitle: 'cat', traits: ['графитовый'], user_query_raw: 'графитовый' },
    deps({ api: facets, llmReply: llm }),
  );
  assertEquals(r.mode, 'ok');
  assertEquals(r.unresolved.length, 1);
  assertEquals(r.unresolved[0].nearest_facet_key, 'color');
  assertEquals(r.unresolved[0].nearest_facet_caption, 'Цвет');
  assert((r.unresolved[0].available_values ?? []).includes('Чёрный'));
  assertEquals(r.optionFilters, {});
});

Deno.test('LLM-4: unresolved без facet_key → трейт вне схемы', async () => {
  const facets = makeOptions([
    { key: 'color', caption_ru: 'Цвет', values: [{ value_ru: 'Чёрный' }] },
  ]);
  const llm = JSON.stringify({
    items: [{ trait: 'смешной', classification: 'unresolved', facet_key: null, value: null, confidence: 0 }],
  });
  const r = await matchFacetsWithLLM(
    { pagetitle: 'cat', traits: ['смешной'], user_query_raw: 'смешной' },
    deps({ api: facets, llmReply: llm }),
  );
  assertEquals(r.mode, 'ok');
  assertEquals(r.unresolved.length, 1);
  assertEquals(r.unresolved[0].nearest_facet_key, undefined);
});

Deno.test('LLM-5: галлюцинация значения → отбрасывается в unresolved', async () => {
  // LLM вернул value, которого НЕТ в schema.values[] — должно стать unresolved.
  const facets = makeOptions([
    { key: 'color', caption_ru: 'Цвет', values: [{ value_ru: 'Чёрный' }] },
  ]);
  const llm = JSON.stringify({
    items: [{ trait: 'красный', classification: 'resolved', facet_key: 'color', value: 'Красный', confidence: 0.95 }],
  });
  const r = await matchFacetsWithLLM(
    { pagetitle: 'cat', traits: ['красный'], user_query_raw: 'красный' },
    deps({ api: facets, llmReply: llm }),
  );
  assertEquals(r.mode, 'ok');
  assertEquals(r.resolved.length, 0);
  assertEquals(r.unresolved.length, 1);
  assertEquals(r.unresolved[0].nearest_facet_key, 'color');
});

Deno.test('LLM-6: LLM упал → mode=llm_failed, все трейты unresolved', async () => {
  const facets = makeOptions([
    { key: 'color', caption_ru: 'Цвет', values: [{ value_ru: 'Чёрный' }] },
  ]);
  const r = await matchFacetsWithLLM(
    { pagetitle: 'cat', traits: ['черный'], user_query_raw: 'черный' },
    deps({ api: facets, llmFail: true }),
  );
  assertEquals(r.mode, 'llm_failed');
  assertEquals(r.unresolved.length, 1);
  assertEquals(r.optionFilters, {});
  assert((r.llmError ?? '').length > 0);
});

Deno.test('LLM-7: parse error → mode=llm_failed', async () => {
  const facets = makeOptions([
    { key: 'color', caption_ru: 'Цвет', values: [{ value_ru: 'Чёрный' }] },
  ]);
  const r = await matchFacetsWithLLM(
    { pagetitle: 'cat', traits: ['черный'], user_query_raw: 'черный' },
    deps({ api: facets, llmReply: 'not a json at all' }),
  );
  assertEquals(r.mode, 'llm_failed');
});

Deno.test('LLM-8: пустой traits → mode=no_traits, нулевые поля', async () => {
  const facets = makeOptions([
    { key: 'color', caption_ru: 'Цвет', values: [{ value_ru: 'Чёрный' }] },
  ]);
  const r = await matchFacetsWithLLM(
    { pagetitle: 'cat', traits: [], user_query_raw: '' },
    deps({ api: facets }),
  );
  assertEquals(r.mode, 'no_traits');
  assertEquals(r.resolved, []);
  assertEquals(r.unresolved, []);
});

Deno.test('LLM-9: schema empty → mode=no_facets, все трейты unresolved', async () => {
  const facets: CategoryOptionsResult = { status: 'empty', options: [], totalProducts: 0, ms: 1 };
  const r = await matchFacetsWithLLM(
    { pagetitle: 'cat', traits: ['черный'], user_query_raw: 'черный' },
    deps({ api: facets }),
  );
  assertEquals(r.mode, 'no_facets');
  assertEquals(r.unresolved.length, 1);
});

Deno.test('LLM-10: alias collapse — ASCII canonical key выигрывает', async () => {
  const facets = makeOptions([
    { key: 'color', caption_ru: 'Цвет', values: [{ value_ru: 'Синий' }] },
    { key: 'cvet__tүs', caption_ru: 'Цвет', values: [{ value_ru: 'Синий' }] },
  ]);
  const llm = JSON.stringify({
    items: [{ trait: 'синий', classification: 'resolved', facet_key: 'color', value: 'Синий', confidence: 0.9 }],
  });
  const r = await matchFacetsWithLLM(
    { pagetitle: 'cat', traits: ['синий'], user_query_raw: 'синий' },
    deps({ api: facets, llmReply: llm }),
  );
  assertEquals(r.mode, 'ok');
  assertEquals(r.optionFilters, { color: ['Синий'] });
  // alias-keys для совместимости с searchProducts.optionAliases
  assertEquals(r.optionAliases.color, ['color', 'cvet__tүs']);
});

Deno.test('LLM-11: markdown-обёртка ```json``` парсится', async () => {
  const facets = makeOptions([
    { key: 'color', caption_ru: 'Цвет', values: [{ value_ru: 'Чёрный' }] },
  ]);
  const llm = '```json\n' + JSON.stringify({
    items: [{ trait: 'черный', classification: 'resolved', facet_key: 'color', value: 'Чёрный', confidence: 0.95 }],
  }) + '\n```';
  const r = await matchFacetsWithLLM(
    { pagetitle: 'cat', traits: ['черный'], user_query_raw: 'черный' },
    deps({ api: facets, llmReply: llm }),
  );
  assertEquals(r.mode, 'ok');
  assertEquals(r.resolved.length, 1);
});

Deno.test('LLM-12: трейт пропущен LLM → попадает в unresolved', async () => {
  const facets = makeOptions([
    { key: 'color', caption_ru: 'Цвет', values: [{ value_ru: 'Чёрный' }] },
  ]);
  // LLM ответил только про один трейт из двух
  const llm = JSON.stringify({
    items: [{ trait: 'черный', classification: 'resolved', facet_key: 'color', value: 'Чёрный', confidence: 0.95 }],
  });
  const r = await matchFacetsWithLLM(
    { pagetitle: 'cat', traits: ['черный', 'забытый'], user_query_raw: 'черный забытый' },
    deps({ api: facets, llmReply: llm }),
  );
  assertEquals(r.mode, 'ok');
  assertEquals(r.resolved.length, 1);
  assertEquals(r.unresolved.length, 1);
  assertEquals(r.unresolved[0].trait, 'забытый');
});

Deno.test('LLM-13: transport-failure /categories/options → использует bootstrap schema', async () => {
  const apiDown: CategoryOptionsResult = { status: 'timeout', options: [], totalProducts: 0, ms: 1 };
  const bootstrap: RawOption[] = [
    { key: 'color', caption_ru: 'Цвет', values: [{ value_ru: 'Белый' }, { value_ru: 'Чёрный' }] },
    { key: 'count', caption_ru: 'Количество разъемов', values: [{ value_ru: '2' }, { value_ru: '3' }] },
  ];
  const llm = JSON.stringify({
    items: [
      { trait: 'белые', classification: 'soft_match', facet_key: 'color', value: 'Белый', confidence: 0.8, reason: 'morphology' },
      { trait: '2 места', classification: 'soft_match', facet_key: 'count', value: '2', confidence: 0.8, reason: 'numeric_equivalent' },
    ],
  });
  const r = await matchFacetsWithLLM(
    { pagetitle: 'cat', traits: ['белые', '2 места'], user_query_raw: 'белые 2 места', bootstrapOptions: bootstrap },
    deps({ api: apiDown, llmReply: llm }),
  );
  assertEquals(r.mode, 'ok');
  assertEquals(r.source, 'bootstrap');
  assertEquals(r.optionFilters, { color: ['Белый'], count: ['2'] });
  assertEquals(r.unresolved, []);
});

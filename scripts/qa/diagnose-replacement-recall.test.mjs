import assert from 'node:assert/strict';
import { test } from 'node:test';
import { diagnose, projectRawProduct } from './diagnose-replacement-recall.mjs';

const specs = [
  ['kind', 'Вид светильника', 'даунлайт'],
  ['mount', 'Способ монтажа', 'встраиваемый'],
  ['technology', 'Тип лампы', 'LED'],
  ['lightColor', 'Цвет свечения', 'нейтральный'],
  ['colorTemperature', 'Цветовая температура, К', '4000'],
  ['socket', 'Тип цоколя', 'нет'],
  ['driver', 'ПРА', 'в комплекте'],
  ['diameter', 'Диаметр, см', '9'],
  ['power', 'Мощность ламп, Вт', '7'],
  ['flux', 'Световой поток, Лм', '600'],
  ['voltage', 'Напряжение, В', '220'],
  ['ip', 'Степень защиты, IP', '20'],
];
const facets = specs.map(([key, caption, value]) => ({
  key, caption_ru: caption, type: 'string', unit: null,
  values: [{ value_ru: value },
    ...key === 'lightColor' ? [{ value_ru: 'холодный' }] : [],
    ...key === 'mount' ? [{ value_ru: 'накладной' }] : []],
}));

function product(id, override = {}) {
  return {
    id, article: id === 'source' ? '1234567890' : `article-${id}`,
    pagetitle: id === 'source' ? 'Светильник 1234567890' : `Кандидат ${id}`,
    url: `https://220volt.kz/catalog/svetotexnika/svetilniki/${id}/`,
    price: 1500,
    category: 'Светильники',
    warehouses: [{ city: 'Караганда', amount: 2 }],
    options: specs.map(([key, caption, value]) => ({ key, caption_ru: caption,
      value_ru: override[key] ?? value })).concat([
      { key: 'cutout', caption_ru: 'Монтажное отверстие, мм', value_ru: '90' },
    ]),
  };
}

function response(body) {
  return new Response(JSON.stringify(body), {
    status: 200, headers: { 'Content-Type': 'application/json' },
  });
}

test('public bounded diagnostic compares local strict/reduced gates and reports mount/cutout evidence', async () => {
  const calls = [];
  const products = [product('source'), product('good'), product('cold', { lightColor: 'холодный' }),
    product('surface', { mount: 'накладной' })];
  const fakeFetch = async (url, init) => {
    assert.match(url, /^https:\/\/fixture\.supabase\.co\/functions\/v1\/search-products$/u);
    assert.equal(init.method, 'POST');
    assert.equal(init.redirect, 'error');
    const body = JSON.parse(init.body);
    calls.push(body);
    if (body.article) return response({ results: [products[0]], pagination: { total: 1 } });
    if (body.action === 'category_facets') return response({ category: { pagetitle: 'Светильники' }, options: facets });
    return response({ results: products, pagination: { total: products.length } });
  };
  const result = await diagnose({
    sourceArticle: '1234567890', category: 'Светильники', mode: 'public',
  }, {
    VITE_SUPABASE_URL: 'https://fixture.supabase.co',
    VITE_SUPABASE_PUBLISHABLE_KEY: 'public-fixture',
  }, fakeFetch);
  assert.equal(result.calls, 3);
  assert.equal(calls[2].category, 'Светильники');
  assert.equal(calls[2].perPage, 50);
  assert.equal(result.strict_by_filter, null);
  assert.equal(result.broader_same_leaf.window.counts.strict_query_match, 2);
  assert.equal(result.broader_same_leaf.window.counts.reduced_query_match, 3);
  assert.equal(result.broader_same_leaf.window.counts.structurally_verified, 1);
  assert.equal(result.broader_same_leaf.window.first_rejection_counts['candidate_mismatch:lightColor'], 1);
  assert.equal(result.broader_same_leaf.window.all_axis_rejection_counts_nonexclusive['candidate_mismatch:mount'], 1);
  assert.deepEqual(result.source.cutout, [{ caption: 'Монтажное отверстие, мм', value: '90' }]);
  assert.deepEqual(result.broader_same_leaf.window.examples[1].cutout,
    [{ caption: 'Монтажное отверстие, мм', value: '90' }]);
});

test('direct diagnostic sends exact by_filter and reduced optional facets, never a model request', async () => {
  const requests = [];
  const fakeFetch = async (url, init) => {
    assert.equal(init.method, 'GET');
    assert.equal(init.redirect, 'error');
    assert.equal(init.headers.Authorization, 'Bearer fixture-token');
    const parsed = new URL(url);
    requests.push(parsed);
    if (parsed.pathname.endsWith('/categories/options')) {
      return response({ data: { category: { pagetitle: 'Светильники' }, options: facets } });
    }
    if (parsed.searchParams.has('article')) {
      return response({ data: { results: [product('source')], pagination: { total: 1 } } });
    }
    return response({ data: { results: [product('source'), product('good')], pagination: { total: 23 } } });
  };
  const result = await diagnose({ sourceArticle: '1234567890', category: 'Светильники', mode: 'direct' },
    { VOLT220_API_TOKEN: 'fixture-token' }, fakeFetch);
  assert.equal(result.calls, 4);
  assert.equal(result.strict_by_filter.reported_total, 23);
  assert.deepEqual(requests.map(({ pathname }) => pathname), [
    '/api/products', '/api/categories/options', '/api/products', '/api/products',
  ]);
  assert.equal(requests[2].searchParams.get('options[lightColor][]'), 'нейтральный');
  assert.equal(requests[3].searchParams.has('options[lightColor][]'), false);
  assert.equal(requests[3].searchParams.get('options[mount][]'), 'встраиваемый');
});

test('restricted products are excluded before profiling or logging', () => {
  const restricted = product('restricted');
  restricted.options.push({ key: 'ogranichennyy_prosmotr', caption_ru: 'Ограниченный просмотр', value_ru: 'Да' });
  assert.equal(projectRawProduct(restricted, 'Светильники'), null);
});

test('all-pages scan stays sequential and certifies completeness only after every page', async () => {
  const calls = [];
  const fakeFetch = async (_url, init) => {
    const body = JSON.parse(init.body);
    calls.push(body);
    if (body.article) return response({ results: [product('source')], pagination: { total: 1 } });
    if (body.action === 'category_facets') return response({ options: facets });
    const page = body.page ?? 1;
    const results = page === 1
      ? Array.from({ length: 50 }, (_, index) => product(`p${index}`))
      : [product('last')];
    return response({ results, pagination: { total: 51 } });
  };
  const result = await diagnose({
    sourceArticle: '1234567890', category: 'Светильники', mode: 'public', allPages: true,
  }, { VITE_SUPABASE_URL: 'https://fixture.supabase.co' }, fakeFetch);
  assert.equal(result.calls, 4);
  assert.deepEqual(calls.slice(2).map(({ page }) => page), [1, 2]);
  assert.equal(result.broader_same_leaf.complete_category_scan, true);
  assert.equal(result.broader_same_leaf.window.counts.structurally_verified, 51);
  assert.equal(result.broader_same_leaf.window.all_structurally_verified_candidates.length, 51);
});

test('all-pages scan refuses to claim complete coverage beyond its page cap', async () => {
  const calls = [];
  const fakeFetch = async (_url, init) => {
    const body = JSON.parse(init.body);
    calls.push(body);
    if (body.article) return response({ results: [product('source')], pagination: { total: 1 } });
    if (body.action === 'category_facets') return response({ options: facets });
    return response({ results: [product('first')], pagination: { total: 1251 } });
  };
  const result = await diagnose({
    sourceArticle: '1234567890', category: 'Светильники', mode: 'public', allPages: true,
  }, { VITE_SUPABASE_URL: 'https://fixture.supabase.co' }, fakeFetch);
  assert.equal(calls.length, 3);
  assert.equal(result.broader_same_leaf.complete_category_scan, false);
  assert.equal(result.broader_same_leaf.incomplete_reason, 'page_cap:26>25');
});

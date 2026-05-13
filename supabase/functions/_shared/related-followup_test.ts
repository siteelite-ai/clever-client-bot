import { assertEquals, assert } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import {
  buildAnchorFilters,
  fetchWithRelaxation,
  RELATED_MIN_POOL,
  RELATED_PER_PAGE,
  type RelatedAnchor,
  type RelatedQueryParams,
  type RelatedProduct,
} from './related-followup.ts';

const anchor = (over: Partial<RelatedAnchor> = {}): RelatedAnchor => ({
  id: 1, pagetitle: 'A', price: 1000,
  options: [{ key: 'vendor', value_ru: 'IEK' }, { key: 'color', value_ru: 'белый' }],
  ...over,
});

Deno.test('buildAnchorFilters: median price ±50%', () => {
  const f = buildAnchorFilters([anchor({ price: 1000 }), anchor({ id: 2, price: 2000 })]);
  // median = 1500 → 750..2250
  assertEquals(f.minPrice, 750);
  assertEquals(f.maxPrice, 2250);
});

Deno.test('buildAnchorFilters: option intersection only when ALL match', () => {
  const f = buildAnchorFilters([
    anchor({ options: [{ key: 'vendor', value_ru: 'IEK' }, { key: 'color', value_ru: 'белый' }] }),
    anchor({ id: 2, options: [{ key: 'vendor', value_ru: 'IEK' }, { key: 'color', value_ru: 'чёрный' }] }),
  ]);
  assertEquals(f.options, { vendor: ['IEK'] });
});

Deno.test('buildAnchorFilters: missing value on any anchor → key skipped', () => {
  const f = buildAnchorFilters([
    anchor({ options: [{ key: 'vendor', value_ru: 'IEK' }] }),
    anchor({ id: 2, options: [] }),
  ]);
  assertEquals(f.options, undefined);
});

Deno.test('buildAnchorFilters: missing price on any anchor → no band', () => {
  const f = buildAnchorFilters([anchor({ price: 1000 }), anchor({ id: 2, price: undefined })]);
  assertEquals(f.minPrice, undefined);
  assertEquals(f.maxPrice, undefined);
});

function makeFetch(responses: RelatedProduct[][]) {
  let i = 0;
  const calls: RelatedQueryParams[] = [];
  return {
    calls,
    fetch: (_id: number, params?: RelatedQueryParams) => {
      calls.push(params || {});
      const data = responses[Math.min(i, responses.length - 1)] ?? [];
      i++;
      return Promise.resolve(new Response(JSON.stringify({ results: data, pagination: { total: data.length } })));
    },
  };
}

Deno.test('fetchWithRelaxation: stops on first attempt when pool >= MIN_POOL', async () => {
  const big = Array.from({ length: RELATED_MIN_POOL + 5 }, (_, i) => ({ id: i + 100, price: 500, category: { id: 9 } }));
  const m = makeFetch([big]);
  const r = await fetchWithRelaxation([anchor()], {}, { fetchRelatedRaw: m.fetch });
  assertEquals(r.attempt, 1);
  assert(r.merged.length >= RELATED_MIN_POOL);
  assertEquals(m.calls.length, 1);
  assertEquals(m.calls[0].perPage, RELATED_PER_PAGE);
  assertEquals(m.calls[0].options, { vendor: ['IEK'], color: ['белый'] });
});

Deno.test('fetchWithRelaxation: relaxes vendor → color → price', async () => {
  // Все попытки пустые — должны дойти до bare (без фильтров)
  const m = makeFetch([[], [], [], []]);
  const r = await fetchWithRelaxation([anchor()], {}, { fetchRelatedRaw: m.fetch });
  // sequence: full → drop vendor → drop color → drop price → bare(=4-я identical to 4 — будет 4)
  assert(m.calls.length >= 3);
  // первая — полные фильтры
  assertEquals(m.calls[0].options, { vendor: ['IEK'], color: ['белый'] });
  // вторая — без vendor
  assertEquals(m.calls[1].options, { color: ['белый'] });
  // третья — без color
  assertEquals(m.calls[2].options, undefined);
  // четвёртая — без price
  const last = m.calls[m.calls.length - 1];
  assertEquals(last.minPrice, undefined);
  assertEquals(last.maxPrice, undefined);
  assertEquals(r.merged.length, 0);
});

Deno.test('fetchWithRelaxation: no anchor filters → single attempt', async () => {
  const m = makeFetch([[]]);
  const bare = anchor({ price: undefined, options: [] });
  const r = await fetchWithRelaxation([bare], {}, { fetchRelatedRaw: m.fetch });
  assertEquals(m.calls.length, 1);
  assertEquals(m.calls[0].options, undefined);
  assertEquals(m.calls[0].minPrice, undefined);
  assertEquals(r.attempt, 1);
});

import { assertEquals, assertStringIncludes, assertFalse } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import { buildDeterministicShortCircuitContent, formatProductCardDeterministic, extractFacetsFromProducts, buildPriceFacetClarifyContent } from './index.ts';

const baseProduct = {
  id: 1,
  pagetitle: 'Розетка Werkel Gallant',
  alias: 'rozetka-werkel-gallant',
  url: 'https://220volt.kz/rozetki_i_vyklyuchateli/rozetka-werkel-gallant-w5071101/',
  price: 12500,
  vendor: 'Werkel',
  amount: 7,
  options: [
    { key: 'brend__brend', caption_ru: 'Бренд', value_ru: 'Werkel' },
  ],
  warehouses: [{ city: 'Алматы', amount: 3 }],
};

Deno.test('deterministic card keeps exact product URL from API', () => {
  const card = formatProductCardDeterministic(baseProduct as any);
  assertStringIncludes(card, '[Розетка Werkel Gallant](https://220volt.kz/rozetki_i_vyklyuchateli/rozetka-werkel-gallant-w5071101/)');
  assertFalse(card.includes('/catalog/'));
  assertFalse(card.includes('/search/'));
});

Deno.test('deterministic content for price-shortcircuit uses only original URLs', () => {
  const content = buildDeterministicShortCircuitContent({
    products: [
      baseProduct as any,
      {
        ...baseProduct,
        id: 2,
        pagetitle: 'Розетка IEK BRITE',
        url: 'https://220volt.kz/rozetki_i_vyklyuchateli/rozetka-iek-brite-br-r10-16-k47/',
        vendor: 'IEK',
        options: [{ key: 'brend__brend', caption_ru: 'Бренд', value_ru: 'IEK' }],
      } as any,
    ],
    reason: 'price-shortcircuit',
    userMessage: 'самая дешевая розетка',
    effectivePriceIntent: 'cheapest',
  });

  assertStringIncludes(content, 'Подобрал самые доступные варианты из каталога:');
  assertStringIncludes(content, 'https://220volt.kz/rozetki_i_vyklyuchateli/rozetka-werkel-gallant-w5071101/');
  assertStringIncludes(content, 'https://220volt.kz/rozetki_i_vyklyuchateli/rozetka-iek-brite-br-r10-16-k47/');
  assertFalse(content.includes('/catalog/'));
  assertFalse(content.includes('/search/'));
});

Deno.test('deterministic article response keeps consultant next-step without AI', () => {
  const content = buildDeterministicShortCircuitContent({
    products: [baseProduct as any],
    reason: 'article-shortcircuit',
    userMessage: 'найди по артикулу',
  });

  assertStringIncludes(content, 'Нашёл товар по точному запросу:');
  assertStringIncludes(content, 'Если нужно, сразу проверю аналоги, наличие по городам или более бюджетную замену.');
  assertEquals((content.match(/https:\/\/220volt\.kz\//g) || []).length, 1);
});

Deno.test('extractFacetsFromProducts aggregates Product.options[] using caption_ru/value_ru', () => {
  const facets = extractFacetsFromProducts([
    { id: 1, options: [{ key: 'tip', caption_ru: 'Тип', value_ru: 'Бытовая' }, { key: 'cvet', caption_ru: 'Цвет', value_ru: 'Белый' }] },
    { id: 2, options: [{ key: 'tip', caption_ru: 'Тип', value_ru: 'Бытовая' }, { key: 'cvet', caption_ru: 'Цвет', value_ru: 'Чёрный' }] },
    { id: 3, options: [{ key: 'tip', caption_ru: 'Тип', value_ru: 'Промышленная' }, { key: 'cvet', caption_ru: 'Цвет', value_ru: 'Белый' }] },
  ] as any);

  const tip = facets.find(f => f.key === 'tip');
  const cvet = facets.find(f => f.key === 'cvet');
  assertEquals(tip?.caption_ru, 'Тип');
  assertEquals(tip?.values.length, 2);
  assertEquals(cvet?.values.length, 2);
});

Deno.test('buildPriceFacetClarifyContent renders cards and asks via real facet values', () => {
  const text = buildPriceFacetClarifyContent({
    products: [baseProduct as any],
    priceIntent: 'cheapest',
    facet: {
      key: 'tip',
      caption_ru: 'Тип',
      values: [
        { value_ru: 'Бытовая', count: 5 },
        { value_ru: 'Промышленная', count: 3 },
      ],
    },
  });

  assertStringIncludes(text, 'Тип');
  assertStringIncludes(text, 'Бытовая');
  assertStringIncludes(text, 'Промышленная');
  assertStringIncludes(text, 'https://220volt.kz/');
});

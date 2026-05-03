import { assertEquals, assertStringIncludes, assertFalse } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import { buildDeterministicShortCircuitContent, formatProductCardDeterministic } from './index.ts';

const baseProduct = {
  id: 1,
  pagetitle: 'Розетка Werkel Gallant',
  alias: 'rozetka-werkel-gallant',
  url: 'https://220volt.kz/rozetki_i_vyklyuchateli/rozetka-werkel-gallant-w5071101/',
  price: 12500,
  vendor: 'Werkel',
  amount: 7,
  options: [
    { key: 'brend__brend', caption: 'Бренд', value: 'Werkel' },
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
      } as any,
    ],
    reason: 'price-shortcircuit',
    userMessage: 'самая дешевая розетка',
    effectivePriceIntent: 'cheapest',
  });

  assertStringIncludes(content, 'Подобрал самые доступные варианты из каталога:');
  assertStringIncludes(content, 'https://220volt.kz/rozetki_i_vyklyuchateli/rozetka-werkel-gallant-w5071101/');
  assertStringIncludes(content, 'https://220volt.kz/rozetki_i_vyklyuchateli/rozetka-iek-brite-br-r10-16-k47/');
  assertStringIncludes(content, 'Если хотите, могу сразу сузить подборку по бренду: IEK, Werkel.');
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
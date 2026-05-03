import { assertEquals, assertStringIncludes, assertFalse } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import { buildDeterministicShortCircuitContent, filterPriceIntentProductsByRelevance, formatProductCardDeterministic } from './index.ts';

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
        options: [{ key: 'brend__brend', caption: 'Бренд', value: 'IEK' }],
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

Deno.test('price intent relevance filter drops non-socket products for socket query', () => {
  const filtered = filterPriceIntentProductsByRelevance([
    {
      id: 10,
      pagetitle: 'Клемма плоская изолированная штекер 4.8 мм REXANT',
      alias: 'klemma-rexant',
      url: 'https://220volt.kz/catalog/kabel/klemma-rexant',
      price: 10,
      vendor: 'REXANT',
      amount: 20,
      options: [],
      category: { id: 1, pagetitle: 'Наконечники' },
    } as any,
    {
      id: 12,
      pagetitle: 'Выключатель 3SEM 1006 антенна',
      alias: 'vyklyuchatel-antenna',
      url: 'https://220volt.kz/catalog/rozetki/vyklyuchatel-antenna',
      price: 52,
      vendor: 'Sassin',
      amount: 5,
      options: [],
      category: { id: 3, pagetitle: 'Розетки' },
    } as any,
    {
      id: 13,
      pagetitle: 'Патрон-розетка карболитовый Е27 черный',
      alias: 'patron-rozetka-e27',
      url: 'https://220volt.kz/catalog/svet/patron-rozetka-e27',
      price: 200,
      vendor: 'REXANT',
      amount: 8,
      options: [],
      category: { id: 4, pagetitle: 'Комплектующие для светильников' },
    } as any,
    {
      id: 14,
      pagetitle: 'Розетка для пром реле РР102-4-03',
      alias: 'rozetka-dlya-rele',
      url: 'https://220volt.kz/catalog/rele/rozetka-dlya-rele',
      price: 318,
      vendor: 'Delixi',
      amount: 11,
      options: [],
      category: { id: 5, pagetitle: 'Релейная автоматика' },
    } as any,
    {
      id: 11,
      pagetitle: 'Розетка штепсельная карболитовая открытой установки 16 А',
      alias: 'rozetka-rexant',
      url: 'https://220volt.kz/catalog/rozetki/rozetka-rexant',
      price: 335,
      vendor: 'REXANT',
      amount: 12,
      options: [],
      category: { id: 2, pagetitle: 'Розетки' },
    } as any,
  ], ['розетка']);

  assertEquals(filtered.map((p: any) => p.id), [11]);
});
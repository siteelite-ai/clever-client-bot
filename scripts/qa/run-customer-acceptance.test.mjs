import assert from 'node:assert/strict';
import test from 'node:test';

import { evaluate, parseSse } from './run-customer-acceptance.mjs';

function data(payload) {
  return `data: ${JSON.stringify(payload)}`;
}

test('parseSse keeps pre-product text and parses card prices', () => {
  const body = [
    data({ choices: [{ delta: { content: 'Сначала объяснение.' } }] }),
    data({ v3_event: {
      type: 'products_block',
      markdown: '- **[Товар 1P 16А х-ка C](https://220volt.kz/catalog/a/b/item-%28x%29/)**\n  Цена: *1 234* ₸/уп',
    } }),
    data({ v3_event: { type: 'diagnostic', phase: 'complete', products_count: 1 } }),
    'data: [DONE]',
  ].join('\n');

  const parsed = parseSse(body);
  assert.equal(parsed.textBeforeProducts, 'Сначала объяснение.');
  assert.deepEqual(parsed.links, [{
    title: 'Товар 1P 16А х-ка C',
    url: 'https://220volt.kz/catalog/a/b/item-%28x%29/',
    price: 1234,
  }]);
  assert.equal(parsed.completed, true);
  assert.equal(parsed.serverProductsCount, 1);
});

test('evaluate checks every product title group and maximum price', () => {
  const response = {
    text: '',
    textBeforeProducts: '',
    productsMarkdown: '',
    links: [
      { title: 'Автомат 1P 16А х-ка C', url: 'https://220volt.kz/catalog/a/b/item/', price: 900 },
      { title: 'Автомат 1P 10А х-ка C', url: 'https://220volt.kz/catalog/a/b/item-2/', price: 1100 },
    ],
    completed: true,
    diagnosticError: null,
    serverProductsCount: 2,
  };

  const failures = evaluate({
    max_product_price: 1000,
    require_every_product_title_groups: [
      ['1P', '1Р'],
      ['16A', '16А'],
    ],
  }, response);
  assert(failures.some((failure) => failure.startsWith('product titles violate required groups')));
  assert(failures.some((failure) => failure.startsWith('product price exceeds 1000')));
});

test('evaluate rejects catalog claims that bypass product cards', () => {
  const failures = evaluate({ min_products: 1, forbid_unrendered_catalog_facts: true }, {
    text: '**Товар** — 477 ₸/шт. Арт. ABC-123. Наличие: Алматы.',
    textBeforeProducts: '**Товар** — 477 ₸/шт. Арт. ABC-123. Наличие: Алматы.',
    productsMarkdown: '',
    links: [],
    completed: true,
    diagnosticError: null,
    serverProductsCount: 0,
  });

  assert(failures.includes('unrendered catalog facts in assistant text'));
  assert(failures.includes('products 0 < 1'));
});

test('evaluate allows evidence-only follow-ups without fresh product cards by default', () => {
  const failures = evaluate({}, {
    text: 'По ранее показанному товару: цена 477 ₸/шт., арт. ABC-123.',
    textBeforeProducts: 'По ранее показанному товару: цена 477 ₸/шт., арт. ABC-123.',
    productsMarkdown: '',
    links: [],
    completed: true,
    diagnosticError: null,
    serverProductsCount: 0,
  });

  assert.deepEqual(failures, []);
});

test('evaluate accepts an honest non-catalog answer without cards', () => {
  const failures = evaluate({
    max_products: 0,
    require_any_text: ['чистая синусоида'],
  }, {
    text: 'Для чувствительной электроники нужна чистая синусоида.',
    textBeforeProducts: 'Для чувствительной электроники нужна чистая синусоида.',
    productsMarkdown: '',
    links: [],
    completed: true,
    diagnosticError: null,
    serverProductsCount: 0,
  });

  assert.deepEqual(failures, []);
});

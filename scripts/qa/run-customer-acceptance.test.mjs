import assert from 'node:assert/strict';
import test from 'node:test';

import { DEFAULT_ENDPOINT, evaluate, parseSse, resolveEndpoint } from './run-customer-acceptance.mjs';

function data(payload) {
  return `data: ${JSON.stringify(payload)}`;
}

test('resolveEndpoint keeps production by default and accepts an isolated preview function', () => {
  assert.equal(resolveEndpoint(['node', 'runner']), DEFAULT_ENDPOINT);
  assert.equal(
    resolveEndpoint(['node', 'runner', '--endpoint=https://example.supabase.co/functions/v1/chat-consultant-v3-preview/']),
    'https://example.supabase.co/functions/v1/chat-consultant-v3-preview',
  );
});

test('resolveEndpoint rejects unsafe or non-function targets', () => {
  assert.throws(
    () => resolveEndpoint(['node', 'runner', '--endpoint=http://example.com/functions/v1/preview']),
    /HTTPS/,
  );
  assert.throws(
    () => resolveEndpoint(['node', 'runner', '--endpoint=https://example.com/not-a-function']),
    /one Edge Function/,
  );
});

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
    stockLine: null,
  }]);
  assert.equal(parsed.completed, true);
  assert.equal(parsed.serverProductsCount, 1);
});

test('parseSse keeps stock line for warehouse-priority assertions', () => {
  const body = [
    data({ v3_event: {
      type: 'products_block',
      markdown: '- **[Прожектор](https://220volt.kz/p)**\n  Цена: *100* ₸\n  Наличие: Алматы (2 шт), Иргели (50 шт)',
    } }),
    'data: [DONE]',
  ].join('\n');
  const parsed = parseSse(body);
  assert.equal(parsed.links[0].stockLine, 'Алматы (2 шт), Иргели (50 шт)');
});

test('parseSse ignores heartbeat comments without losing completion', () => {
  const body = [
    ': keep-alive',
    '',
    'data: {"choices":[{"delta":{"content":"Ответ"}}]}',
    ': keep-alive',
    'data: [DONE]',
    '',
  ].join('\n');

  const parsed = parseSse(body);
  assert.equal(parsed.text, 'Ответ');
  assert.equal(parsed.completed, true);
  assert.equal(parsed.links.length, 0);
});

test('parseSse exposes automatic conversation boundaries', () => {
  const parsed = parseSse([
    data({ v3_event: { type: 'conversation_boundary', mode: 'new_task', session_id: 'session_new_scope' } }),
    'data: [DONE]',
  ].join('\n'));
  assert.deepEqual(parsed.conversationBoundary, { mode: 'new_task', sessionId: 'session_new_scope' });
  assert.deepEqual(evaluate({ conversation_boundary: 'new_task' }, parsed), []);
  assert(evaluate({ conversation_boundary: 'continuation' }, parsed).includes('unexpected conversation boundary: new_task'));
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

test('forbidden product nominal is matched as a token, not inside another nominal', () => {
  const base = {
    text: '',
    textBeforeProducts: '',
    productsMarkdown: '',
    completed: true,
    diagnosticError: null,
    serverProductsCount: 1,
  };
  assert.deepEqual(evaluate({ forbid_product_title: ['6А'] }, {
    ...base,
    links: [{ title: 'Автомат 1P 16А характеристика C', url: 'https://220volt.kz/catalog/a/b/item/', price: 500 }],
  }), []);
  assert(evaluate({ forbid_product_title: ['6А'] }, {
    ...base,
    links: [{ title: 'Автомат 1P 6А характеристика C', url: 'https://220volt.kz/catalog/a/b/item/', price: 500 }],
  }).includes('forbidden product title: 6А'));
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

test('evaluate rejects duplicated catalog facts even when a card was rendered', () => {
  const failures = evaluate({ forbid_unrendered_catalog_facts: true }, {
    text: 'Лидер по цене — 477 ₸/шт. Наличие: Алматы.',
    textBeforeProducts: 'Лидер по цене — 477 ₸/шт. Наличие: Алматы.',
    productsMarkdown: '- **[Товар](https://220volt.kz/catalog/a/b/item/)**\n  Цена: *477* ₸',
    links: [{ title: 'Товар', url: 'https://220volt.kz/catalog/a/b/item/', price: 477 }],
    completed: true,
    diagnosticError: null,
    serverProductsCount: 1,
  });

  assert(failures.includes('unrendered catalog facts in assistant text'));
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

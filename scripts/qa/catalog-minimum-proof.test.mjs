import assert from 'node:assert/strict';
import test from 'node:test';
import { catalogMinimumFromHtml, catalogMinimumFromHtmlPages, validCatalogMinimumContract, verifyCatalogMinimum } from './catalog-minimum-proof.mjs';

const source = 'https://220volt.kz/catalog/cables/vvg/3-1.5/';
const contract = { title_prefix: 'Кабель ВВГ 3*1,5', unit: 'м' };

function card(id, name, price, { stock = 3, unit = 'м', available = stock > 0,
  href = `catalog/cables/vvg/product-${id}/`, dataPrice = price, priceText = price } = {}) {
  return `<div class="card__item">
    <a class="card__title" href="${href}">${name}</a>
    <div class="card__availability">${available ? 'В наличии' : 'Нет в наличии'}</div>
    <a class="product-instock-link" data-storage='${JSON.stringify({ karaganda: String(stock), ei: unit })}'></a>
    <form class="js-cart-add" data-id="${id}" data-item-price="${dataPrice}"></form>
    <span class="product__buy-info-price-actual_value">${priceText}</span>
  </div>`;
}

function category(cards, { total = cards.length, canonical = source, activePage = null } = {}) {
  return `<!doctype html><html><head><link rel="canonical" href="${canonical}"></head><body>
    <span id="mse2_total">${total}</span>
    ${activePage === null ? '' : `<span class="pagination__item page active">${activePage}</span>`}
    <div id="mse2_results">${cards.join('')}</div></body></html>`;
}

function response(html, { status = 200, contentType = 'text/html; charset=UTF-8', contentLength = null } = {}) {
  return {
    status,
    headers: { get: (key) => key === 'content-type' ? contentType : key === 'content-length' ? contentLength : null },
    text: async () => html,
  };
}

test('proves minimum from all complete public-category cards, not from sort order or bot output', () => {
  const html = category([
    card('1', 'Кабель ВВГ нг 3*1,5', '100.00'),
    card('2', 'Кабель ВВГ 3×1,5 AT', '462.00'),
    card('3', 'Кабель ВВГ 3*1,5 ГОСТ IK', '301.00'),
    card('4', 'Кабель ВВГ 3x1.5 ГК ГОСТ', '451.00'),
    card('5', 'Кабель ВВГ 3*1,5 (Бухта 100м)', '250.00', { unit: 'уп.' }),
    card('6', 'Кабель ВВГ 3*1,5', '0.00', { stock: 0 }),
  ]);
  const proof = catalogMinimumFromHtml(html, source, contract);
  assert.deepEqual({ ...proof, eligible_products: undefined }, {
    source_url: source, listed_total: 6, matching_available: 3,
    eligible_products: undefined,
    excluded_out_of_stock: 1, excluded_other_units: 1,
    minimum_price: 301,
    winners: [{ url: 'https://220volt.kz/catalog/cables/vvg/product-3/',
      title: 'Кабель ВВГ 3*1,5 ГОСТ IK', price: 301, unit: 'м', id: '3' }],
  });
  assert.equal(proof.eligible_products.length, 3);
});

test('allows tied winners, rejects alternate marking and 3×1,50 false prefix', () => {
  const html = category([
    card('1', 'Кабель ВВГ 3*1,5 ГК', '301.00'),
    card('2', 'Кабель ВВГ 3х1.5 Тк', '301.00'),
    card('3', 'Кабель ВВГ 3*1,50', '1.00'),
  ]);
  const proof = catalogMinimumFromHtml(html, source, contract);
  assert.equal(proof.minimum_price, 301);
  assert.deepEqual(proof.winners.map((item) => item.id), ['1', '2']);
});

test('fails closed on incomplete, duplicate, ambiguous and spoofed category evidence', () => {
  const valid = card('1', 'Кабель ВВГ 3*1,5', '301.00');
  const invalid = [
    category([valid], { total: 2 }),
    category([valid], { canonical: 'https://evil.example/catalog/cables/vvg/3-1.5/' }),
    category([valid, valid]),
    category([valid.replace('data-id="1"', 'data-id="bogus"')]),
    category([valid.replace('product-1/', 'https://evil.example/p/')]),
    category([valid.replace('data-item-price="301.00"', 'data-item-price="299.00"')]),
    category([valid.replace('data-storage=', 'data-missing=')]),
    category([valid.replace('"karaganda":"3"', '"karaganda":"0"')]),
    category([valid.replace('В наличии', 'Неизвестно')]),
    category([valid], { total: 121 }),
  ];
  for (const [index, html] of invalid.entries()) {
    assert.throws(() => catalogMinimumFromHtml(html, source, contract), undefined, `invalid fixture ${index}`);
  }
});

test('source fetch is bounded, same-origin, redirect-free and rejects non-HTML', async () => {
  const html = category([card('1', 'Кабель ВВГ 3*1,5', '301.00')]);
  const fullContract = { source_url: source, ...contract };
  const seen = [];
  const proof = await verifyCatalogMinimum(source, fullContract, {
    fetchImpl: async (url, options) => { seen.push({ url, options }); return response(html); },
  });
  assert.equal(proof.verified, true);
  assert.equal(proof.minimum_price, 301);
  assert.equal(seen[0].url, source);
  assert.equal(seen[0].options.redirect, 'manual');
  assert.equal(seen[0].options.credentials, 'omit');
  for (const url of ['http://220volt.kz/catalog/cables/vvg/3-1.5/',
    'https://evil.example/catalog/cables/vvg/3-1.5/',
    'https://220volt.kz/catalog/cables/vvg/3-1.5/?page=2']) {
    assert.equal((await verifyCatalogMinimum(url, fullContract, { fetchImpl: () => { throw new Error('must not fetch'); } })).verified, false);
  }
  for (const fake of [response(html, { status: 302 }), response(html, { contentType: 'application/json' }),
    response(html, { contentLength: '1000001' })]) {
    assert.equal((await verifyCatalogMinimum(source, fullContract, { fetchImpl: async () => fake })).verified, false);
  }
  const hanging = await verifyCatalogMinimum(source, fullContract,
    { timeoutMs: 5, fetchImpl: async () => await new Promise(() => {}) });
  assert.equal(hanging.verified, false);
  assert.match(hanging.reason, /deadline/u);
  assert.equal(validCatalogMinimumContract(fullContract), true);
  for (const invalid of [
    { ...fullContract, source_url: 'https://evil.example/catalog/cables/vvg/3-1.5/' },
    { ...fullContract, source_url: `${source}?page=2` },
    { ...fullContract, title_prefix: 'Кабель' },
    { ...fullContract, unit: '' },
    { ...fullContract, pagination: true },
  ]) assert.equal(validCatalogMinimumContract(invalid), false);
});

test('verifies all three same-origin pages before certifying a category minimum', async () => {
  const pages = [
    category([card('1', 'Кабель ВВГ 3*1,5 A', '301.00'), card('2', 'Другой кабель', '10.00')],
      { total: 5, activePage: 1 }),
    category([card('3', 'Кабель ВВГ 3*1,5 B', '320.00'),
      card('4', 'Кабель ВВГ 3*1,5 бухта', '25.00', { unit: 'уп.' })],
    { total: 5, activePage: 2 }),
    category([card('5', 'Кабель ВВГ 3*1,5 C', '290.00')], { total: 5, activePage: 3 }),
  ];
  const pure = catalogMinimumFromHtmlPages(pages, source, contract);
  assert.equal(pure.listed_total, 5);
  assert.equal(pure.minimum_price, 290);
  assert.equal(pure.matching_available, 3);
  assert.equal(pure.excluded_other_units, 1);
  const requested = [];
  const proof = await verifyCatalogMinimum(source, { source_url: source, ...contract }, {
    fetchImpl: async (url, options) => {
      requested.push({ url, options });
      return response(pages[requested.length - 1]);
    },
  });
  assert.equal(proof.verified, true);
  assert.deepEqual(proof.winners.map((item) => item.id), ['5']);
  assert.deepEqual(requested.map((entry) => entry.url),
    [source, `${source}?page=2`, `${source}?page=3`]);
  assert.ok(requested.every((entry) => entry.options.redirect === 'manual' &&
    entry.options.credentials === 'omit'));
});

test('multi-page proof fails closed on partial, repeated, drifting or redirected pages', async () => {
  const first = category([card('1', 'Кабель ВВГ 3*1,5 A', '301.00'),
    card('2', 'Другое изделие', '1.00')], { total: 5, activePage: 1 });
  const second = category([card('3', 'Кабель ВВГ 3*1,5 B', '300.00'),
    card('4', 'Другое изделие', '1.00')], { total: 5, activePage: 2 });
  const third = category([card('5', 'Кабель ВВГ 3*1,5 C', '299.00')],
    { total: 5, activePage: 3 });
  const badCollections = [
    [first, second],
    [first, second, third.replace('product-5/', 'product-4/').replace('data-id="5"', 'data-id="4"')],
    [first, second, category([card('2', 'Другое изделие', '1.00')], { total: 5, activePage: 3 })],
    [first, second, third.replace('id="mse2_total">5', 'id="mse2_total">6')],
    [first, second.replace('page active">2', 'page active">1'), third],
    [first, second, third.replace('page active">3', 'page active">2')],
    [first, second, third.replace(source, 'https://evil.example/catalog/cables/vvg/3-1.5/')],
    [first, second, category([], { total: 5, activePage: 3 })],
  ];
  for (const [index, pages] of badCollections.entries()) {
    assert.throws(() => catalogMinimumFromHtmlPages(pages, source, contract), undefined,
      `invalid collection ${index}`);
  }
  for (const badThird of [response(third, { status: 302 }),
    response(third, { contentType: 'application/json' }), response(third, { contentLength: '1000001' })]) {
    const proof = await verifyCatalogMinimum(source, { source_url: source, ...contract }, {
      fetchImpl: async (url) => url === source ? response(first) :
        url.endsWith('page=2') ? response(second) : badThird,
    });
    assert.equal(proof.verified, false);
  }
  const redirected = await verifyCatalogMinimum(source, { source_url: source, ...contract }, {
    fetchImpl: async (url) => ({ ...response(url === source ? first : second),
      url: url === source ? source : 'https://evil.example/catalog/cables/vvg/3-1.5/?page=2' }),
  });
  assert.equal(redirected.verified, false);
  assert.match(redirected.reason, /changed URL/u);
  const pageCap = await verifyCatalogMinimum(source, { source_url: source, ...contract }, {
    fetchImpl: async (url) => {
      assert.equal(url, source);
      return response(category([card('1', 'Кабель ВВГ 3*1,5', '301.00')],
        { total: 9, activePage: 1 }));
    },
  });
  assert.equal(pageCap.verified, false);
  assert.match(pageCap.reason, /pagination limit/u);
  const oversizedStream = await verifyCatalogMinimum(source, { source_url: source, ...contract }, {
    fetchImpl: async () => ({
      status: 200,
      headers: { get: (key) => key === 'content-type' ? 'text/html' : null },
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array(1_000_001));
          controller.close();
        },
      }),
    }),
  });
  assert.equal(oversizedStream.verified, false);
  assert.match(oversizedStream.reason, /HTML size limit/u);
});

import assert from 'node:assert/strict';
import test from 'node:test';
import { catalogMinimumFromHtml, validCatalogMinimumContract, verifyCatalogMinimum } from './catalog-minimum-proof.mjs';

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

function category(cards, { total = cards.length, canonical = source } = {}) {
  return `<!doctype html><html><head><link rel="canonical" href="${canonical}"></head><body>
    <span id="mse2_total">${total}</span><div id="mse2_results">${cards.join('')}</div></body></html>`;
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

import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { catalogMinimumFromHtmlPages, validCatalogLowestNContract } from './catalog-minimum-proof.mjs';
import {
  captureVerifiedProductBatch, catalogLowestNFailures, evaluate,
  parseSse, previousBatchMinimumFailures, productUrlIdentity, shapeFacetProvenanceFailures,
  validateExpectationObject, validateExpectationSuite,
} from './run-customer-acceptance.mjs';

const source = 'https://220volt.kz/catalog/cables/vvg/3-1.5/';
const contract = { source_url: source, title_prefix: 'Кабель ВВГ 3*1,5', unit: 'м', count: 3 };

function product(id, price, title = `Кабель ВВГ 3*1,5 модель ${id}`) {
  return { id: String(id), url: `https://220volt.kz/catalog/cables/vvg/product-${id}/`, title, price, unit: 'м' };
}

function page(item) {
  return { verified: true, identity: productUrlIdentity(item.url), canonicalUrl: item.url,
    sku: item.id, name: item.title, offerPrice: item.price,
    availability: 'https://schema.org/InStock' };
}

function answer(items, { pages = new Map(items.map((item) => [productUrlIdentity(item.url), page(item)])),
  proof = null, completed = true, serverProductsCount = items.length,
  conversationBoundary = null } = {}) {
  return {
    text: '', productsMarkdown: 'verified cards',
    links: items.map((item) => ({ title: item.title, url: item.url, price: item.price,
      stockLine: 'Караганда (3 м)' })),
    verifiedProductPages: pages,
    catalogMinimumProof: proof,
    completed, terminalDiagnosticSeen: true, serverProductsCount,
    logId: 'offline-request-id', conversationBoundary,
  };
}

function categoryCard(item, { stock = 3, unit = 'м' } = {}) {
  return `<div class="card__item"><a class="card__title" href="/catalog/cables/vvg/product-${item.id}/">${item.title}</a>
    <span class="card__availability">${stock ? 'В наличии' : 'Нет в наличии'}</span>
    <a class="product-instock-link" data-storage='{"karaganda":"${stock}","ei":"${unit}"}'></a>
    <form class="js-cart-add" data-id="${item.id}" data-item-price="${item.price}"></form>
    <span class="product__buy-info-price-actual_value">${item.price}</span></div>`;
}

function categoryPage(items, total, activePage) {
  return `<html><head><link rel="canonical" href="${source}"></head><body>
    <span id="mse2_total">${total}</span>
    <span class="pagination__item page active">${activePage}</span>
    <div id="mse2_results">${items.map((item) => categoryCard(item)).join('')}</div>
  </body></html>`;
}

test('follow-up chooses only exact cheapest URLs and current offers from the latest verified batch; ties are allowed', () => {
  const older = captureVerifiedProductBatch(answer([product(9, 10)]));
  const latest = captureVerifiedProductBatch(answer([product(1, 100), product(2, 100), product(3, 250)]));
  assert.equal(older.verified, true);
  assert.equal(latest.verified, true);
  assert.deepEqual(evaluate({ require_previous_batch_minimum: true }, answer([product(2, 100)]),
    { previousVerifiedProductBatch: latest }), []);
  assert.deepEqual(previousBatchMinimumFailures(answer([product(1, 100), product(2, 100)]), latest), []);
  assert.match(previousBatchMinimumFailures(answer([product(9, 10)]), latest).join(' '), /latest-batch minimum/u);
  assert.match(previousBatchMinimumFailures(answer([product(3, 250)]), latest).join(' '), /latest-batch minimum/u);
});

test('missing or partial previous product proof fails closed instead of falling back to historical cards', () => {
  const latestItems = [product(1, 100), product(2, 200)];
  const partialPages = new Map([[productUrlIdentity(latestItems[0].url), page(latestItems[0])]]);
  for (const latest of [
    captureVerifiedProductBatch(answer(latestItems, { pages: partialPages })),
    captureVerifiedProductBatch(answer(latestItems, { completed: false })),
    captureVerifiedProductBatch(answer(latestItems, { serverProductsCount: 3 })),
    captureVerifiedProductBatch(answer([])),
  ]) {
    assert.equal(latest.verified, false);
    assert.match(previousBatchMinimumFailures(answer([product(1, 100)]), latest).join(' '),
      /no complete latest verified product batch/u);
  }
  const latest = captureVerifiedProductBatch(answer(latestItems));
  assert.match(previousBatchMinimumFailures(answer([product(1, 100)], { pages: new Map() }), latest).join(' '),
    /exact latest-batch minimum URL and offer/u);
  assert.match(previousBatchMinimumFailures(answer([{ ...product(1, 100), price: 99 }]), latest).join(' '),
    /exact latest-batch minimum URL and offer/u);
  assert.match(previousBatchMinimumFailures(answer([product(1, 100)], {
    conversationBoundary: { mode: 'new_task' },
  }), latest).join(' '), /new-task boundary/u);
  const malformed = parseSse('data: {"v3_event":{"type":"products_block"}}\n\ndata: [DONE]\n\n');
  assert.equal(malformed.productsBlockSeen, true);
  assert.equal(captureVerifiedProductBatch(malformed).verified, false);
});

test('plural lowest-N is certified against every unique card across complete category pages', () => {
  const items = [product(1, 300), product(2, 100), product(3, 200),
    product(4, 200), product(5, 50)];
  const pages = [
    categoryPage(items.slice(0, 2), 5, 1),
    categoryPage(items.slice(2, 4), 5, 2),
    categoryPage(items.slice(4), 5, 3),
  ];
  const sourceProof = catalogMinimumFromHtmlPages(pages, source, contract);
  assert.equal(sourceProof.covered_total, 5);
  assert.equal(sourceProof.page_count, 3);
  const proof = { verified: true, ...sourceProof };
  const expected = [items[4], items[1], items[3]];
  assert.deepEqual(evaluate({ require_catalog_lowest_n: contract }, answer(expected, { proof })), []);
  assert.deepEqual(catalogLowestNFailures(contract, answer([items[4], items[1], items[2]], { proof })), []);
  for (const selected of [
    [items[1], items[4], items[2]], // correct set, wrong price order
    [items[4], items[1], items[0]], // more expensive instead of a tied Nth item
    [items[4], items[1]], // fewer cards than requested
    [items[4], items[1], items[1]], // duplicate URL
  ]) assert.notDeepEqual(catalogLowestNFailures(contract, answer(selected, { proof })), []);
  assert.notDeepEqual(catalogLowestNFailures(contract, answer(expected, {
    proof, pages: new Map(expected.slice(0, 2).map((item) => [productUrlIdentity(item.url), page(item)])),
  })), []);
  assert.notDeepEqual(catalogLowestNFailures(contract, answer(expected, {
    proof: { ...proof, covered_total: 4 },
  })), []);
  assert.notDeepEqual(catalogLowestNFailures(contract, answer(expected, {
    proof: { ...proof, eligible_products: proof.eligible_products.slice(0, 4) },
  })), []);
  assert.throws(() => catalogMinimumFromHtmlPages(pages.slice(0, 2), source, contract), /incomplete/u);
});

test('new ranking expectations are opt-in, bounded and reject contradictory card bounds', () => {
  assert.equal(validCatalogLowestNContract(contract), true);
  assert.doesNotThrow(() => validateExpectationObject({ require_catalog_lowest_n: contract }));
  assert.doesNotThrow(() => validateExpectationObject({ require_previous_batch_minimum: true }));
  for (const invalid of [
    { ...contract, count: 1 }, { ...contract, count: 21 },
    { ...contract, source_url: 'https://evil.example/catalog/cables/vvg/3-1.5/' },
    { ...contract, allow_partial: true },
  ]) assert.throws(() => validateExpectationObject({ require_catalog_lowest_n: invalid }), /require_catalog_lowest_n/u);
  assert.throws(() => validateExpectationObject({ require_catalog_lowest_n: contract, max_products: 2 }),
    /conflicts with product-card bounds/u);
  assert.throws(() => validateExpectationObject({ require_previous_batch_minimum: false }), /opt in with true/u);
});

test('numeric area cannot prove a mandatory shape facet, but an explicit shape can', () => {
  const square = { mandatory_criteria: [{ key: 'Форма люстры', op: 'eq', value: 'квадрат',
    evidence: 'derived_required' }] };
  const areaOnly = [
    'хочу поменять люстру в зале 30 квадратов',
    'Они подходят для освещения 30 квадратных метров?',
    'А есть другие варианты?',
  ];
  assert.match(shapeFacetProvenanceFailures(square, areaOnly).join(' '), /lacks customer evidence/u);
  assert.match(evaluate({ require_shape_facet_provenance: true }, {
    ...answer([]), selectionContract: square,
    text: 'Ищу «Форма люстры: квадрат».',
  }, { userMessages: areaOnly }).join(' '), /lacks customer evidence/u);
  assert.deepEqual(shapeFacetProvenanceFailures(square,
    ['хочу квадратную люстру в зал 30 квадратов']), []);
  assert.deepEqual(shapeFacetProvenanceFailures({ mandatory_criteria: [{
    key: 'Форма люстры', value: 'кольцо', evidence: 'user_explicit',
  }] }, ['подбери кольцевую люстру']), []);
  assert.deepEqual(shapeFacetProvenanceFailures({ mandatory_criteria: [] }, areaOnly), []);
  assert.match(shapeFacetProvenanceFailures(null, areaOnly).join(' '), /machine-readable/u);
  assert.throws(() => validateExpectationObject({ require_shape_facet_provenance: false }),
    /opt in with true/u);
  const prospective = JSON.parse(fs.readFileSync(new URL('./area-shape-provenance-prospective.json', import.meta.url)));
  assert.doesNotThrow(() => validateExpectationSuite(prospective));
  const pinned = JSON.parse(fs.readFileSync(new URL('./customer-acceptance-cases-v2.json', import.meta.url)));
  const chandelier = pinned.cases.find((item) => item.id === 'customer-chandelier-30m2');
  assert.deepEqual(prospective.cases[0].turns.map((turn) => turn.message),
    chandelier.turns.map((turn) => turn.message));
  assert.ok(prospective.cases[0].turns[0].expect.min_products >= 3);
  assert.equal(prospective.cases[0].turns[0].expect.require_every_product_page.facets.length, 2);
  const followup = prospective.cases[0].turns.at(-1).expect;
  assert.equal(followup.require_shape_facet_provenance, true);
  assert.equal(followup.require_new_product_skus, true);
  assert.ok(followup.min_products >= 1);
  assert.equal(followup.require_every_product_page.facets.length, 2);
});

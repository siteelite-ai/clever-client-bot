import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  extractCompletedProductCards,
  verifyReportsProductPages,
} from './verify-report-product-pages.mjs';

const url = 'https://220volt.kz/catalog/test/category/example-product/';
const title = 'Автомат 1Р 16А характеристика C';

function card(overrides = {}) {
  return { url, title, price: 477, stockLine: 'Караганда (2 шт)', ...overrides };
}

function turn(products, overrides = {}) {
  return {
    status: 200,
    completed: true,
    diagnostic_error: null,
    passed: true,
    products_count: products.length,
    products,
    ...overrides,
  };
}

function report(turns) {
  return {
    passed: true,
    cases: [{ id: 'generic-case', repeats: [{ variant: 'base', run: 1, turns }] }],
  };
}

function page({ canonical = url, sku = '12345', name = title, price = 477, availability = 'https://schema.org/InStock' } = {}) {
  return `<!doctype html><html><head><link rel="canonical" href="${canonical}"></head><body>
    <h1>${name}</h1>
    <div class="product__tab-description-item"><span class="product__description-title">Номинальный ток:</span><span class="product__tab-description-text">16 А</span></div>
    <script type="application/ld+json">${JSON.stringify({
      '@context': 'https://schema.org', '@type': 'Product', '@id': url, sku, name,
      offers: { '@type': 'Offer', priceCurrency: 'KZT', price, availability },
    })}</script>
  </body></html>`;
}

function fetchPage(html, calls) {
  return async (requested, options) => {
    calls.push({ requested, options });
    return new Response(html, { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
  };
}

test('verifies all completed cards once per unique canonical page without AI requests', async () => {
  const calls = [];
  const result = await verifyReportsProductPages([
    { source: 'a.json', report: report([turn([card()]), turn([card()])]) },
    { source: 'b.json', report: report([turn([card()])]) },
  ], { fetchImpl: fetchPage(page(), calls) });
  assert.equal(result.passed, true);
  assert.equal(result.cards_checked, 3);
  assert.equal(result.unique_pages_checked, 1);
  assert.equal(result.pages_verified, 1);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].requested, url);
  assert.equal(calls[0].options.redirect, 'manual');
  assert.equal(calls[0].options.credentials, 'omit');
  assert.equal(result.reports[0].completed_turns, 2);
});

test('ignores failed/incomplete transport turns but never silently accepts no cards', async () => {
  const one = report([
    turn([card()], { status: 500, completed: false, passed: false }),
    turn([], { completed: true }),
  ]);
  const extracted = extractCompletedProductCards(one, 'one.json');
  assert.equal(extracted.completedTurns, 1);
  assert.equal(extracted.cards.length, 0);
  const result = await verifyReportsProductPages([{ source: 'one.json', report: one }], {
    fetchImpl: async () => { throw new Error('must not fetch'); },
  });
  assert.equal(result.passed, false);
  assert.match(result.failures[0].reason, /no completed product cards/);
});

test('fails closed on wrong canonical, missing SKU, mismatched price, or unavailable product', async () => {
  for (const [source, changes, expected] of [
    ['canonical', { canonical: 'https://220volt.kz/catalog/test/category/different-product/' }, /canonical product URL/],
    ['sku', { sku: '' }, /SKU/],
    ['price', { price: 599 }, /price/],
    ['stock', { availability: 'https://schema.org/OutOfStock' }, /InStock/],
  ]) {
    const calls = [];
    const result = await verifyReportsProductPages([{ source, report: report([turn([card()])]) }], {
      fetchImpl: fetchPage(page(changes), calls),
    });
    assert.equal(result.passed, false, source);
    assert.match(result.failures.map((failure) => failure.reason).join(' | '), expected, source);
    assert.equal(calls.length, 1, source);
  }
});

test('reports API/page title aliases separately, but rejects absent stock and invalid links', async () => {
  const calls = [];
  const result = await verifyReportsProductPages([{ source: 'x.json', report: report([turn([
    card({ title: 'Wrong title', stockLine: '' }),
    card({ url: 'https://attacker.example/catalog/x/y/z/' }),
  ])]) }], { fetchImpl: fetchPage(page(), calls) });
  assert.equal(result.passed, false);
  const reasons = result.failures.map((failure) => failure.reason).join(' | ');
  assert.doesNotMatch(reasons, /title/);
  assert.equal(result.name_differences.length, 1);
  assert.equal(result.name_differences[0].live_name, title);
  assert.match(reasons, /stock line/);
  assert.match(reasons, /invalid or missing/);
  assert.equal(calls.length, 1);
  assert.throws(() => extractCompletedProductCards(report([turn([card()], { products_count: 2 })])), /products_count 2/);
});

test('rejects compact/incomplete reports instead of giving a false pass', () => {
  assert.throws(() => extractCompletedProductCards({}), /full acceptance report/);
  assert.throws(() => extractCompletedProductCards({ cases: [{ id: 'x', repeats: [{ run: 1, turns: [{ status: 200, completed: true }] }] }] }), /products\[\] missing/);
});

test('cannot turn a failed acceptance report into a passing page audit', async () => {
  const failedAcceptance = report([turn([card()])]);
  failedAcceptance.passed = false;
  const result = await verifyReportsProductPages([
    { source: 'failed.json', report: failedAcceptance },
  ], { fetchImpl: fetchPage(page(), []) });
  assert.equal(result.passed, false);
  assert.match(result.failures.map((failure) => failure.reason).join(' | '), /acceptance report did not pass/);
});

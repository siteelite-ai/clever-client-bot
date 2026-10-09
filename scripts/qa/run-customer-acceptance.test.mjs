import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

import {
  ACCEPTANCE_TURN_TIMEOUT_MS, DEFAULT_ENDPOINT, evaluate, fetchAcceptanceTurn,
  parseSse, productProofFromHtml, productUrlIdentity, resolveCaseExecutions,
  resolveEndpoint, resolveExpectations, selectCaseExecutions, validateStrictFullSuite,
  validateCliArgs, verifyProductLinks, verifyProductPage,
} from './run-customer-acceptance.mjs';

const acceptanceBytes = fs.readFileSync(new URL('./customer-acceptance-cases.json', import.meta.url));
const septemberBytes = fs.readFileSync(new URL('./customer-audit-20260921-cases.json', import.meta.url));
const septemberVariationBytes = fs.readFileSync(new URL('./customer-audit-20260921-variations.json', import.meta.url));
const notionBytes = fs.readFileSync(new URL('./notion-legacy-bug-cases.json', import.meta.url));
const cardinalityBytes = fs.readFileSync(new URL('./systemic-cardinality-cases.json', import.meta.url));
const acceptanceSuite = JSON.parse(acceptanceBytes.toString('utf8'));
const septemberSuite = JSON.parse(septemberBytes.toString('utf8'));
const septemberVariations = JSON.parse(septemberVariationBytes.toString('utf8'));
const notionSuite = JSON.parse(notionBytes.toString('utf8'));
const cardinalitySuite = JSON.parse(cardinalityBytes.toString('utf8'));
const strictArgs = ['node', 'runner', '--strict-full-suite', '--endpoint=https://example.supabase.co/functions/v1/preview'];

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
    () => resolveEndpoint(['node', 'runner', '--endpoint=']),
    /non-empty URL/,
  );
  assert.throws(
    () => resolveEndpoint(['node', 'runner', '--endpoint=http://example.com/functions/v1/preview']),
    /HTTPS/,
  );
  assert.throws(
    () => resolveEndpoint(['node', 'runner', '--endpoint=https://example.com/not-a-function']),
    /one Edge Function/,
  );
});

test('CLI help and unknown options never start a live production acceptance run', () => {
  assert.equal(validateCliArgs(['node', 'runner', '--help']), 'help');
  assert.throws(
    () => validateCliArgs(['node', 'runner']),
    /explicit --endpoint=/,
  );
  assert.throws(
    () => validateCliArgs(['node', 'runner', '--hepl']),
    /Unknown or incomplete acceptance option/,
  );
  assert.equal(
    validateCliArgs(['node', 'runner', '--endpoint=https://example.com/functions/v1/preview', '--case=one']),
    'run',
  );
});

test('suite defaults are inherited and explicit turn expectations win', () => {
  assert.deepEqual(
    resolveExpectations({ max_duration_ms: 30_000, max_products: 5 }, { max_products: 1 }),
    { max_duration_ms: 30_000, max_products: 1 },
  );
});

test('case variations reuse turn contracts without changing the base execution', () => {
  const testCase = {
    id: 'audit-example',
    turns: [
      { message: 'base first', expect: { max_products: 0 } },
      { message: 'base second', expect: { min_products: 1 } },
    ],
  };
  const executions = resolveCaseExecutions(testCase, [{
    case_id: 'audit-example',
    id: 'rephrased',
    messages: ['variant first', 'variant second'],
  }]);
  assert.deepEqual(executions, [
    { id: 'base', messages: ['base first', 'base second'] },
    { id: 'rephrased', messages: ['variant first', 'variant second'] },
  ]);
});

test('case variation must preserve the source turn count', () => {
  assert.throws(
    () => resolveCaseExecutions(
      { id: 'audit-example', turns: [{ message: 'first' }, { message: 'second' }] },
      [{ case_id: 'audit-example', id: 'broken', messages: ['only one'] }],
    ),
    /one message per turn/,
  );
});

test('case variation may override only the expectations changed by its meaning', () => {
  const testCase = {
    id: 'audit-example',
    turns: [{ message: 'show products', expect: { min_products: 1, require_result_cardinality: { target: 4 } } }],
  };
  assert.deepEqual(resolveCaseExecutions(testCase, [{
    case_id: 'audit-example',
    id: 'explicit-many',
    messages: ['show several products'],
    expect_overrides: [{ require_result_cardinality: { target: 5, explicit: true } }],
  }]), [
    { id: 'base', messages: ['show products'] },
    {
      id: 'explicit-many',
      messages: ['show several products'],
      expect_overrides: [{ require_result_cardinality: { target: 5, explicit: true } }],
    },
  ]);
});

test('one variation can be selected without rerunning the base case', () => {
  const testCase = { id: 'audit-example', turns: [{ message: 'base' }] };
  const variants = [{ case_id: 'audit-example', id: 'compact', messages: ['compact'] }];
  assert.deepEqual(selectCaseExecutions(testCase, variants, ['compact']), [
    { id: 'compact', messages: ['compact'] },
  ]);
  assert.throws(
    () => selectCaseExecutions(testCase, variants, ['missing']),
    /unknown variation missing/,
  );
});

test('strict full-suite inventory accepts both complete customer matrices', () => {
  assert.equal(validateStrictFullSuite({
    argv: strictArgs,
    suite: acceptanceSuite,
    variationSuite: null,
    casesPath: '/qa/customer-acceptance-cases.json',
    variantsPath: null,
    suiteBytes: acceptanceBytes,
    variantsBytes: null,
  }).expected_cases, 27);
  const september = validateStrictFullSuite({
    argv: strictArgs,
    suite: septemberSuite,
    variationSuite: septemberVariations,
    casesPath: '/qa/customer-audit-20260921-cases.json',
    variantsPath: '/qa/customer-audit-20260921-variations.json',
    suiteBytes: septemberBytes,
    variantsBytes: septemberVariationBytes,
  });
  assert.deepEqual([
    september.expected_turns_per_base_suite,
    september.expected_runs,
    september.expected_evaluated_turns,
  ], [39, 54, 78]);
});

test('strict full-suite rejects filters, shortened repeats, missing IDs and incomplete September variations', () => {
  const base = {
    argv: strictArgs,
    suite: acceptanceSuite,
    variationSuite: null,
    casesPath: '/qa/customer-acceptance-cases.json',
    variantsPath: null,
    suiteBytes: acceptanceBytes,
    variantsBytes: null,
  };
  for (const flag of ['--case=customer-dn027b-analogs', '--variant=base', '--repeat=1', '--stop-on-failure']) {
    assert.throws(() => validateStrictFullSuite({ ...base, argv: [...strictArgs, flag] }), /forbids/);
  }
  assert.throws(() => validateStrictFullSuite({
    ...base,
    argv: ['node', 'runner', '--strict-full-suite'],
  }), /requires an explicit --endpoint=/);
  assert.throws(() => validateStrictFullSuite({ ...base, suite: {
    ...acceptanceSuite,
    cases: acceptanceSuite.cases.slice(1),
  } }), /expected 27 unique IDs/);
  assert.throws(() => validateStrictFullSuite({ ...base, suite: {
    ...acceptanceSuite,
    cases: [acceptanceSuite.cases[0], ...acceptanceSuite.cases.slice(0, -1)],
  } }), /expected 27 unique IDs/);
  const septemberBase = {
    argv: strictArgs,
    suite: septemberSuite,
    variationSuite: septemberVariations,
    casesPath: '/qa/customer-audit-20260921-cases.json',
    variantsPath: '/qa/customer-audit-20260921-variations.json',
    suiteBytes: septemberBytes,
    variantsBytes: septemberVariationBytes,
  };
  assert.throws(() => validateStrictFullSuite({ ...septemberBase, variantsPath: null }), /requires/);
  assert.throws(() => validateStrictFullSuite({ ...septemberBase, variationSuite: {
    ...septemberVariations,
    variants: septemberVariations.variants.slice(1),
  } }), /expected 27 unique variations/);
  assert.throws(() => validateStrictFullSuite({ ...septemberBase, variationSuite: {
    ...septemberVariations,
    variants: [{ ...septemberVariations.variants[0], case_id: septemberSuite.cases[1].id }, ...septemberVariations.variants.slice(1)],
  } }), /must cover/);
});

test('strict full-suite detects changed assertions and semantic variation messages by source hash', () => {
  const changedExpectations = structuredClone(acceptanceSuite);
  changedExpectations.cases[0].turns[0].expect = {};
  assert.throws(() => validateStrictFullSuite({
    argv: strictArgs,
    suite: changedExpectations,
    variationSuite: null,
    casesPath: '/qa/customer-acceptance-cases.json',
    variantsPath: null,
    suiteBytes: Buffer.from(JSON.stringify(changedExpectations)),
    variantsBytes: null,
  }), /SHA256 mismatch/);
  const changedVariations = structuredClone(septemberVariations);
  changedVariations.variants[0].messages = ['Найди что-нибудь'];
  assert.throws(() => validateStrictFullSuite({
    argv: strictArgs,
    suite: septemberSuite,
    variationSuite: changedVariations,
    casesPath: '/qa/customer-audit-20260921-cases.json',
    variantsPath: '/qa/customer-audit-20260921-variations.json',
    suiteBytes: septemberBytes,
    variantsBytes: Buffer.from(JSON.stringify(changedVariations)),
  }), /variations\.json SHA256 mismatch/);
});

test('strict full-suite verifies all Notion legacy and systemic cardinality runs', () => {
  const notion = validateStrictFullSuite({
    argv: strictArgs,
    suite: notionSuite,
    variationSuite: null,
    casesPath: '/qa/notion-legacy-bug-cases.json',
    variantsPath: null,
    suiteBytes: notionBytes,
    variantsBytes: null,
  });
  assert.deepEqual([notion.expected_cases, notion.expected_turns_per_base_suite, notion.expected_runs, notion.expected_evaluated_turns], [30, 31, 34, 35]);
  const cardinality = validateStrictFullSuite({
    argv: strictArgs,
    suite: cardinalitySuite,
    variationSuite: null,
    casesPath: '/qa/systemic-cardinality-cases.json',
    variantsPath: null,
    suiteBytes: cardinalityBytes,
    variantsBytes: null,
  });
  assert.deepEqual([cardinality.expected_cases, cardinality.expected_turns_per_base_suite, cardinality.expected_runs, cardinality.expected_evaluated_turns], [5, 5, 15, 15]);
});

test('strict full-suite rejects missing, swapped, or changed-repeat Notion and cardinality cases', () => {
  const notionArgs = {
    argv: strictArgs,
    suite: notionSuite,
    variationSuite: null,
    casesPath: '/qa/notion-legacy-bug-cases.json',
    variantsPath: null,
    suiteBytes: notionBytes,
    variantsBytes: null,
  };
  assert.throws(() => validateStrictFullSuite({ ...notionArgs, suite: {
    ...notionSuite, cases: notionSuite.cases.slice(1),
  } }), /expected 30 unique IDs/);
  assert.throws(() => validateStrictFullSuite({ ...notionArgs, suite: {
    ...notionSuite,
    cases: notionSuite.cases.map((item) => item.id === 'bt925-corn-e27' ? { ...item, repeat: 1 } : item),
  } }), /invalid repeats=bt925-corn-e27/);
  assert.throws(() => validateStrictFullSuite({ ...notionArgs, suite: {
    ...notionSuite,
    cases: notionSuite.cases.map((item) => item.id === 'bt924-acti9-followup-show' ? { ...item, turns: item.turns.slice(0, 1) } : item),
  } }), /invalid turns=bt924-acti9-followup-show/);
  const cardinalityArgs = {
    ...notionArgs,
    suite: cardinalitySuite,
    casesPath: '/qa/systemic-cardinality-cases.json',
    suiteBytes: cardinalityBytes,
  };
  assert.throws(() => validateStrictFullSuite({ ...cardinalityArgs, suite: {
    ...cardinalitySuite, cases: cardinalitySuite.cases.slice(1),
  } }), /expected 5 unique IDs/);
  assert.throws(() => validateStrictFullSuite({ ...cardinalityArgs, suite: {
    ...cardinalitySuite,
    cases: cardinalitySuite.cases.map((item) => item.id === 'cardinality-multiple-sockets' ? { ...item, repeat: 1 } : item),
  } }), /invalid repeats=cardinality-multiple-sockets/);
});

test('acceptance transport retries one transient stream interruption with the same payload', async () => {
  const calls = [];
  const payload = { message: 'test', messageId: 'stable-id' };
  const result = await fetchAcceptanceTurn(payload, {
    retryDelayMs: 0,
    fetchImpl: async (_url, init) => {
      calls.push(JSON.parse(init.body));
      if (calls.length === 1) {
        const error = new TypeError('terminated');
        error.cause = Object.assign(new Error('read ETIMEDOUT'), { code: 'ETIMEDOUT' });
        throw error;
      }
      return new Response('data: [DONE]\n\n', { status: 200 });
    },
  });
  assert.equal(result.attempts, 2);
  assert.equal(result.raw, 'data: [DONE]\n\n');
  assert.deepEqual(calls, [payload, payload]);
});

test('acceptance transport bounds a hung fetch and aborts it', async () => {
  assert.equal(ACCEPTANCE_TURN_TIMEOUT_MS, 55_000);
  let signal;
  await assert.rejects(fetchAcceptanceTurn({ message: 'test' }, {
    timeoutMs: 20,
    fetchImpl: async (_url, init) => {
      signal = init.signal;
      return await new Promise(() => {});
    },
  }), (error) => error.code === 'ACCEPTANCE_TURN_TIMEOUT' && error.attempts === 1);
  assert.equal(signal.aborted, true);
});

test('acceptance transport bounds a response body reader that ignores abort', async () => {
  await assert.rejects(fetchAcceptanceTurn({ message: 'test' }, {
    timeoutMs: 20,
    fetchImpl: async () => ({ text: async () => await new Promise(() => {}) }),
  }), (error) => error.code === 'ACCEPTANCE_TURN_TIMEOUT');
});

test('catalog URL candidates are unique and external hosts never count', () => {
  assert.equal(productUrlIdentity('https://www.220volt.kz/catalog/a/b/item/?utm_source=qa#details'), '220volt.kz/catalog/a/b/item');
  assert.equal(productUrlIdentity('https://220volt.kz/catalog/svetotexnika/lampyi/lampa-led-corn/'), '220volt.kz/catalog/svetotexnika/lampyi/lampa-led-corn');
  assert.equal(productUrlIdentity('https://220volt.kz/catalog/kabeli/prokladka/trubki/trubka-termo-nst-14-7/'), '220volt.kz/catalog/kabeli/prokladka/trubki/trubka-termo-nst-14-7');
  assert.equal(productUrlIdentity('https://220volt.kz/catalog/svetotexnika/svetilniki/'), null);
  assert.equal(productUrlIdentity('https://220volt.kz/catalog/svetotexnika/'), null);
  assert.equal(productUrlIdentity('https://220volt.kz/dostavka/'), null);
  assert.equal(productUrlIdentity('https://220volt.kz.evil.example/catalog/a/item/'), null);
  assert.equal(productUrlIdentity('http://220volt.kz/catalog/a/item/'), null);
  const response = {
    text: '', productsMarkdown: '', completed: true, diagnosticError: null, serverProductsCount: 3,
    links: [
      { title: 'Первый', url: 'https://220volt.kz/catalog/a/b/item/' },
      { title: 'Тот же', url: 'https://www.220volt.kz/catalog/a/b/item/?tracking=1' },
      { title: 'Внешний', url: 'https://220volt.kz.evil.example/catalog/other/' },
    ],
  };
  const failures = evaluate({ min_products: 2 }, response);
  assert(failures.includes('products 1 < 2'));
  assert(failures.some((failure) => failure.startsWith('duplicate product URL(s):')));
  assert(failures.some((failure) => failure.startsWith('invalid 220volt.kz product URL(s):')));
});

test('strict product proof requires matching JSON-LD Product/@id/name/sku, not a deep category URL', () => {
  const productUrl = 'https://220volt.kz/catalog/kabeli/prokladka/trubki/trubka-nst-14-7/';
  const identity = productUrlIdentity(productUrl);
  const productHtml = `<script type="application/ld+json">${JSON.stringify({
    '@context': 'https://schema.org', '@type': 'Product', '@id': productUrl,
    name: 'Трубка NST 14/7', sku: 'Ем000000001',
  })}</script>`;
  const categoryHtml = `<script type="application/ld+json">${JSON.stringify({
    '@context': 'https://schema.org', '@type': 'ItemList', '@id': productUrl,
    itemListElement: [{ '@type': 'Product', name: 'Related item', sku: 'other' }],
  })}</script>`;
  assert.deepEqual(productProofFromHtml(productHtml, identity), {
    sku: 'Ем000000001', name: 'Трубка NST 14/7', facets: {}, description: '',
  });
  assert.equal(productProofFromHtml(categoryHtml, identity), null);
  assert.equal(productProofFromHtml(productHtml.replace('Ем000000001', ''), identity), null);
  assert.equal(productProofFromHtml(productHtml.replace(productUrl, 'https://220volt.kz/catalog/other/item/'), identity), null);
});

test('live product verification is bounded, cached and fails closed on categories or redirects', async () => {
  const productUrl = 'https://220volt.kz/catalog/a/b/item/';
  const categoryUrl = 'https://220volt.kz/catalog/a/b/deep-category/';
  const productHtml = `<script type="application/ld+json">${JSON.stringify({
    '@context': 'https://schema.org', '@type': 'Product', '@id': productUrl,
    name: 'Розетка двойная', sku: 'SKU-123',
  })}</script>`;
  const categoryHtml = `<script type="application/ld+json">${JSON.stringify({
    '@context': 'https://schema.org', '@type': 'ItemList', itemListElement: [],
  })}</script>`;
  let fetches = 0;
  const fetchImpl = async (url, options) => {
    fetches++;
    assert.equal(options.redirect, 'manual');
    assert.equal(options.credentials, 'omit');
    return new Response(url === productUrl ? productHtml : categoryHtml, {
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
    });
  };
  const cache = new Map();
  const links = [
    { title: 'Розетка двойная', url: productUrl },
    { title: 'Та же розетка', url: 'https://www.220volt.kz/catalog/a/b/item/?utm_source=qa' },
    { title: 'Раздел трубок', url: categoryUrl },
  ];
  const proof = await verifyProductLinks(links, { fetchImpl, cache });
  assert.equal(fetches, 2);
  assert.equal(proof.get(productUrlIdentity(productUrl)).sku, 'SKU-123');
  assert.equal(proof.get(productUrlIdentity(categoryUrl)).verified, false);
  await verifyProductLinks(links, { fetchImpl, cache });
  assert.equal(fetches, 2);
  const failures = evaluate({ min_products: 2 }, {
    text: '', productsMarkdown: '', links, completed: true, diagnosticError: null,
    serverProductsCount: 3, verifiedProductPages: proof,
  }, { requireVerifiedPages: true });
  assert(failures.includes('products 1 < 2'));
  assert(failures.some((failure) => failure.startsWith('unverified product page(s):')));
  assert(failures.some((failure) => failure.startsWith('duplicate product URL(s):')));
  const redirect = await verifyProductPage(productUrl, {
    fetchImpl: async () => new Response(null, { status: 302, headers: { Location: 'https://example.com/' } }),
  });
  assert.equal(redirect.verified, false);
  assert.match(redirect.reason, /HTTP 302/u);
  const hanging = await verifyProductPage(productUrl, {
    timeoutMs: 15,
    fetchImpl: async () => await new Promise(() => {}),
  });
  assert.equal(hanging.verified, false);
  assert.match(hanging.reason, /deadline/u);
});

test('source-backed household and motion contract rejects acoustic-only and ЖКХ cards', async () => {
  const rule = {
    facets: [{ name: 'Вид светильника', require_any: ['бытов'] }],
    description: { require_any: ['движущ', 'движен', 'motion', 'PIR'] },
  };
  const productHtml = ({ url, sku, type, description }) => `
    <script type="application/ld+json">${JSON.stringify({
      '@context': 'https://schema.org', '@type': 'Product', '@id': url,
      name: `Светильник ${sku}`, sku,
    })}</script>
    <div class="product__tab-description-item">
      <div class="product__description-title">Вид светильника:</div>
      <p class="product__tab-description-text">${type}</p>
    </div>
    <div class="product__tab-description-item">
      <div class="product__description-title">С датчиком движения:</div>
      <p class="product__tab-description-text">да</p>
    </div>
    <div class="product-item__tab-content" data-tab-content="description">${description}</div>
  `;
  const entries = [
    { url: 'https://220volt.kz/catalog/svetotexnika/svetilniki/gauss-hall/', sku: 'GAUSS',
      type: 'бытовые светильники накладные',
      description: 'Микроволновый сенсор включает светильник при появлении движущихся объектов.' },
    { url: 'https://220volt.kz/catalog/svetotexnika/svetilniki/iek-acoustic/', sku: 'IEK',
      type: 'бытовые светильники накладные',
      description: 'Оптико-акустический датчик, реагирующий на звук.' },
    { url: 'https://220volt.kz/catalog/svetotexnika/svetilniki/utility/', sku: 'UTILITY',
      type: 'светильники для ЖКХ',
      description: 'Включается при обнаружении движения.' },
  ];
  const htmlByUrl = new Map(entries.map((entry) => [entry.url, productHtml(entry)]));
  const links = entries.map((entry) => ({ title: `Светильник ${entry.sku}`, url: entry.url }));
  const verifiedProductPages = await verifyProductLinks(links, {
    fetchImpl: async (url) => new Response(htmlByUrl.get(url), { headers: { 'Content-Type': 'text/html' } }),
  });
  const gaussOnly = evaluate({ min_products: 1, require_every_product_page: rule }, {
    text: '', productsMarkdown: '', links: links.slice(0, 1),
    completed: true, diagnosticError: null, serverProductsCount: 1,
    verifiedProductPages,
  });
  assert.deepEqual(gaussOnly, []);
  const mixed = evaluate({ min_products: 3, require_every_product_page: rule }, {
    text: '', productsMarkdown: '', links,
    completed: true, diagnosticError: null, serverProductsCount: 3,
    verifiedProductPages,
  });
  assert(mixed.some((failure) => failure.includes('product IEK description')));
  assert(mixed.some((failure) => failure.includes('product UTILITY facet Вид светильника')));
  assert(!mixed.some((failure) => failure.startsWith('products 2 <')));
  const missingPageProof = evaluate({ min_products: 1, require_every_product_page: rule }, {
    text: '', productsMarkdown: '', links: links.slice(0, 1),
    completed: true, diagnosticError: null, serverProductsCount: 1,
  });
  assert(missingPageProof.some((failure) => failure.startsWith('unverified product page(s):')));
  const emptyRule = evaluate({ min_products: 1, require_every_product_page: {} }, {
    text: '', productsMarkdown: '', links: links.slice(0, 1),
    completed: true, diagnosticError: null, serverProductsCount: 1,
    verifiedProductPages,
  });
  assert(emptyRule.includes('invalid product-page source evidence contract'));
});

test('source-backed numeric and exact facet checks reject underpowered and non-copper products', () => {
  const floodlightUrl = 'https://220volt.kz/catalog/svetotexnika/prozhektoryi/floodlight/';
  const cableUrl = 'https://220volt.kz/catalog/kabeli/prokladka/cable/';
  const proofs = new Map([
    [productUrlIdentity(floodlightUrl), {
      verified: true, sku: 'FLOOD-10', facets: { 'Световой поток, Лм': '800' }, description: '',
    }],
    [productUrlIdentity(cableUrl), {
      verified: true, sku: 'CCA-PVC', facets: { 'Материал проводника': 'CCA', 'Оболочка': 'PVC' }, description: '',
    }],
  ]);
  const base = { text: '', productsMarkdown: '', completed: true, diagnosticError: null, serverProductsCount: 1, verifiedProductPages: proofs };
  const floodlightFailures = evaluate({ require_every_product_page: {
    facets: [{ name: 'Световой поток, Лм', min_numeric: 1800 }],
  } }, { ...base, links: [{ title: 'Прожектор 10 W', url: floodlightUrl }] });
  assert(floodlightFailures.some((failure) => failure.includes('FLOOD-10 facet Световой поток, Лм: source numeric value 800 < 1800')));
  const cableFailures = evaluate({ require_every_product_page: {
    facets: [
      { name: 'Материал проводника', exact_any: ['медь'] },
      { name: 'Оболочка', exact_any: ['PE', 'LDPE'] },
    ],
  } }, { ...base, links: [{ title: 'Кабель витая пара', url: cableUrl }] });
  assert(cableFailures.some((failure) => failure.includes('CCA-PVC facet Материал проводника')));
  assert(cableFailures.some((failure) => failure.includes('CCA-PVC facet Оболочка')));
});

test('product-or-explicit-gap and class-or-gap contracts cannot pass vacuously', () => {
  const empty = { text: 'Для котла нужен ИБП с чистой синусоидой.', productsMarkdown: '', links: [], completed: true, diagnosticError: null };
  const ups = { require_products_or_text_groups: {
    min_products: 1,
    text_groups: [['не нашёл', 'не найден'], ['ИБП'], ['каталог']],
  } };
  assert(evaluate(ups, empty).some((failure) => failure.includes('without an explicit evidence gap')));
  assert.deepEqual(evaluate(ups, { ...empty, text: 'Не нашёл в каталоге подтверждённый ИБП для котла.' }), []);
  const gallant = { require_product_groups_or_gap: [
    { title_groups: [['розет']], gap_text_groups: [['розет'], ['не нашёл']] },
    { title_groups: [['выключател']], gap_text_groups: [['выключател'], ['не нашёл']] },
  ] };
  const sockets = [{ title: 'Розетка Gallant' }];
  assert(evaluate(gallant, { ...empty, links: sockets, serverProductsCount: 1 }).some((failure) => failure.includes('missing product class or explicit gap')));
  assert.deepEqual(evaluate(gallant, {
    ...empty, links: sockets, serverProductsCount: 1,
    text: 'Выключатели Gallant не нашёл в каталоге.',
  }), []);
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
    cardText: '- **[Товар 1P 16А х-ка C](https://220volt.kz/catalog/a/b/item-%28x%29/)**\n  Цена: *1 234* ₸/уп',
  }]);
  assert.equal(parsed.completed, true);
  assert.equal(parsed.serverProductsCount, 1);
});

test('parseSse preserves safe tool progress for acceptance diagnostics', () => {
  const body = [
    `data: ${JSON.stringify({ v3_event: { type: 'tool_event', tool: 'search_catalog', phase: 'result', summary: 'Найдено 3', duration_ms: 125 } })}`,
    'data: [DONE]',
  ].join('\n\n');
  assert.deepEqual(parseSse(body).toolEvents, [
    { tool: 'search_catalog', phase: 'result', summary: 'Найдено 3', duration_ms: 125 },
  ]);
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

test('parseSse preserves server-issued slots for the next acceptance turn', () => {
  const slots = {
    pending_clarification: {
      facet_key: 'catalog_section',
      scope: { kind: 'broad_assortment', token: 'Example' },
    },
  };
  const result = parseSse([
    `data: ${JSON.stringify({ v3_event: { type: 'slot_update', slots } })}`,
    'data: [DONE]',
  ].join('\n'));
  assert.deepEqual(result.dialogSlots, slots);
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

test('evaluate can verify identity from the complete rendered card', () => {
  const response = {
    text: '',
    textBeforeProducts: '',
    productsMarkdown: '',
    links: [{
      title: 'Автомат 3P 16A',
      cardText: 'Автомат 3P 16A\nБренд: Schneider Electric',
    }],
    completed: true,
    diagnosticError: null,
    serverProductsCount: 1,
  };
  assert.deepEqual(evaluate({ require_every_product_card_groups: [['Schneider'], ['3P'], ['16A']] }, response), []);
  assert(evaluate({ require_every_product_card_groups: [['IEK'], ['3P'], ['16A']] }, response)
    .some((failure) => failure.startsWith('product cards violate required groups')));
});

test('parseSse and evaluate preserve the server selection contract', () => {
  const contract = {
    hash: 'selection-test',
    mandatory_criteria: [
      { key: 'Количество разъемов', op: 'eq', value: '2', evidence: 'user_explicit' },
      { key: 'Цвет', op: 'eq', value: 'чёрный', evidence: 'derived_required' },
    ],
    visible_requirements: [
      { kind: 'count', label: 'двойная розетка', op: 'eq', value: 2 },
    ],
    result_cardinality: {
      target: 5,
      minimum: 3,
      mode: 'alternatives',
      explicit: true,
    },
  };
  const parsed = parseSse([
    data({ v3_event: {
      type: 'products_block',
      markdown: '- **[Розетка РС 16-343 черный](https://220volt.kz/catalog/elektrika/rozetki/rozetka-rs-16-343/)**\n  Цена: *900* ₸',
      selection_contract: contract,
    } }),
    data({ v3_event: { type: 'diagnostic', phase: 'complete', products_count: 1 } }),
    'data: [DONE]',
  ].join('\n'));
  assert.deepEqual(parsed.selectionContract, contract);
  assert.deepEqual(evaluate({
    require_selection_criteria_groups: [
      ['Количество разъемов'], ['"value":"2"'], ['Цвет'], ['черн'],
      ['user_explicit'], ['derived_required'],
    ],
  }, parsed), []);
  assert.deepEqual(evaluate({
    require_selection_criteria_groups: [['"kind":"count"'], ['"value":2']],
  }, parsed), []);
  assert(evaluate({ require_selection_criteria_groups: [['Количество разъемов'], ['"value":"1"']] }, parsed)
    .some((failure) => failure.startsWith('selection contract misses required groups')));
  assert.deepEqual(evaluate({ require_selection_criteria_evidence: true }, parsed), []);
  assert.deepEqual(evaluate({
    require_result_cardinality: {
      target: 5,
      minimum: 3,
      mode: 'alternatives',
      explicit: true,
    },
  }, parsed), []);
  assert(evaluate({ require_result_cardinality: { target: 1 } }, parsed)
    .includes('result cardinality target=5 != 1'));
  assert(evaluate({ require_selection_criteria_evidence: true }, {
    ...parsed,
    selectionContract: {
      ...contract,
      mandatory_criteria: [{ key: 'Случайное поле', op: 'eq', value: '1', evidence: 'catalog_verified' }],
    },
  }).some((failure) => failure.startsWith('mandatory selection criteria have invalid evidence')));
});

test('evaluate accepts either a true exact intersection or an explicitly labelled axis split', () => {
  const contract = {
    require_exact_or_split: {
      exact_title_groups: [['CORN'], ['E27']],
      split_title_groups: [['CORN'], ['E27']],
      split_text_groups: [['одновременно'], ['не нашлось'], ['отдельно']],
    },
  };
  const base = {
    textBeforeProducts: '',
    productsMarkdown: '',
    completed: true,
    diagnosticError: null,
  };
  assert.deepEqual(evaluate(contract, {
    ...base,
    text: 'Нашёл точное сочетание.',
    links: [{ title: 'Лампа LED CORN E27' }],
    serverProductsCount: 1,
  }), []);
  assert.deepEqual(evaluate(contract, {
    ...base,
    text: 'Одновременно условий не нашлось, поэтому показываю отдельно.',
    links: [{ title: 'Лампа LED CORN G4' }, { title: 'Лампа LED A60 E27' }],
    serverProductsCount: 2,
  }), []);
  assert(evaluate(contract, {
    ...base,
    text: 'Показываю варианты.',
    links: [{ title: 'Лампа LED CORN G4' }, { title: 'Лампа LED A60 E27' }],
    serverProductsCount: 2,
  }).includes('neither exact product nor evidence-labelled split alternatives were returned'));
});

test('evaluate can forbid unsupported prose without rejecting evidence in product titles', () => {
  const response = {
    text: 'Показываю подтверждённые варианты.',
    textBeforeProducts: 'Показываю подтверждённые варианты.',
    productsMarkdown: '',
    links: [{ title: 'Лампа LED CORN E27' }],
    completed: true,
    diagnosticError: null,
    serverProductsCount: 1,
  };
  assert.deepEqual(evaluate({ forbid_assistant_text: ['E27'] }, response), []);
  assert(evaluate({ forbid_assistant_text: ['E27'] }, {
    ...response,
    text: 'В каталоге есть E27.',
  }).includes('forbidden assistant text: E27'));
});

test('evaluate rejects a sibling taxonomy branch hidden from user-facing prose', () => {
  const response = {
    text: 'Подбираю ИБП.',
    textBeforeProducts: 'Подбираю ИБП.',
    productsMarkdown: '',
    links: [],
    completed: true,
    diagnosticError: null,
    serverProductsCount: 0,
    toolEvents: [{ tool: 'discover_category', phase: 'result', summary: 'категория «Стабилизаторы»: 112 тов.' }],
  };
  assert(evaluate({ forbid_tool_summary: ['Стабилизаторы'] }, response)
    .includes('forbidden tool summary: Стабилизаторы'));
});

test('evaluate validates a generic strict numeric pair around the object size', () => {
  const base = {
    text: '',
    textBeforeProducts: '',
    productsMarkdown: '',
    completed: true,
    diagnosticError: null,
    serverProductsCount: 2,
  };
  assert.deepEqual(evaluate({ require_every_product_pair_around: 12 }, {
    ...base,
    links: [
      { title: 'Изделие 13,0/6,5 мм' },
      { title: 'Изделие 16/8 мм' },
    ],
  }), []);
  const failures = evaluate({ require_every_product_pair_around: 12 }, {
    ...base,
    serverProductsCount: 1,
    links: [{ title: 'Изделие 12/6 мм' }],
  });
  assert(failures.some((failure) => failure.includes('does not strictly surround 12')));
});

test('evaluate enforces a measured lower bound in every product title', () => {
  const base = {
    text: '',
    textBeforeProducts: '',
    productsMarkdown: '',
    completed: true,
    diagnosticError: null,
    serverProductsCount: 2,
  };
  const contract = { require_every_product_measurement: { min: 100, units: ['Вт', 'W'], allow_compact_numeric: true } };
  assert.deepEqual(evaluate(contract, {
    ...base,
    links: [{ title: 'Изделие 100 Вт' }, { title: 'Изделие 06-150' }],
  }), []);
  assert.deepEqual(evaluate(contract, {
    ...base,
    links: [{ title: 'Изделие 06-100' }, { title: 'Изделие 2x50' }],
  }), []);
  const failures = evaluate(contract, {
    ...base,
    links: [{ title: 'Изделие 06-100 10 Вт' }, { title: 'Изделие без мощности' }],
  });
  assert(failures.some((failure) => failure.startsWith('product title measurement violates contract')));
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

test('evaluate enforces a production response-time budget', () => {
  const response = {
    text: 'Готово',
    productsMarkdown: '',
    links: [],
    completed: true,
    diagnosticError: null,
    serverProductsCount: 0,
    durationMs: 30_001,
  };

  assert.deepEqual(evaluate({ max_duration_ms: 30_000 }, response), [
    'duration 30001ms > 30000ms',
  ]);
  assert.deepEqual(evaluate({ max_duration_ms: 35_000 }, response), []);
});

test('evaluate rejects inferred selection criteria that the customer did not request', () => {
  const response = {
    text: 'Нашёл варианты.',
    productsMarkdown: '',
    links: [],
    completed: true,
    diagnosticError: null,
    serverProductsCount: 0,
    selectionContract: {
      mandatory_criteria: [
        { key: 'С датчиком движения', op: 'eq', value: 'да' },
        { key: 'Вид светильника', op: 'eq', value: 'светильники для ЖКХ' },
      ],
    },
  };

  assert(evaluate({ forbid_selection_criteria_any: ['ЖКХ'] }, response)
    .includes('forbidden selection criterion: ЖКХ'));
  assert.deepEqual(evaluate({ forbid_selection_criteria_any: ['уличный'] }, response), []);
});

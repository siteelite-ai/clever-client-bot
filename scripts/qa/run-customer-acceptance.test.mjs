import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

import {
  ACCEPTANCE_TURN_TIMEOUT_MS, DEFAULT_ENDPOINT, evaluate, fetchAcceptanceTurn,
  parseSse, productProofFromHtml, productUrlIdentity, resolveCaseExecutions,
  resolveEndpoint, resolveExpectations, selectCaseExecutions, validateStrictFullSuite,
  validateCliArgs, validateExpectationObject, validateExpectationSuite,
  verifyProductLinks, verifyProductPage,
} from './run-customer-acceptance.mjs';

const acceptanceBytes = fs.readFileSync(new URL('./customer-acceptance-cases.json', import.meta.url));
const septemberBytes = fs.readFileSync(new URL('./customer-audit-20260921-cases.json', import.meta.url));
const septemberVariationBytes = fs.readFileSync(new URL('./customer-audit-20260921-variations.json', import.meta.url));
const notionBytes = fs.readFileSync(new URL('./notion-legacy-bug-cases.json', import.meta.url));
const notionV2Bytes = fs.readFileSync(new URL('./notion-legacy-bug-cases-v2.json', import.meta.url));
const notionV3Bytes = fs.readFileSync(new URL('./notion-legacy-bug-cases-v3.json', import.meta.url));
const cardinalityBytes = fs.readFileSync(new URL('./systemic-cardinality-cases.json', import.meta.url));
const acceptanceSuite = JSON.parse(acceptanceBytes.toString('utf8'));
const septemberSuite = JSON.parse(septemberBytes.toString('utf8'));
const septemberVariations = JSON.parse(septemberVariationBytes.toString('utf8'));
const notionSuite = JSON.parse(notionBytes.toString('utf8'));
const notionV2Suite = JSON.parse(notionV2Bytes.toString('utf8'));
const notionV3Suite = JSON.parse(notionV3Bytes.toString('utf8'));
const cardinalitySuite = JSON.parse(cardinalityBytes.toString('utf8'));
const strictArgs = ['node', 'runner', '--strict-full-suite', '--endpoint=https://example.supabase.co/functions/v1/preview'];

test('all pinned VVG cheapest cases require an independent complete-category minimum', () => {
  const cases = [
    [acceptanceSuite, 'customer-vvg-exact-cheapest', '2-1.5'],
    [septemberSuite, 'audit-01-vvg-3x1_5-cheapest', '3-1.5'],
    [notionV2Suite, 'bt923-vvg-3x1_5-unit', '3-1.5'],
    [cardinalitySuite, 'cardinality-single-superlative', '2-1.5'],
  ];
  for (const [suite, id, category] of cases) {
    const expectation = suite.cases.find((entry) => entry.id === id)?.turns[0].expect;
    assert(expectation, id);
    assert.equal(expectation.require_catalog_minimum.source_url.endsWith(`/kabel-vvg/${category}/`), true, id);
    assert.equal(expectation.require_catalog_minimum.unit, 'м', id);
    assert.doesNotThrow(() => validateExpectationObject(expectation), id);
  }
  for (const contract of [{}, { source_url: 'https://evil.example/catalog/x/y/z/', title_prefix: 'Кабель ВВГ 3*1,5', unit: 'м' },
    { source_url: 'https://220volt.kz/catalog/x/y/z/', title_prefix: 'ВВГ', unit: 'м' },
    { source_url: 'https://220volt.kz/catalog/x/y/z/', title_prefix: 'Кабель ВВГ 3*1,5', unit: 'м', allow_partial: true }]) {
    assert.throws(() => validateExpectationObject({ require_catalog_minimum: contract }), /require_catalog_minimum/u);
  }
});

test('catalog-minimum acceptance rejects a plausible but non-cheapest exact cable card', () => {
  const bestUrl = 'https://220volt.kz/catalog/cables/vvg/product-301/';
  const worseUrl = 'https://220volt.kz/catalog/cables/vvg/product-462/';
  const sourceUrl = 'https://220volt.kz/catalog/cables/vvg/3-1.5/';
  const criterion = { require_catalog_minimum: {
    source_url: sourceUrl, title_prefix: 'Кабель ВВГ 3*1,5', unit: 'м',
  } };
  const items = [
    { url: bestUrl, title: 'Кабель ВВГ 3*1,5 ГОСТ IK', price: 301, unit: 'м', id: '301' },
    { url: worseUrl, title: 'Кабель ВВГ 3*1,5 AT', price: 462, unit: 'м', id: '462' },
  ];
  const page = (item) => ({ identity: productUrlIdentity(item.url), verified: true,
    sku: item.id, name: item.title, offerPrice: item.price,
    availability: 'https://schema.org/InStock' });
  const reply = (item) => ({
    links: [{ url: item.url, title: item.title, price: item.price, stockLine: 'Караганда (98 м)' }],
    text: '', productsMarkdown: '', terminalDiagnosticSeen: true, logId: 'test-id', completed: true,
    verifiedProductPages: new Map([[productUrlIdentity(item.url), page(item)]]),
    catalogMinimumProof: { verified: true, source_url: sourceUrl, listed_total: 2,
      matching_available: 2, eligible_products: items, minimum_price: 301, winners: [items[0]] },
  });
  assert.deepEqual(evaluate(criterion, reply(items[0])), []);
  assert(evaluate(criterion, reply(items[1])).some((failure) => failure.includes('not a catalog-proven minimum')));
  assert(evaluate(criterion, { ...reply(items[0]), catalogMinimumProof: null })
    .some((failure) => failure.includes('not independently verified')));
  assert(evaluate(criterion, { ...reply(items[0]), catalogMinimumProof: {
    ...reply(items[0]).catalogMinimumProof, eligible_products: [items[1]],
  } }).some((failure) => failure.includes('no valid winner')));
  assert(evaluate(criterion, { ...reply(items[0]), verifiedProductPages: new Map() })
    .some((failure) => failure.includes('unverified product page')));
});

test('household motion scenarios require several source-backed alternatives across catalog classes', () => {
  for (const id of [
    'customer-new-household-motion-without-mount',
    'customer-new-household-motion-joined-currency',
  ]) {
    const scenario = acceptanceSuite.cases.find((item) => item.id === id);
    assert(scenario, `missing ${id}`);
    const expected = scenario.turns[0].expect;
    assert.equal(expected.min_products, 3);
    assert.equal(expected.require_products_or_text_groups, undefined);
    assert.equal(expected.max_product_price, 4000);
    assert.equal(expected.require_every_product_page.all_of.length, 2);
    assert(expected.require_every_product_page.all_of.every((rule) => rule.any_of.length >= 2));
  }
});

test('replacement-light and TTU acceptance cannot pass on plausible but wrong products', () => {
  for (const [id, area] of [
    ['customer-chandelier-30m2', 30],
    ['customer-new-chandelier-25m2', 25],
  ]) {
    const scenario = acceptanceSuite.cases.find((item) => item.id === id);
    const rule = scenario.turns[0].expect.require_every_product_page;
    assert(rule, `missing source proof for ${id}`);
    const url = `https://220volt.kz/catalog/svetotexnika/lyustryi/${id}/`;
    const identity = productUrlIdentity(url);
    const base = {
      text: '', productsMarkdown: '', links: [{ title: 'Люстра светодиодная 90W', url }],
      completed: true, diagnosticError: null, serverProductsCount: 1,
    };
    const proof = {
      verified: true, sku: id, name: 'Люстра светодиодная 90W', description: '',
      facets: { 'Назначение': 'офис', 'Максимальная площадь освещения, м2': String(area + 10) },
    };
    const verifiedProductPages = new Map([[identity, proof]]);
    assert(evaluate({ require_every_product_page: rule }, { ...base, verifiedProductPages })
      .some((failure) => failure.includes('facet Назначение')));
    verifiedProductPages.set(identity, {
      ...proof,
      facets: { 'Назначение': 'гостиная', 'Максимальная площадь освещения, м2': String(area - 5) },
    });
    assert(evaluate({ require_every_product_page: rule }, { ...base, verifiedProductPages })
      .some((failure) => failure.includes('Максимальная площадь')));
    verifiedProductPages.set(identity, {
      ...proof,
      facets: { 'Назначение': 'гостиная', 'Максимальная площадь освещения, м2': String(area) },
    });
    assert.deepEqual(evaluate({ require_every_product_page: rule }, { ...base, verifiedProductPages }), []);
  }

  const ttu = acceptanceSuite.cases.find((item) => item.id === 'customer-new-heat-shrink-10mm');
  const titleRule = ttu.turns[0].expect.require_every_product_title_any;
  assert(titleRule?.some((fragment) => fragment.toLocaleLowerCase('ru-RU') === 'тту'));
  const base = { text: '', productsMarkdown: '', completed: true, diagnosticError: null, serverProductsCount: 1 };
  assert(evaluate({ require_every_product_title_any: titleRule }, {
    ...base, links: [{ title: 'Трубка Navigator NST-12/6' }],
  }).some((failure) => failure.includes('required fragment')));
  assert.deepEqual(evaluate({ require_every_product_title_any: titleRule }, {
    ...base, links: [{ title: 'Трубка ТТУ 12/6 IEK' }],
  }), []);
});

function data(payload) {
  return `data: ${JSON.stringify(payload)}`;
}

function batteryReply(reply, cardPrice = 1234) {
  const priceLine = cardPrice === null ? '' : `\n  Цена: *${String(cardPrice).replace(/\B(?=(\d{3})+(?!\d))/gu, ' ')}* ₸`;
  return parseSse([
    data({ choices: [{ delta: { content: reply } }] }),
    ...(cardPrice === null ? [] : [data({ v3_event: {
      type: 'price_unit_evidence',
      product_url: 'https://220volt.kz/catalog/batareiki/litievye/nbt-cr2025-bp5/',
      price: cardPrice, unit: 'шт', basis: 'piece',
    } })]),
    data({ v3_event: {
      type: 'products_block',
      markdown: `- **[Батарейка NBT-CR2025-BP5](https://220volt.kz/catalog/batareiki/litievye/nbt-cr2025-bp5/)**${priceLine}\n  Наличие: Алматы (1 шт)`,
    } }),
    'data: [DONE]',
  ].join('\n'));
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

test('all current acceptance matrices have recognized expectations', () => {
  for (const suite of [acceptanceSuite, notionSuite, notionV2Suite, cardinalitySuite]) {
    assert.doesNotThrow(() => validateExpectationSuite(suite));
  }
  assert.doesNotThrow(() => validateExpectationSuite(septemberSuite, septemberVariations));
});

test('expectation typos in defaults and unselected base cases fail before planning requests', () => {
  const suite = {
    default_expectations: { max_products: 5 },
    cases: [
      { id: 'selected', turns: [{ message: 'first', expect: { min_products: 1 } }] },
      { id: 'unselected', turns: [{ message: 'second', expect: { min_produts: 2 } }] },
    ],
  };
  assert.throws(() => validateExpectationSuite(suite), /unselected\.turns\[0\]\.expect: unknown expectation key min_produts/);
  suite.cases[1].turns[0].expect = { min_products: 2 };
  suite.default_expectations = { max_produts: 5 };
  assert.throws(() => validateExpectationSuite(suite), /suite\.default_expectations: unknown expectation key max_produts/);
});

test('expectation typo in a variation override fails even when another variant is selected', () => {
  const suite = {
    default_expectations: { min_products: 1 },
    cases: [{ id: 'example', turns: [{ message: 'products', expect: { max_products: 5 } }] }],
  };
  const variationSuite = { variants: [
    { id: 'selected', case_id: 'example', messages: ['products, please'] },
    { id: 'unselected', case_id: 'example', messages: ['show products'], expect_overrides: [{ max_produts: 3 }] },
  ] };
  assert.throws(() => validateExpectationSuite(suite, variationSuite),
    /example\/unselected\.expect_overrides\[0\]: unknown expectation key max_produts/);
});

test('effective expectations reject contradictory limits introduced across layers', () => {
  const suite = {
    default_expectations: { min_products: 3 },
    cases: [{ id: 'example', turns: [{ message: 'products', expect: { max_products: 5 } }] }],
  };
  const variationSuite = { variants: [{
    id: 'one-only', case_id: 'example', messages: ['one product'], expect_overrides: [{ max_products: 1 }],
  }] };
  assert.throws(() => validateExpectationSuite(suite, variationSuite),
    /one-only\.expect_overrides\[0\] \(effective\): min_products cannot exceed max_products/);
  assert.throws(() => validateExpectationObject({ min_products: 4, max_products: 2 }),
    /min_products cannot exceed max_products/);
});

test('nested source, measurement, cardinality, and split contracts reject ignored keys', () => {
  const cases = [
    [{ require_every_product_page: { facets: [{ name: 'Мощность', require_an: ['100'] }] } }, /require_an/],
    [{ require_every_product_measurement: { units: ['Вт'], minn: 100 } }, /minn/],
    [{ require_result_cardinality: { target: 3, minimun: 2 } }, /minimun/],
    [{ require_exact_or_split: { exact_title_group: [['Кабель']] } }, /exact_title_group/],
  ];
  for (const [expect, error] of cases) {
    assert.throws(() => validateExpectationObject(expect), error);
  }
  assert.throws(() => validateExpectationObject({
    require_every_product_measurement: { units: ['Вт'], min: 100, max: 50 },
  }), /min cannot exceed max/);
});

test('empty groups and incomplete alternatives cannot make an active assertion vacuously pass', () => {
  const invalid = [
    [{ require_text_groups: [] }, /require_text_groups: must be a non-empty array/],
    [{ require_every_product_title_groups: [[]] }, /require_every_product_title_groups\[0\]/],
    [{ require_selection_criteria_groups: [] }, /require_selection_criteria_groups: must be a non-empty array/],
    [{ require_product_groups_or_gap: [] }, /require_product_groups_or_gap: must be a non-empty array/],
    [{ require_product_groups_or_gap: [{ title_groups: [] }] }, /title_groups: must be a non-empty array/],
    [{ require_exact_or_split: { split_title_groups: [], split_text_groups: [] } }, /split_title_groups: must be a non-empty array/],
    [{ require_exact_or_split: { exact_title_groups: [['CORN']], split_title_groups: [['E27']] } }, /requires both title and text groups/],
    [{ require_exact_or_split: {} }, /requires an exact or split alternative/],
    [{ require_products_or_text_groups: { min_products: 1, text_groups: [] } }, /text_groups: must be a non-empty array/],
  ];
  for (const [expect, error] of invalid) {
    assert.throws(() => validateExpectationObject(expect), error);
  }
  assert.doesNotThrow(() => validateExpectationObject({
    require_exact_or_split: { exact_title_groups: [['CORN'], ['E27']] },
  }));
  assert.doesNotThrow(() => validateExpectationObject({
    require_exact_or_split: { split_title_groups: [['CORN']], split_text_groups: [['отдельно']] },
  }));
});

test('nested evidence contracts reject missing operators, empty branches, and invalid measurements or cardinality', () => {
  const invalid = [
    [{ require_every_product_page: { facets: [{ name: 'Мощность' }] } }, /source rule must contain at least one valid operator/],
    [{ require_every_product_page: { facets: [{ name: 'Мощность', require_any: [] }] } }, /source rule must contain at least one valid operator/],
    [{ require_every_product_page: { all_of: [] } }, /all_of: must be a non-empty array/],
    [{ require_every_product_measurement: { units: [], min: 100 } }, /units: must be a non-empty array/],
    [{ require_every_product_measurement: { units: ['Вт'], min: '100' } }, /min: must be a finite number/],
    [{ require_every_product_measurement: { units: ['Вт'], allow_compact_numeric: 'yes' } }, /allow_compact_numeric: must be a boolean/],
    [{ require_result_cardinality: { target: 2, minimum: 3 } }, /minimum cannot exceed target/],
    [{ require_result_cardinality: { target: '2' } }, /target: must be an integer/],
    [{ require_result_cardinality: { explicit: 'true' } }, /explicit: must be a boolean/],
  ];
  for (const [expect, error] of invalid) {
    assert.throws(() => validateExpectationObject(expect), error);
  }
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
  const notionV2 = validateStrictFullSuite({
    argv: strictArgs,
    suite: notionV2Suite,
    variationSuite: null,
    casesPath: '/qa/notion-legacy-bug-cases-v2.json',
    variantsPath: null,
    suiteBytes: notionV2Bytes,
    variantsBytes: null,
  });
  assert.deepEqual([notionV2.expected_cases, notionV2.expected_turns_per_base_suite, notionV2.expected_runs, notionV2.expected_evaluated_turns], [32, 46, 40, 54]);
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
  const notionV2Args = {
    ...notionArgs,
    suite: notionV2Suite,
    casesPath: '/qa/notion-legacy-bug-cases-v2.json',
    suiteBytes: notionV2Bytes,
  };
  assert.throws(() => validateStrictFullSuite({ ...notionV2Args, suite: {
    ...notionV2Suite, cases: notionV2Suite.cases.slice(1),
  } }), /expected 32 unique IDs/);
  for (const id of ['bt928-boiler-breaker-diagnostic', 'bt923-battery-unit']) {
    assert.throws(() => validateStrictFullSuite({ ...notionV2Args, suite: {
      ...notionV2Suite,
      cases: notionV2Suite.cases.map((item) => item.id === id ? { ...item, repeat: 1 } : item),
    } }), new RegExp(`invalid repeats=${id}`));
  }
  const weakenedV2 = structuredClone(notionV2Suite);
  delete weakenedV2.cases.find((item) => item.id === 'bt923-battery-unit').turns[0].expect.require_quoted_price_per_piece;
  assert.throws(() => validateStrictFullSuite({
    ...notionV2Args, suite: weakenedV2, suiteBytes: Buffer.from(JSON.stringify(weakenedV2)),
  }), /SHA256 mismatch/);
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

test('Notion v2 preserves source prompts while adding scoped reliability, chips and BT-923 assertions', () => {
  assert.equal(notionSuite.schema_version, 1);
  assert.equal(notionV2Suite.schema_version, 2);
  assert.deepEqual(notionV2Suite.cases.filter((item) => item.synthetic !== true).map((item) => item.id),
    notionSuite.cases.map((item) => item.id));
  assert.deepEqual(notionV2Suite.cases.filter((item) => item.synthetic === true).map((item) => item.id),
    ['bt929-synthetic-yard-area-cable-not-height', 'bt929-synthetic-parking-area-cable-not-height']);
  const addedFollowupCounts = {
    'bt929-pump-cable-clarification': 1,
    'bt929-outdoor-floodlight-clarification': 1,
    'bt929-underground-cable-clarification': 4,
    'bt929-lugs-35mm-clarification': 2,
    'bt929-surveillance-cable-clarification': 3,
    'bt924-replace-kg-cable': 2,
  };
  for (const oldCase of notionSuite.cases) {
    const nextCase = notionV2Suite.cases.find((item) => item.id === oldCase.id);
    if (['bt928-boiler-breaker-diagnostic', 'bt923-battery-unit', 'bt923-vvg-3x1_5-unit'].includes(oldCase.id)) continue;
    if (oldCase.id.startsWith('bt929-') && oldCase.id !== 'bt929-heat-shrink-12mm' ||
        ['bt924-apartment-breaker-25a', 'bt924-replace-kg-cable'].includes(oldCase.id)) {
      assert.equal(nextCase.id, oldCase.id);
      assert.equal(nextCase.title, oldCase.title);
      const first = structuredClone(nextCase.turns[0]);
      for (const key of ['require_clarification_choice', 'require_clarification_facet_key', 'require_clarification_range_unit']) {
        delete first.expect[key];
      }
      assert.deepEqual(first, oldCase.turns[0], `${oldCase.id}: original source turn changed`);
      const addedSyntheticFollowups = addedFollowupCounts[oldCase.id] ?? 0;
      assert.equal(nextCase.turns.length, oldCase.turns.length + addedSyntheticFollowups, oldCase.id);
      assert(nextCase.turns.slice(oldCase.turns.length).every((turn) => turn.synthetic === true), oldCase.id);
    } else {
      assert.deepEqual(nextCase, oldCase);
    }
  }
  const boiler = notionV2Suite.cases.find((item) => item.id === 'bt928-boiler-breaker-diagnostic');
  const battery = notionV2Suite.cases.find((item) => item.id === 'bt923-battery-unit');
  assert.equal(boiler.repeat, 3);
  assert.equal(battery.repeat, 3);
  assert.equal(battery.turns[0].expect.require_quoted_price_per_piece, true);
  assert.equal(battery.turns[0].expect.min_products, 1);
  assert.equal(battery.turns[0].expect.max_products, 1);
  assert.equal(battery.turns[0].expect.require_every_product_exact_identifier, 'NBT-CR2025-BP5');
  assert.equal(battery.turns[0].expect.require_every_product_page.name.require_any[0], 'NBT-CR2025-BP5');
  assert.deepEqual(battery.turns[0].expect.require_every_product_page.facets,
    [{ name: 'Единица измерения', exact_any: ['шт'] }]);
  assert(!JSON.stringify(battery.turns[0].expect).includes('5 шт'));
  const cable = notionV2Suite.cases.find((item) => item.id === 'bt923-vvg-3x1_5-unit');
  assert.equal(cable.turns[0].message, 'найди кабель ввг 3*1,5 самый дешевый');
  assert.equal(cable.turns[0].expect.require_every_product_stock_unit, 'м');
  assert.deepEqual(cable.turns[0].expect.require_every_product_page.facets,
    [{ name: 'Единица измерения', exact_any: ['м', 'метр'] }]);
  assert.throws(() => validateExpectationObject({ require_quoted_price_per_piece: 'true' }), /must be a boolean/);
});

test('Notion v3 keeps historical v2 intact and checks catalog-backed cable and outlet properties', () => {
  assert.equal(notionV3Suite.schema_version, 3);
  assert.deepEqual(notionV3Suite.cases.map((item) => item.id), notionV2Suite.cases.map((item) => item.id));
  const v3 = (id) => notionV3Suite.cases.find((item) => item.id === id);
  const v2 = (id) => notionV2Suite.cases.find((item) => item.id === id);
  for (const oldCase of notionV2Suite.cases) {
    assert.equal(v3(oldCase.id).turns[0].message, oldCase.turns[0].message, oldCase.id);
  }
  assert.deepEqual(v3('bt927-copper-fire-resistant-2x1_5').turns[0].expect.require_every_product_page.facets,
    [
      { name: 'Материал проводника', exact_any: ['медь'] },
      { name: 'Негорючесть', exact_any: ['Да'] },
      { name: 'Количество жил', exact_any: ['2'] },
      { name: 'Сечение кабеля, мм2', min_numeric: 1.5, less_than: 1.51 },
    ]);
  assert.equal(v3('bt746-black-double-socket').turns[0].expect.require_every_product_page.facets[2].name,
    'Вид розетки');
  assert.equal(v3('bt746-white-extension-3-sockets').turns[0].expect.require_every_product_page.facets[0].name,
    'Цвет');
  assert.equal(v3('bt746-extension-50m').turns[1].message, 'дай ссылку');
  assert.equal(v3('bt746-extension-50m').turns[1].synthetic, true,
    'the comment preserves the request for a link, not the exact second user message');
  assert.equal(v3('bt746-extension-50m').turns[1].expect.require_previous_product_link, true);
  const boiler = v3('bt928-boiler-breaker-diagnostic');
  assert.equal(boiler.repeat, 3);
  assert.equal(boiler.turns[0].expect.max_products, 0);
  assert.equal(boiler.turns[0].expect.require_asked_text_groups.length, 3);
  assert(boiler.turns[0].expect.forbid_assistant_text.some((phrase) => phrase.includes('товар')));
  for (const id of ['bt924-schneider-cheaper-analogs', 'bt924-acti9-followup-show']) {
    const final = v3(id).turns.at(-1).expect;
    assert(!final.forbid_product_title.includes('Schneider'), id);
    assert(final.forbid_product_title.includes('Acti9'), id);
    assert(final.forbid_product_title.includes('Acti 9'), id);
    assert(v2(id).turns.at(-1).expect.forbid_product_title.includes('Schneider'), 'v2 remains historical');
  }
  validateExpectationSuite(notionV3Suite);
  assert.deepEqual(validateStrictFullSuite({
    argv: strictArgs, suite: notionV3Suite, variationSuite: null,
    casesPath: '/qa/notion-legacy-bug-cases-v3.json', variantsPath: null,
    suiteBytes: notionV3Bytes, variantsBytes: null,
  }), {
    name: 'notion-legacy-bug-cases-v3.json', expected_cases: 32,
    expected_turns_per_base_suite: 52, expected_repeat: 1,
    expected_runs: 40, expected_evaluated_turns: 60,
  });
});

test('asked-detail contract needs user-directed questions, not diagnostic keyword mentions', () => {
  const expect = notionV3Suite.cases.find((item) => item.id === 'bt928-boiler-breaker-diagnostic').turns[0].expect;
  const response = (text) => ({
    text, textBeforeProducts: text, productsMarkdown: '', links: [],
    completed: true, diagnosticError: null, serverProductsCount: 0,
  });
  const possibleCauses = 'Возможны перегрузка по мощности и току либо короткое замыкание; номинал автомата пока неизвестен. ';
  const questions = 'Автомат выбивает сразу или через несколько минут? Какой сейчас номинал автомата в амперах? Какая мощность бойлера?';

  assert.deepEqual(evaluate(expect, response(possibleCauses + questions)), []);
  assert.equal(evaluate(expect, response(
    `${possibleCauses}Время срабатывания: сразу или через несколько минут. Номинал автомата и мощность бойлера неизвестны. В чём причина?`,
  )).filter((failure) => failure.startsWith('assistant did not ask for required detail')).length, 3);
  assert(evaluate(expect, response(possibleCauses + questions.replace('Какая мощность бойлера?', '')))
    .some((failure) => failure.includes('[мощн, кВт, ватт]')));
  assert(evaluate(expect, response(possibleCauses + questions.replace('Какой сейчас номинал автомата в амперах? ', '')))
    .some((failure) => failure.includes('[номинал, ампер, маркировк]')));
  assert(evaluate(expect, response(possibleCauses + questions.replace('Какой сейчас номинал автомата в амперах?', 'Какой номинал автомата выбрать?')))
    .some((failure) => failure.includes('[сейчас, текущ, установлен, стоит, у вас, вашего]')));
  assert(evaluate(expect, response(possibleCauses + questions.replace('Автомат выбивает сразу или через несколько минут? ', '')))
    .some((failure) => failure.includes('[сразу, немедленно, моментально]')));
  assert(evaluate(expect, response(`${possibleCauses}${questions}\n\nНе нашёл подходящие товары по этому сочетанию параметров.`))
    .some((failure) => failure.includes('forbidden assistant text')));
});

test('asked-detail contract accepts direct requests and validates nested groups generically', () => {
  const expect = { require_asked_text_groups: [
    [['велосипед'], ['скрип', 'звук']],
    [['когда', 'после'], ['дожд', 'езды']],
  ] };
  const response = (text) => ({
    text, textBeforeProducts: text, productsMarkdown: '', links: [],
    completed: true, diagnosticError: null, serverProductsCount: 0,
  });
  assert.deepEqual(evaluate(expect, response('Уточните, где скрипит велосипед и когда это случается после дождя.')), []);
  assert.equal(evaluate(expect, response('Скрип велосипеда бывает после дождя. Уточните детали.'))
    .filter((failure) => failure.startsWith('assistant did not ask for required detail')).length, 2);
  for (const invalid of [[], [[]], [[[]]], [[['']]], 'скрип']) {
    assert.throws(() => validateExpectationObject({ require_asked_text_groups: invalid }), /require_asked_text_groups/);
  }
});

test('Easy9 under the Schneider brand remains eligible while Acti 9 is excluded', () => {
  const expect = notionV3Suite.cases.find((item) => item.id === 'bt924-schneider-cheaper-analogs').turns[0].expect;
  const url = 'https://220volt.kz/catalog/nizkovoltnoe-oborudovanie/apparatyi-zashhityi/avtomaticheskie-vyiklyuchateli/easy9/';
  const identity = productUrlIdentity(url);
  const title = 'Автомат Schneider Electric EASY 9 1P 16A C 4,5кА';
  const response = {
    text: '', productsMarkdown: '', completed: true, terminalDiagnosticSeen: true,
    logId: 'trace-easy9', serverProductsCount: 1,
    links: [{ title, url, price: 1520, stockLine: 'Астана (5 шт)' }],
    verifiedProductPages: new Map([[identity, {
      identity, verified: true, sku: 'EZ9F34116', name: title, offerPrice: 1520,
      availability: 'https://schema.org/InStock', facets: {
        'Количество полюсов': '1', 'Номинальный ток': '16',
        'Характеристика срабатывания': 'C',
      }, description: '',
    }]]),
  };
  assert.deepEqual(evaluate(expect, response), []);
  response.links[0].title = 'Автомат Schneider Electric Acti 9 1P 16A C 4,5кА';
  assert(evaluate(expect, response).some((failure) => failure.includes('forbidden')));
});

test('product-link follow-up must reference a verified prior SKU, not just any new catalog link', () => {
  const prior = 'https://220volt.kz/catalog/elektroustanovochnyie-izdeliya/udliniteli/uk50/';
  const unrelated = 'https://220volt.kz/catalog/elektroustanovochnyie-izdeliya/udliniteli/uk25/';
  const base = {
    text: `Вот ссылка: ${prior}`, productsMarkdown: '', links: [],
    completed: true, terminalDiagnosticSeen: true, logId: 'trace-follow-up', serverProductsCount: 0,
  };
  const previousVerifiedProductUrls = new Set([productUrlIdentity(prior)]);
  assert.deepEqual(evaluate({ require_previous_product_link: true }, base, { previousVerifiedProductUrls }), []);
  assert(evaluate({ require_previous_product_link: true }, { ...base, text: `Вот ссылка: ${unrelated}` },
    { previousVerifiedProductUrls }).some((failure) => failure.includes('previously verified product')));
  assert(evaluate({ require_previous_product_link: true }, { ...base, text: `Вот ссылка: ${prior} и ${unrelated}` },
    { previousVerifiedProductUrls }).some((failure) => failure.includes('previously verified product')));
  assert(evaluate({ require_previous_product_link: true }, base)
    .some((failure) => failure.includes('previously verified product')));
  assert.throws(() => validateExpectationObject({ require_previous_product_link: 'true' }), /must be a boolean/u);
});

test('v3 source facets reject aluminium, network sockets and non-white three-way strips', () => {
  const v3 = (id) => notionV3Suite.cases.find((item) => item.id === id).turns[0].expect;
  const card = (url, title, facets) => {
    const identity = productUrlIdentity(url);
    return {
      text: '', productsMarkdown: '', completed: true, terminalDiagnosticSeen: true,
      logId: 'trace-facets', serverProductsCount: 1,
      links: [{ title, url, price: 1234, stockLine: 'Астана (5 шт)' }],
      verifiedProductPages: new Map([[identity, {
        identity, verified: true, sku: 'SOURCE-1', name: title, offerPrice: 1234,
        availability: 'https://schema.org/InStock', facets, description: '',
      }]]),
    };
  };
  const cable = card('https://220volt.kz/catalog/kabeli/vvg/copper-ng-2-1-5/',
    'Кабель ВВГ нг 2*1,5', {
      'Материал проводника': 'медь', Негорючесть: 'Да', 'Количество жил': '2',
      'Сечение кабеля, мм2': '1.5',
    });
  assert.deepEqual(evaluate(v3('bt927-copper-fire-resistant-2x1_5'), cable), []);
  cable.verifiedProductPages.values().next().value.facets['Материал проводника'] = 'алюминий';
  assert(evaluate(v3('bt927-copper-fire-resistant-2x1_5'), cable)
    .some((failure) => failure.includes('Материал проводника')));
  const socket = card('https://220volt.kz/catalog/elektroustanovochnyie-izdeliya/rozetki/black-double/',
    'Розетка двойная чёрная', {
      'Количество разъемов': '2', Цвет: 'чёрный', 'Вид розетки': 'электрическая',
    });
  assert.deepEqual(evaluate(v3('bt746-black-double-socket'), socket), []);
  socket.verifiedProductPages.values().next().value.facets['Вид розетки'] = 'компьютерная RJ45';
  assert(evaluate(v3('bt746-black-double-socket'), socket)
    .some((failure) => failure.includes('Вид розетки')));
  const strip = card('https://220volt.kz/catalog/elektroustanovochnyie-izdeliya/udliniteli/three-way/',
    'Удлинитель У3 3 места', {
      Цвет: 'белый', 'Количество розеток евростандарта': '3',
    });
  assert.deepEqual(evaluate(v3('bt746-white-extension-3-sockets'), strip), []);
  strip.verifiedProductPages.values().next().value.facets.Цвет = 'чёрный';
  assert(evaluate(v3('bt746-white-extension-3-sockets'), strip)
    .some((failure) => failure.includes('Цвет')));
});

function stockReply(stockLines) {
  return parseSse([
    ...stockLines.map((stockLine, index) => data({ v3_event: {
      type: 'products_block',
      markdown: `- **[Кабель ВВГ 3×1,5 № ${index + 1}](https://220volt.kz/catalog/kabeli/vvg/kabel-${index + 1}/)**\n  Цена: *123* ₸\n  Наличие: ${stockLine}`,
    } })),
    'data: [DONE]',
  ].join('\n'));
}

test('stock-unit assertion checks each quantified warehouse in every rendered card', () => {
  const expectation = { require_every_product_stock_unit: 'м' };
  assert.deepEqual(evaluate(expectation, stockReply([
    'Астана (80 м.), Алматы (110 м.) и ещё 2 города',
    'Караганда (2 м)',
  ])), []);
  for (const [lines, description] of [
    [['Астана (80 шт.)'], 'wrong unit in sole warehouse'],
    [['Астана (80 м.), Алматы (110 шт.)'], 'wrong unit in second warehouse'],
    [['Астана (80 м.)', 'Караганда (2 шт.)'], 'wrong unit in second card'],
    [['Астана (80 м.), Алматы (шт. 110)'], 'malformed second warehouse quantity'],
    [['Астана (80 м.), Алматы 110 шт.'], 'unparsed unparenthesized quantity'],
    [['Астана (есть)'], 'stock with no numeric quantity'],
  ]) {
    assert(evaluate(expectation, stockReply(lines)).some((failure) => failure.includes('stock')),
      description);
  }
  const missingStock = stockReply(['Астана (80 м.)']);
  missingStock.links[0].stockLine = null;
  assert(evaluate(expectation, missingStock).some((failure) => failure.includes('no stock line')));
  assert(evaluate(expectation, { ...missingStock, links: [] })
    .some((failure) => failure.includes('at least one rendered product card')));
});

test('stock-unit assertion uses only stock quantities, not price or free text', () => {
  const parsed = stockReply(['Астана (80 шт.)']);
  parsed.text = 'Цена указана за метр, 80 м в наличии';
  parsed.productsMarkdown += '\nЦена: 123 ₸/м';
  assert(evaluate({ require_every_product_stock_unit: 'м' }, parsed)
    .some((failure) => failure.includes('unit is not м')));
  for (const value of ['', '  ', 'м ', 'м\n', 'м|шт', {}, null]) {
    assert.throws(() => validateExpectationObject({ require_every_product_stock_unit: value }),
      /must be a non-empty bounded catalog unit/);
  }
});

test('quoted-price unit assertion accepts the deterministic source-unit reply', () => {
  const parsed = batteryReply('Товар «Батарейка NBT-CR2025-BP5». Цена 1 234 ₸ за одну штуку по единице каталога «шт». Сама единица цены не раскрывает количество элементов внутри упаковки.', 1234);
  assert.deepEqual(evaluate({ require_quoted_price_per_piece: true }, parsed), []);
  assert.equal(parsed.priceUnitEvidence[0].unit, 'шт');
});

test('source unit event must match the rendered product identity, amount, and piece basis', () => {
  const parsed = batteryReply('Товар «Батарейка NBT-CR2025-BP5». Цена 1 234 ₸ за одну штуку по единице каталога «шт». Сама единица цены не раскрывает количество элементов внутри упаковки.');
  const contract = { require_quoted_price_per_piece: true };
  for (const mutation of [
    (reply) => { reply.priceUnitEvidence = []; },
    (reply) => { reply.priceUnitEvidence[0].price = 999; },
    (reply) => { reply.priceUnitEvidence[0].unit = 'уп'; },
    (reply) => { reply.priceUnitEvidence[0].basis = 'package'; },
    (reply) => { reply.priceUnitEvidence[0].productUrl = 'https://220volt.kz/catalog/other/'; },
  ]) {
    const reply = structuredClone(parsed);
    mutation(reply);
    assert(evaluate(contract, reply).length > 0);
  }
});

test('quoted-price unit assertion fails closed on absent, echoed, negated and contradictory claims', () => {
  const invalid = [
    ['Батарейка NBT-CR2025-BP5 поставляется в блистере.', 'missing unit answer'],
    ['Цена 1 234 ₸. В упаковке есть батарейка.', 'price and packaging without unit'],
    ['Цена 1 234 ₸ за штуку или упаковку?', 'question echo'],
    ['Цена 1 234 ₸ за штуку или упаковку.', 'unresolved alternative'],
    ['Цена 1 234 ₸ не за штуку, а за упаковку.', 'negated per-piece claim'],
    ['Не 1 234 ₸ за штуку.', 'negated quoted amount'],
    ['Цена 1 234 ₸ за упаковку.', 'affirmative per-package claim'],
    ['Цена 1 234 ₸ за штуку. Указанная цена за упаковку.', 'contradictory claim'],
    ['Цена 1 234 ₸ за батарейки.', 'plural product is not a per-piece unit'],
    ['Цена 999 ₸ за штуку.', 'different quote from card'],
  ];
  for (const [reply, scenario] of invalid) {
    const failures = evaluate({ require_quoted_price_per_piece: true }, batteryReply(reply, 1234));
    assert(failures.length > 0, `${scenario} must not PASS`);
  }
  assert(evaluate({ require_quoted_price_per_piece: true }, batteryReply('1 234 ₸ за штуку', null)).length > 0);
  assert(evaluate({ require_quoted_price_per_piece: true }, { ...batteryReply('1 234 ₸ за штуку', 1234), links: [] }).length > 0);
  const contradictoryCard = batteryReply('Цена 1 234 ₸ за штуку.', 1234);
  contradictoryCard.links[0].cardText = contradictoryCard.links[0].cardText.replace('₸', '₸/уп');
  assert(evaluate({ require_quoted_price_per_piece: true }, contradictoryCard)
    .some((failure) => failure.includes('per package')));
});

test('quoted-price unit assertion does not pass a correction, uncertainty, or a package sales unit', () => {
  for (const reply of [
    'Цена 1 234 ₸ за штуку. Нет, это за упаковку.',
    'Цена 1 234 ₸ не указана за штуку. Есть блистер.',
    'Не могу подтвердить, что цена 1 234 ₸ за штуку. Упаковку надо уточнить.',
    'Одна батарейка стоит 1 234 ₸/уп.',
    'Цена 1 234 ₸ за штуку. На самом деле 1 234 ₸/уп.',
  ]) {
    assert(evaluate({ require_quoted_price_per_piece: true }, batteryReply(reply)).length > 0, reply);
  }
  const packageCard = batteryReply('Цена 1 234 ₸ за штуку.');
  packageCard.links[0].cardText += '\n  Единица продажи: упаковка';
  assert(evaluate({ require_quoted_price_per_piece: true }, packageCard).length > 0);
});

test('release assertion does not guess the meaning of free-form unit prose', () => {
  for (const reply of [
    'Одна батарейка стоит 1 234 ₸. Упаковка — блистер.',
    'Стоимость 1 шт. — 1 234 ₸. Упаковка — блистер.',
    'Цена — 1 234 ₸. Это за одну штуку, в блистере.',
  ]) {
    assert(evaluate({ require_quoted_price_per_piece: true }, batteryReply(reply)).length > 0, reply);
  }
});

test('exact product identifier rejects another pack/model suffix even with verified page', () => {
  const parsed = batteryReply('Товар «Батарейка NBT-CR2025-BP5-10 (другая комплектация)». Цена 1 234 ₸ за одну штуку по единице каталога «шт». Сама единица цены не раскрывает количество элементов внутри упаковки.');
  const identity = productUrlIdentity(parsed.links[0].url);
  parsed.links[0].title = 'Батарейка NBT-CR2025-BP5-10 (другая комплектация)';
  parsed.verifiedProductPages = new Map([[identity, {
    identity, verified: true, sku: 'OTHER-SKU',
    name: 'Батарейка NBT-CR2025-BP5-10 (другая комплектация)',
    offerPrice: 1234, availability: 'https://schema.org/InStock',
  }]]);
  parsed.terminalDiagnosticSeen = true;
  parsed.logId = 'exact-identifier-fixture';
  const expect = {
    require_every_product_exact_identifier: 'NBT-CR2025-BP5',
    require_quoted_price_per_piece: true,
  };
  assert(evaluate(expect, parsed, { requireVerifiedPages: true }).some((failure) => failure.includes('exact identifier')));
  parsed.links[0].title = 'Батарейка NBT-CR2025-BP5';
  parsed.verifiedProductPages.get(identity).name = 'Батарейка NBT-CR2025-BP5';
  parsed.text = 'Товар «Батарейка NBT-CR2025-BP5». Цена 1 234 ₸ за одну штуку по единице каталога «шт». Сама единица цены не раскрывает количество элементов внутри упаковки.';
  assert.deepEqual(evaluate(expect, parsed, { requireVerifiedPages: true }), []);
});

test('exact product identifier is primary identity, not an analogue reference', () => {
  const parsed = batteryReply('Товар «Батарейка Panasonic CR2025, аналог NBT-CR2025-BP5». Цена 1 234 ₸ за одну штуку по единице каталога «шт». Сама единица цены не раскрывает количество элементов внутри упаковки.');
  parsed.links[0].title = 'Батарейка Panasonic CR2025, аналог NBT-CR2025-BP5';
  const identity = productUrlIdentity(parsed.links[0].url);
  parsed.verifiedProductPages = new Map([[identity, {
    identity, verified: true, sku: 'PANASONIC-CR2025',
    name: parsed.links[0].title,
    offerPrice: 1234, availability: 'https://schema.org/InStock',
  }]]);
  assert(evaluate({ require_every_product_exact_identifier: 'NBT-CR2025-BP5' }, parsed)
    .some((failure) => failure.includes('exact identifier')));
  parsed.links[0].title = 'Батарейка NBT-CR2025-BP5+10';
  parsed.verifiedProductPages.get(identity).name = parsed.links[0].title;
  assert(evaluate({ require_every_product_exact_identifier: 'NBT-CR2025-BP5' }, parsed)
    .some((failure) => failure.includes('exact identifier')));
});

test('BT-923 v2 rejects a v1 false PASS even with the correct card and verified source identity', () => {
  const oldExpect = notionSuite.cases.find((item) => item.id === 'bt923-battery-unit').turns[0].expect;
  const nextExpect = notionV2Suite.cases.find((item) => item.id === 'bt923-battery-unit').turns[0].expect;
  const parsed = batteryReply('Батарейка CR2025 в блистере. Цена 1 234 ₸ за упаковку.', 1234);
  const identity = productUrlIdentity(parsed.links[0].url);
  parsed.verifiedProductPages = new Map([[identity, {
    identity, verified: true, sku: 'source-sku', name: 'Батарейка NBT-CR2025-BP5',
    offerPrice: 1234, availability: 'https://schema.org/InStock',
    facets: { 'Единица измерения': 'шт' },
  }]]);
  assert.deepEqual(evaluate(oldExpect, parsed), []);
  assert(evaluate(nextExpect, parsed).some((failure) => failure.includes('deterministic catalog-backed')));
  assert.deepEqual(evaluate(nextExpect, {
    ...parsed, text: 'Товар «Батарейка NBT-CR2025-BP5». Цена 1 234 ₸ за одну штуку по единице каталога «шт». Сама единица цены не раскрывает количество элементов внутри упаковки.',
  }), []);
  parsed.verifiedProductPages.get(identity).facets['Единица измерения'] = 'уп';
  assert(evaluate(nextExpect, {
    ...parsed, text: 'Товар «Батарейка NBT-CR2025-BP5». Цена 1 234 ₸ за одну штуку по единице каталога «шт». Сама единица цены не раскрывает количество элементов внутри упаковки.',
  }).some((failure) => failure.includes('facet Единица измерения')));
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
    offerPrice: null, availability: null,
  });
  assert.equal(productProofFromHtml(categoryHtml, identity), null);
  assert.equal(productProofFromHtml(productHtml.replace('Ем000000001', ''), identity), null);
  assert.equal(productProofFromHtml(productHtml.replace(productUrl, 'https://220volt.kz/catalog/other/item/'), identity), null);
});

test('a no-SKU Product needs matching canonical, @id, H1, detail facets, KZT price and stock', () => {
  const cardUrl = 'https://220volt.kz/catalog/kabeli/kabel-vvg/ng/kabel-vvg-ng-3*1,5-gk-gost%28krasnyij%29/';
  const canonicalUrl = 'https://220volt.kz/catalog/kabeli/kabel-vvg/ng/kabel-vvg-ng-3*1,5-gk-gost(krasnyij)/';
  const otherUrl = 'https://220volt.kz/catalog/kabeli/kabel-vvg/ng/another-cable/';
  const identity = productUrlIdentity(cardUrl);
  const name = 'Кабель ВВГ нг 3*1,5 ГК ГОСТ(красный)';
  const html = ({ canonical = canonicalUrl, id = canonicalUrl, productName = name,
    heading = name, sku = '', missingSku = false, price = '456.00', currency = 'KZT',
    availability = 'https://schema.org/InStock', facets = true } = {}) => `
    ${canonical ? `<link rel="canonical" href="${canonical}">` : ''}
    <h1>${heading}</h1>
    <script type="application/ld+json">${JSON.stringify({
      '@context': 'https://schema.org', '@type': 'Product', '@id': id,
      name: productName, ...(missingSku ? {} : { sku }),
      offers: { '@type': 'Offer', price, priceCurrency: currency, availability },
    })}</script>
    ${facets ? '<div class="product__tab-description-item"><span class="product__description-title">Количество жил:</span><span class="product__tab-description-text">3</span></div>' : ''}`;
  assert.deepEqual(productProofFromHtml(html(), identity), {
    sku: null, identityMode: 'jsonld_no_sku_canonical_name_price_stock', canonicalUrl,
    name, facets: { 'Количество жил': '3' }, description: '',
    offerPrice: 456, availability: 'https://schema.org/InStock',
  });
  assert.equal(productProofFromHtml(html({ missingSku: true }), identity)?.identityMode,
    'jsonld_no_sku_canonical_name_price_stock');
  for (const invalid of [
    { canonical: otherUrl }, { canonical: null }, { canonical: `${canonicalUrl}?tracking=1` },
    { id: otherUrl }, { id: `${canonicalUrl}?tracking=1` },
    { productName: `${name} другой` }, { heading: `${name} другой` },
    { price: null }, { price: '0' }, { currency: 'USD' },
    { availability: 'https://schema.org/OutOfStock' }, { facets: false },
    { sku: '0' },
  ]) {
    assert.equal(productProofFromHtml(html(invalid), identity), null, JSON.stringify(invalid));
  }
  assert.equal(productProofFromHtml(html().replace('"@type":"Product"', '"@type":"ItemList"'), identity), null);
});

test('no-SKU identity verifies exact rendered name and price, and tracks distinct canonical products', async () => {
  const url = 'https://220volt.kz/catalog/kabeli/kabel-vvg/ng/red-cable/';
  const otherUrl = 'https://220volt.kz/catalog/kabeli/kabel-vvg/ng/blue-cable/';
  const name = 'Кабель ВВГ нг 3*1,5 красный';
  const html = `<link rel="canonical" href="${url}"><h1>${name}</h1>
    <script type="application/ld+json">${JSON.stringify({
      '@type': 'Product', '@id': url, name, sku: '',
      offers: { price: '456.00', priceCurrency: 'KZT', availability: 'https://schema.org/InStock' },
    })}</script>
    <div class="product__tab-description-item"><span class="product__description-title">Цвет:</span><span class="product__tab-description-text">красный</span></div>`;
  const proof = await verifyProductPage(url, {
    fetchImpl: async () => new Response(html, { headers: { 'Content-Type': 'text/html' } }),
  });
  assert.equal(proof.verified, true);
  assert.equal(proof.identityMode, 'jsonld_no_sku_canonical_name_price_stock');
  const identity = productUrlIdentity(url);
  const otherIdentity = productUrlIdentity(otherUrl);
  const base = {
    text: '', productsMarkdown: '', completed: true, terminalDiagnosticSeen: true,
    logId: 'trace-no-sku', diagnosticError: null, serverProductsCount: 1,
    links: [{ title: name, url, price: 456, stockLine: 'Астана (5939 м)' }],
    verifiedProductPages: new Map([[identity, proof]]),
  };
  assert.deepEqual(evaluate({}, base, { requireVerifiedPages: true }), []);
  assert(evaluate({}, { ...base, links: [{ ...base.links[0], title: `${name} другой` }] },
    { requireVerifiedPages: true }).some((failure) => failure.includes('name disagrees')));
  assert(evaluate({}, { ...base, links: [{ ...base.links[0], price: 457 }] },
    { requireVerifiedPages: true }).some((failure) => failure.includes('price disagrees')));
  assert(evaluate({}, { ...base, links: [{ ...base.links[0], stockLine: null }] },
    { requireVerifiedPages: true }).some((failure) => failure.includes('stock is missing')));
  assert.deepEqual(evaluate({}, {
    ...base,
    serverProductsCount: 2,
    links: [...base.links, { title: name, url: otherUrl, price: 456, stockLine: 'Астана (5 м)' }],
    verifiedProductPages: new Map([[identity, proof], [otherIdentity, {
      ...proof, identity: otherIdentity, canonicalUrl: otherUrl,
    }]]),
  }, { requireVerifiedPages: true }), []);
  assert(evaluate({ require_new_product_skus: true }, base, {
    requireVerifiedPages: true, previousVerifiedSkus: new Set([`canonical:${identity}`]),
  }).some((failure) => failure.includes('previously shown canonical product')));
});

test('strict acceptance checks rendered SKU identity, source price, stock and terminal trace', () => {
  const url = 'https://220volt.kz/catalog/kabeli/prokladka/trubki/ttu-12-6/';
  const identity = productUrlIdentity(url);
  const proof = {
    verified: true, sku: 'SKU-TTU-12', name: 'Термоусадочная трубка ТТУ 12/6 черная',
    offerPrice: 133, availability: 'https://schema.org/InStock', facets: {}, description: '',
  };
  const base = {
    text: '', productsMarkdown: '', completed: true, terminalDiagnosticSeen: true,
    logId: 'trace-1', diagnosticError: null, serverProductsCount: 1,
    links: [{ title: 'Трубка ТТУ 12/6 черная', url, price: 133, stockLine: 'Астана (2 шт)' }],
    verifiedProductPages: new Map([[identity, proof]]),
  };
  assert.deepEqual(evaluate({}, base, { requireVerifiedPages: true }), []);
  const wrong = {
    ...base,
    links: [{ title: 'Розетка Gallant двойная', url, price: 99, stockLine: null }],
    terminalDiagnosticSeen: false,
    logId: null,
  };
  const failures = evaluate({}, wrong, { requireVerifiedPages: true });
  assert(failures.some((failure) => failure.includes('name disagrees')));
  assert(failures.some((failure) => failure.includes('price disagrees')));
  assert(failures.some((failure) => failure.includes('stock is missing')));
  assert(failures.includes('terminal diagnostic is missing'));
  assert(failures.includes('request log ID is missing'));
  const unavailable = { ...base, verifiedProductPages: new Map([[identity, {
    ...proof, availability: 'https://schema.org/OutOfStock',
  }]]) };
  assert(evaluate({}, unavailable, { requireVerifiedPages: true })
    .some((failure) => failure.includes('not confirmed in stock')));
});

test('SKU-backed shorter title can expand only with canonical and price proof, not conflicting names', () => {
  const url = 'https://220volt.kz/catalog/nizkovoltnoe-oborudovanie/apparatyi-zashhityi/avtomaticheskie-vyiklyuchateli/avtomat-1r-va-47-29m-16a-4,5ka-x-ka-s-generica-%28iek%29/';
  const canonical = url.replace('%28iek%29', '(iek)');
  const identity = productUrlIdentity(url);
  const sourceName = 'Автоматический выключатель ВА47-29М 1P 16А 4,5кА C GENERICA (ИЭК)';
  const renderedName = 'Автомат 1Р ВА 47-29М 16А 4,5кА х-ка С GENERICA (ИЭК)';
  const html = (canonicalUrl = canonical) => `
    <link rel="canonical" href="${canonicalUrl}">
    <script type="application/ld+json">${JSON.stringify({
      '@type': 'Product', '@id': canonical, name: sourceName, sku: 'Ем000033671',
      offers: { price: 578, priceCurrency: 'KZT', availability: 'https://schema.org/InStock' },
    })}</script>`;
  const proof = { identity, verified: true, ...productProofFromHtml(html(), identity) };
  assert.equal(proof.canonicalUrl, canonical);
  const base = {
    text: '', productsMarkdown: '', completed: true, terminalDiagnosticSeen: true,
    logId: 'trace-short-title', diagnosticError: null, serverProductsCount: 1,
    links: [{ title: renderedName, url, price: 578, stockLine: 'Астана (1041 шт)' }],
    verifiedProductPages: new Map([[identity, proof]]),
  };
  assert.deepEqual(evaluate({}, base, { requireVerifiedPages: true }), []);
  for (const title of [
    'Розетка 1Р ВА 47-29М 16А 4,5кА GENERICA (ИЭК)',
    'Автомат 1Р ВА 47-29М 16А 4,5кА CHINT',
    'Автомат 1Р ВА 47-29М 25А 4,5кА GENERICA (ИЭК)',
  ]) {
    assert(evaluate({}, { ...base, links: [{ ...base.links[0], title }] },
      { requireVerifiedPages: true }).some((failure) => failure.includes('name disagrees')), title);
  }
  const withoutCanonical = { ...proof, canonicalUrl: undefined };
  assert(evaluate({}, { ...base, verifiedProductPages: new Map([[identity, withoutCanonical]]) },
    { requireVerifiedPages: true }).some((failure) => failure.includes('name disagrees')));
  const wrongCanonical = productProofFromHtml(html('https://220volt.kz/catalog/other/item/'), identity);
  assert.equal(wrongCanonical.canonicalUrl, undefined);
  assert(evaluate({}, { ...base, links: [{ ...base.links[0], price: 579 }] },
    { requireVerifiedPages: true }).some((failure) => failure.includes('price disagrees')));
});

test('alternative follow-up rejects a previously verified SKU', () => {
  const url = 'https://220volt.kz/catalog/svetotexnika/svetilniki/old-light/';
  const identity = productUrlIdentity(url);
  const proof = {
    verified: true, sku: 'OLD-LIGHT', name: 'Люстра для гостиной',
    offerPrice: 9000, availability: 'https://schema.org/InStock',
    facets: {}, description: '',
  };
  const response = {
    text: '', productsMarkdown: '', completed: true, terminalDiagnosticSeen: true,
    logId: 'trace-alternatives', diagnosticError: null, serverProductsCount: 1,
    links: [{ title: proof.name, url, price: 9000, stockLine: 'Астана (2 шт)' }],
    verifiedProductPages: new Map([[identity, proof]]),
  };
  const expect = { min_products: 1, require_new_product_skus: true };
  assert(evaluate(expect, response, {
    requireVerifiedPages: true,
    previousVerifiedSkus: new Set(['OLD-LIGHT']),
  }).some((failure) => failure.includes('previously shown SKU')));
  assert.deepEqual(evaluate(expect, response, {
    requireVerifiedPages: true,
    previousVerifiedSkus: new Set(['ANOTHER-LIGHT']),
  }), []);
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

test('heat-shrink source proof enforces both strict diameters and the requested TTU class', () => {
  const scenario = acceptanceSuite.cases.find((item) => item.id === 'customer-new-heat-shrink-10mm');
  const rule = scenario.turns[0].expect.require_every_product_page;
  const url = 'https://220volt.kz/catalog/kabeli/prokladka/trubki/ttu-12-6/';
  const link = [{ title: 'Трубка ТТУ 12/6', url }];
  const base = { text: '', productsMarkdown: '', links: link, completed: true,
    diagnosticError: null, serverProductsCount: 1 };
  const proof = { verified: true, sku: 'T-12-6', name: 'Термоусадочная трубка ТТУ 12/6',
    facets: { 'Внутр диаметр до термоусадки,мм': '12', 'Внутр диаметр после термоусадки, мм': '6' },
    description: '' };
  const verifiedProductPages = new Map([[productUrlIdentity(url), proof]]);
  assert.deepEqual(evaluate({ require_every_product_page: rule }, { ...base, verifiedProductPages }), []);
  verifiedProductPages.set(productUrlIdentity(url), { ...proof,
    facets: { ...proof.facets, 'Внутр диаметр до термоусадки,мм': '10' } });
  assert(evaluate({ require_every_product_page: rule }, { ...base, verifiedProductPages })
    .some((failure) => failure.includes('not > 10')));
  verifiedProductPages.set(productUrlIdentity(url), { ...proof,
    facets: { ...proof.facets, 'Внутр диаметр после термоусадки, мм': '10' } });
  assert(evaluate({ require_every_product_page: rule }, { ...base, verifiedProductPages })
    .some((failure) => failure.includes('not < 10')));
  verifiedProductPages.set(productUrlIdentity(url), { ...proof, name: 'Термоусадочная трубка NST 12/6' });
  assert(evaluate({ require_every_product_page: rule }, { ...base, verifiedProductPages })
    .some((failure) => failure.includes('source does not contain any of ТТУ')));
});

test('source-backed alternatives accept residential proof outside a catalog facet without admitting acoustic-only sensors', () => {
  const rule = {
    all_of: [
      { any_of: [
        { facets: [{ name: 'Вид светильника', require_any: ['бытов'] }] },
        { description: { require_any: ['бытов', 'жилых зданий'] } },
      ] },
      { any_of: [
        { name: { require_any: ['датчиком движения', 'микроволновым сенсором'] } },
        { description: { require_any: ['движущ', 'движен', 'микроволнов'] } },
      ] },
    ],
  };
  const url = 'https://220volt.kz/catalog/svetotexnika/svetilniki/residential-sensor/';
  const link = [{ title: 'Светильник с датчиком движения', url }];
  const base = { text: '', productsMarkdown: '', links: link, completed: true, diagnosticError: null, serverProductsCount: 1 };
  const proof = { verified: true, sku: 'LEDAR-20', name: link[0].title,
    facets: { 'Вид светильника': 'Светильники для ЖКХ' },
    description: 'Для общественного и бытового освещения. Реагирует на движение.' };
  const verifiedProductPages = new Map([[productUrlIdentity(url), proof]]);
  assert.deepEqual(evaluate({ require_every_product_page: rule }, { ...base, verifiedProductPages }), []);
  verifiedProductPages.set(productUrlIdentity(url), { ...proof,
    name: 'Светильник с акустическим датчиком',
    description: 'Для общественного освещения. Реагирует на звук.' });
  const failures = evaluate({ require_every_product_page: rule }, { ...base, verifiedProductPages });
  assert(failures.some((failure) => failure.includes('no source-backed alternative matched')));
  assert(evaluate({ require_every_product_page: { any_of: [] } }, { ...base, verifiedProductPages })
    .includes('invalid product-page source evidence contract'));
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

function clarificationReply({
  text = 'Какой вариант вам нужен?',
  question = 'Какой вариант вам нужен?',
  replies = [{ value: 'проводная', label: 'Проводная' }, { value: 'беспроводная', label: 'Беспроводная' }],
  options = replies,
  quickEvent = true,
  slotEvent = true,
  facetKey = 'connection',
  slotFacetKey = facetKey,
  additionalEvents = [],
} = {}) {
  const pending = {
    status: 'pending', slot_id: 'server-issued-slot', facet_key: slotFacetKey,
    question, options,
  };
  return parseSse([
    data({ choices: [{ delta: { content: text } }] }),
    ...(quickEvent ? [data({ v3_event: { type: 'quick_replies', facet_key: facetKey, replies } })] : []),
    ...(slotEvent ? [data({ v3_event: { type: 'slot_update', slots: { pending_clarification: pending } } })] : []),
    ...additionalEvents.map((event) => data({ v3_event: event })),
    'data: [DONE]',
  ].join('\n'));
}

test('a visible clarification with server-bound quick replies passes the options contract', () => {
  const response = clarificationReply();
  assert.equal(response.quickReplies.type, 'quick_replies');
  assert.deepEqual(evaluate({ require_clarification_choice: 'options' }, response), []);
  assert.deepEqual(evaluate({ require_clarification_choice: 'either' }, response), []);
  assert.deepEqual(evaluate({ require_clarification_choice: 'options', require_clarification_facet_key: 'connection' }, response), []);
  assert(evaluate({ require_clarification_facet_key: 'mounting' }, response)
    .includes('clarification facet connection != mounting'));
});

test('the Gallant release case requires actual section chips before a follow-up', () => {
  const gallant = acceptanceSuite.cases.find((item) => item.id === 'customer-new-gallant-catalog-section-chip');
  assert.equal(gallant.turns[0].expect.require_clarification_choice, 'options');
  assert.equal(gallant.turns[0].expect.require_clarification_facet_key, 'catalog_section');
  assert.equal(gallant.turns[1].message, 'Розетки');
});

test('all BT-929 readiness axes require server-bound chips; numeric axes remain ranges', () => {
  const axes = {
    'bt929-pump-cable-clarification': 'supply_phase',
    'bt929-outdoor-floodlight-clarification': 'mounting_height',
    'bt929-motor-breaker-clarification': 'supply_phase',
    'bt929-underground-cable-clarification': 'installation_method',
    'bt929-lugs-35mm-clarification': 'conductor_material',
    'bt929-surveillance-cable-clarification': 'camera_system',
    'bt929-warm-led-clarification': 'socket_type',
    'bt929-parking-floodlight-clarification': 'mounting_height',
  };
  for (const [id, facet] of Object.entries(axes)) {
    const first = notionV2Suite.cases.find((item) => item.id === id)?.turns[0];
    assert(first, id);
    assert.equal(first.expect.require_clarification_choice, 'options', id);
    assert.equal(first.expect.require_clarification_facet_key, facet, id);
    assert.equal(first.expect.max_products, 0, id);
    if (facet === 'mounting_height') assert.equal(first.expect.require_clarification_range_unit, 'м', id);
    assert.doesNotThrow(() => validateExpectationObject(first.expect), id);
  }
  for (const [id, value, nextFacet, unit] of [
    ['bt929-pump-cable-clarification', '220 В, 1 фаза', 'line_length', 'м'],
    ['bt929-outdoor-floodlight-clarification', 'До 4 м', 'illuminated_area', 'м²'],
  ]) {
    const followup = notionV2Suite.cases.find((item) => item.id === id)?.turns[1];
    assert(followup, id);
    assert.equal(followup.message, value, id);
    assert.equal(followup.expect.require_previous_quick_reply.value, value, id);
    assert.equal(followup.expect.require_clarification_facet_key, nextFacet, id);
    assert.equal(followup.expect.require_clarification_range_unit, unit, id);
    assert.equal(followup.expect.conversation_boundary, 'continuation', id);
  }
  assert.match(notionV2Suite.source, /synthetic API continuations and geometry scenarios \(not customer quotes or browser clicks\)/u);
  assert.equal(notionV2Suite.cases.find((item) => item.id === 'bt929-heat-shrink-12mm')
    .turns[0].expect.require_clarification_choice, undefined);
});

test('synthetic BT-929/BT-924 continuations prevent a product search after the first chip', () => {
  const scenarios = [
    ['bt929-lugs-35mm-clarification', ['conductor_material', 'connection_type', 'hole_size'], ['Медь', 'Под болт']],
    ['bt929-surveillance-cable-clarification', ['camera_system', 'installation_location', 'power_mode', 'line_length'],
      ['Цифровая/IP', 'На улице', 'Питание PoE']],
    ['bt929-underground-cable-clarification',
      ['installation_method', 'supply_phase', 'load_power', 'core_count', 'grounding_presence'],
      ['В трубе/ПНД', '220 В, 1 фаза', '5 кВт', '3 жилы']],
    ['bt924-replace-kg-cable', ['installation_mode', 'core_and_section', 'usage_purpose'],
      ['Подвижное подключение', '3×2,5']],
  ];
  for (const [id, facets, replies] of scenarios) {
    const turns = notionV2Suite.cases.find((item) => item.id === id)?.turns;
    assert.equal(turns.length, facets.length, id);
    for (const [index, turn] of turns.entries()) {
      assert.equal(turn.expect.max_products, 0, `${id} turn ${index + 1}`);
      assert.equal(turn.expect.require_clarification_facet_key, facets[index], `${id} turn ${index + 1}`);
      if (index === 0) continue;
      assert.equal(turn.synthetic, true, `${id} turn ${index + 1} must be marked synthetic`);
      assert.equal(turn.message, replies[index - 1], `${id} turn ${index + 1}`);
      assert.equal(turn.expect.conversation_boundary, 'continuation');
      assert(turn.expect.require_previous_quick_reply || turn.expect.require_previous_freeform_slot,
        `${id} turn ${index + 1} must be bound to the preceding server slot`);
    }
  }
  const yard = notionV2Suite.cases.filter((item) => item.id.includes('-synthetic-') && item.id.includes('-not-height'));
  assert.equal(yard.length, 2);
  for (const testCase of yard) {
    assert.equal(testCase.synthetic, true);
    assert.equal(testCase.turns.length, 1);
    assert.match(testCase.turns[0].message, /(?:10|20) м/u);
    assert.equal(testCase.turns[0].expect.require_clarification_facet_key, 'mounting_height');
    assert.equal(testCase.turns[0].expect.max_products, 0);
    assert.deepEqual(testCase.turns[0].expect.require_clarification_option_values,
      ['До 4 м', '4–8 м', 'Выше 8 м']);
  }
});

test('server-issued chip sets and free-form predecessor slots are evaluated, not inferred from prose', () => {
  const replies = [{ value: 'Под болт', label: 'Под болт' }, { value: 'В клемму', label: 'В клемму' }];
  const response = clarificationReply({ facetKey: 'connection_type', replies });
  assert.deepEqual(evaluate({ require_clarification_option_values: ['В клемму', 'Под болт'] }, response), []);
  assert(evaluate({ require_clarification_option_values: ['Под болт', 'Неизвестно'] }, response)
    .some((failure) => failure.includes('clarification options')));
  assert(evaluate({ require_clarification_option_values: ['Под болт', 'В клемму'] },
    clarificationReply({ quickEvent: false, options: [] }))
    .some((failure) => failure.includes('clarification options')));
  const previous = { mode: 'freeform', facet_key: 'core_and_section', values: [] };
  const context = { previousClarificationChoice: previous, message: '3×2,5' };
  assert.deepEqual(evaluate({ require_previous_freeform_slot: 'core_and_section' }, response, context), []);
  for (const broken of [
    { ...context, previousClarificationChoice: { mode: 'options', facet_key: 'core_and_section', values: ['3×2,5'] } },
    { ...context, previousClarificationChoice: { ...previous, facet_key: 'usage_purpose' } },
    { ...context, message: '' },
  ]) {
    assert(evaluate({ require_previous_freeform_slot: 'core_and_section' }, response, broken)
      .some((failure) => failure.includes('server-issued free-form slot')));
  }
  assert.throws(() => validateExpectationObject({ require_clarification_option_values: ['same', 'same'] }),
    /requires 2–5 distinct widget-compatible values/);
  assert.throws(() => validateExpectationObject({ require_previous_freeform_slot: 'bad axis' }),
    /must be a bounded facet key/);
});

test('prose options and legacy-looking JSON cannot impersonate clickable SSE chips', () => {
  const prose = parseSse([
    data({ choices: [{ delta: { content: 'Какой вариант вам нужен? 1. Проводная 2. Беспроводная' } }] }),
    data({ quick_replies: [{ value: 'проводная', label: 'Проводная' }] }),
    'data: [DONE]',
  ].join('\n'));
  assert(evaluate({ require_clarification_choice: 'options' }, prose)
    .some((failure) => failure.includes('not backed by renderable SSE')));
  assert(evaluate({ require_clarification_choice: 'either' }, clarificationReply({ quickEvent: false, slotEvent: false }))
    .some((failure) => failure.includes('not backed by renderable SSE')));
});

test('orphan quick replies or an option slot without matching replies cannot pass', () => {
  for (const response of [
    clarificationReply({ slotEvent: false }),
    clarificationReply({ quickEvent: false }),
    clarificationReply({ facetKey: 'mounting', slotFacetKey: 'connection' }),
    clarificationReply({ text: 'Покажу товары.' }),
    clarificationReply({ additionalEvents: [{ type: 'slot_update', slots: {} }] }),
  ]) {
    assert(evaluate({ require_clarification_choice: 'options' }, response)
      .some((failure) => failure.includes('not backed by renderable SSE')));
  }
});

test('mismatched, duplicate and malformed quick-reply values are not widget-renderable', () => {
  const valid = [{ value: 'проводная', label: 'Проводная' }, { value: 'беспроводная', label: 'Беспроводная' }];
  for (const response of [
    clarificationReply({ replies: [{ ...valid[0], label: 'Другое' }, valid[1]], options: valid }),
    clarificationReply({ replies: [valid[0], valid[0]], options: [valid[0], valid[0]] }),
    clarificationReply({ replies: [{ ...valid[0], value: ' проводная ' }, valid[1]], options: [{ ...valid[0], value: ' проводная ' }, valid[1]] }),
    clarificationReply({ replies: [valid[0]], options: [valid[0]] }),
  ]) {
    assert(evaluate({ require_clarification_choice: 'options' }, response)
      .some((failure) => failure.includes('not backed by renderable SSE')));
  }
});

test('free-form clarification is accepted only from an explicit empty server slot', () => {
  const explicit = clarificationReply({ quickEvent: false, options: [] });
  assert.deepEqual(evaluate({ require_clarification_choice: 'freeform' }, explicit), []);
  assert.deepEqual(evaluate({ require_clarification_choice: 'either' }, explicit), []);
  assert(evaluate({ require_clarification_choice: 'options' }, explicit)
    .includes('clarification choice mode freeform != options'));
  assert(evaluate({ require_clarification_choice: 'freeform' }, clarificationReply({ quickEvent: false }))
    .some((failure) => failure.includes('not backed by renderable SSE')));
  assert(evaluate({ require_clarification_choice: 'freeform' }, clarificationReply({ options: [] }))
    .some((failure) => failure.includes('conflicts with quick-reply event')));
});

test('numeric chips must be bounded ranges with their dimension, while typed exact input stays possible', () => {
  const height = clarificationReply({
    facetKey: 'mounting_height',
    replies: [{ value: 'До 4 м', label: 'До 4 м' }, { value: '4–8 м', label: '4–8 м' }, { value: 'Выше 8 м', label: 'Выше 8 м' }],
  });
  const area = clarificationReply({
    facetKey: 'illuminated_area',
    replies: [{ value: 'До 50 м²', label: 'До 50 м²' }, { value: '50–150 м²', label: '50–150 м²' }],
  });
  assert.deepEqual(evaluate({ require_clarification_range_unit: 'м' }, height), []);
  assert.deepEqual(evaluate({ require_clarification_range_unit: 'м²' }, area), []);
  for (const replies of [
    [{ value: '4 м', label: '4 м' }, { value: '8 м', label: '8 м' }],
    [{ value: 'До 4 м', label: 'До 4 м' }, { value: 'Высоко', label: 'Высоко' }],
  ]) {
    assert(evaluate({ require_clarification_range_unit: 'м' }, clarificationReply({ replies }))
      .some((failure) => failure.includes('exact or unitless option')));
  }
  assert(evaluate({ require_clarification_range_unit: 'м' }, clarificationReply({ quickEvent: false, options: [] }))
    .includes('numeric clarification lacks verified range chips'));
});

test('scripted continuation is bound to an actual prior server choice, not prose or an invented option', () => {
  const issued = { mode: 'options', facet_key: 'supply_phase', values: ['220 В, 1 фаза', '380 В, 3 фазы'] };
  const expect = { require_previous_quick_reply: { facet_key: 'supply_phase', value: '220 В, 1 фаза' } };
  const response = parseSse('data: [DONE]\n');
  assert.deepEqual(evaluate(expect, response, { previousClarificationChoice: issued, message: '220 В, 1 фаза' }), []);
  for (const context of [
    { previousClarificationChoice: null, message: '220 В, 1 фаза' },
    { previousClarificationChoice: { mode: 'freeform', facet_key: 'supply_phase', values: [] }, message: '220 В, 1 фаза' },
    { previousClarificationChoice: { ...issued, facet_key: 'line_length' }, message: '220 В, 1 фаза' },
    { previousClarificationChoice: { ...issued, values: ['380 В, 3 фазы'] }, message: '220 В, 1 фаза' },
    { previousClarificationChoice: issued, message: '1 фаза' },
  ]) {
    assert(evaluate(expect, response, context).some((failure) => failure.includes('not an exact server-issued quick-reply')));
  }
});

test('clarification choice expectations reject unsupported modes before a live request', () => {
  assert.throws(() => validateExpectationObject({ require_clarification_choice: 'chips-or-text' }),
    /require_clarification_choice: must be options, freeform or either/);
  assert.throws(() => validateExpectationObject({ require_clarification_facet_key: 'bad axis' }),
    /require_clarification_facet_key/u);
  assert.throws(() => validateExpectationObject({ require_clarification_range_unit: 'мм' }),
    /require_clarification_range_unit/u);
  assert.throws(() => validateExpectationObject({ require_previous_quick_reply: { facet_key: 'connection', value: '  bad' } }),
    /require_previous_quick_reply/u);
  assert.throws(() => validateExpectationObject({ require_previous_quick_reply: { facet_key: 'connection', value: 'p', injected: true } }),
    /unknown expectation key injected/u);
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

function axisReply(cards, text = '') {
  const links = cards.map(([title, url]) => ({ title, url, price: 500, stockLine: 'Алматы (5 шт)' }));
  const verifiedProductPages = new Map(links.map((link, index) => {
    const identity = productUrlIdentity(link.url);
    return [identity, {
      identity, verified: true, sku: `TEST-${index}`, name: link.title, offerPrice: 500,
      availability: 'https://schema.org/InStock',
    }];
  }).filter(([identity]) => identity));
  return {
    text, textBeforeProducts: text, productsMarkdown: '', links, verifiedProductPages,
    completed: true, diagnosticError: null, serverProductsCount: links.length,
    terminalDiagnosticSeen: true, logId: 'axis-proof',
  };
}

test('BT-925 v3 requires source-backed lamp cards with exact axes or a complete, cautiously explained split', () => {
  const expectation = notionV3Suite.cases.find((item) => item.id === 'bt925-corn-e27').turns[0].expect;
  assert.equal(expectation.require_axis_exact_or_split.category_path, '/catalog/svetotexnika/lampyi/');
  assert.doesNotThrow(() => validateExpectationObject(expectation));
  const lamp = (slug) => `https://220volt.kz/catalog/svetotexnika/lampyi/${slug}/`;
  const exact = axisReply([
    ['Лампа LED CORN E27', lamp('corn-e27')],
    ['Лампа кукуруза Е27', lamp('kukuruza-e27')],
  ], 'Вот лампы с обоими параметрами.');
  assert.deepEqual(evaluate(expectation, exact), []);

  const splitText = 'Среди найденных товаров сочетание CORN и E27 не удалось подтвердить. Что важнее — форма CORN или цоколь E27?';
  const split = axisReply([
    ['Лампа LED CORN G4', lamp('corn-g4')],
    ['Лампа LED A60 E27', lamp('a60-e27')],
  ], splitText);
  assert.deepEqual(evaluate(expectation, split), []);
  assert(evaluate(expectation, { ...exact, verifiedProductPages: new Map() })
    .some((failure) => failure.includes('unverified product page')));
});

test('BT-925 v3 rejects wrong products, code collisions, mixed cards, and unbounded split claims', () => {
  const expectation = notionV3Suite.cases.find((item) => item.id === 'bt925-corn-e27').turns[0].expect;
  const lamp = (slug) => `https://220volt.kz/catalog/svetotexnika/lampyi/${slug}/`;
  const exact = ['Лампа LED CORN E27', lamp('corn-e27')];
  const corn = ['Лампа LED CORN G4', lamp('corn-g4')];
  const e27 = ['Лампа LED A60 E27', lamp('a60-e27')];
  const disclosure = 'Среди найденных товаров сочетание CORN и E27 не удалось подтвердить.';
  const question = 'Что важнее — форма CORN или цоколь E27?';
  const invalid = [
    ['wrong host', [exact, ['Лампа LED CORN E27', 'https://evil.example/catalog/svetotexnika/lampyi/corn-e27/']], '', 'invalid 220volt.kz product URL'],
    ['fixture branch', [['Светильник CORN E27', 'https://220volt.kz/catalog/svetotexnika/svetilniki/corn-e27/']], '', 'outside required category'],
    ['adhesive remover', [['Спрей CORN E27 для удаления наклеек', 'https://220volt.kz/catalog/bytovaya-himiya/sredstva/sprey-corn-e27/']], '', 'outside required category'],
    ['lookalike category', [['Лампа CORN E27', 'https://220volt.kz/catalog/svetotexnika/lampyi-fake/corn-e27/']], '', 'outside required category'],
    ['unrelated lamp', [exact, ['Лампа LED A60 G4', lamp('a60-g4')]], '', 'neither all exact axis intersections'],
    ['CORN is not CORNER', [['Лампа LED CORNER E27', lamp('corner-e27')]], '', 'neither all exact axis intersections'],
    ['E27 is not E270', [['Лампа LED CORN E270', lamp('corn-e270')]], '', 'neither all exact axis intersections'],
    ['exact plus partial', [exact, e27], '', 'neither all exact axis intersections'],
    ['one axis only', [corn], `${disclosure} ${question}`, 'neither all exact axis intersections'],
    ['split without scoped disclosure', [corn, e27], `Такого сочетания не нашлось. ${question}`, 'scoped, cautious overlap disclosure'],
    ['split without priority question', [corn, e27], disclosure, 'axis-priority question'],
    ['priority statement is not a question', [corn, e27], `${disclosure} Приоритет — форма CORN или цоколь E27.`, 'axis-priority question'],
    ['global absence', [corn, e27], `${disclosure} В каталоге таких товаров нет. ${question}`, 'global absence'],
    ['unscoped absence', [corn, e27], `${disclosure} Такого сочетания нет. ${question}`, 'global absence'],
  ];
  for (const [name, cards, text, expectedFailure] of invalid) {
    assert(evaluate(expectation, axisReply(cards, text)).some((failure) => failure.includes(expectedFailure)), name);
  }
});

test('axis contract is parameterized and rejects malformed category, terms, and disclosure', () => {
  const original = notionV3Suite.cases.find((item) => item.id === 'bt925-corn-e27').turns[0].expect.require_axis_exact_or_split;
  const contract = {
    category_path: '/catalog/elektrika/klemmniki/',
    axes: [[{ term: 'WAGO', match: 'code' }], [{ term: '2P', match: 'code' }]],
    split_disclosure_groups: [['среди найденных'], ['сочетание'], ['не удалось подтвердить']],
    split_priority_question_groups: [['важнее'], ['WAGO'], ['2P']],
  };
  const expectation = { min_products: 1, require_axis_exact_or_split: contract };
  assert.deepEqual(evaluate(expectation, axisReply([
    ['Клемма WAGO 2P', 'https://220volt.kz/catalog/elektrika/klemmniki/wago-2p/'],
  ])), []);
  const invalid = [
    [{ ...original, category_path: '/catalog/svetotexnika/lampyi' }, /category_path/],
    [{ ...original, axes: [original.axes[0]] }, /exactly two title axes/],
    [{ ...original, axes: [[], original.axes[1]] }, /must contain title terms/],
    [{ ...original, axes: [[{ term: 'CORN', match: 'substring' }], original.axes[1]] }, /must be code or word_prefix/],
    [{ ...original, axes: [[{ term: '', match: 'code' }], original.axes[1]] }, /bounded non-empty title term/],
    [{ ...original, split_disclosure_groups: [] }, /split_disclosure_groups/],
    [{ ...original, split_priority_question_groups: [] }, /split_priority_question_groups/],
    [{ ...original, unexpected: true }, /unexpected/],
  ];
  for (const [value, message] of invalid) {
    assert.throws(() => validateExpectationObject({ require_axis_exact_or_split: value }), message);
  }
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

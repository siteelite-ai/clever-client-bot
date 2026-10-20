import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { serializeReleaseLedger } from './build-release-ledger.mjs';
import { V9_MATRIX_MANIFESTS, buildReleaseLedgerV9 } from './build-release-ledger-v9.mjs';
import {
  evaluate, productUrlIdentity, validateExpectationObject, validateExpectationSuite,
  validateStrictFullSuite,
} from './run-customer-acceptance.mjs';

const read = (name) => fs.readFileSync(new URL(`./${name}`, import.meta.url));
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const suite = (name) => JSON.parse(read(name).toString('utf8'));
const findCase = (value, id) => value.cases.find((item) => item.id === id);

test('V9 pins successor bytes while preserving V8, V5 and both old customer suites', () => {
  assert.equal(sha256(fs.readFileSync(new URL('../../docs/qa/release-inventory-v8-20261020.json', import.meta.url))),
    'd41603654570985dc055fd2b82354604bcf903740329983ba66dd91e6f069ecd');
  assert.equal(sha256(read('customer-acceptance-cases.json')),
    '549600818c83cb1813d05bba2e32316f71b42059596c973d5b814356d129b366');
  assert.equal(sha256(read('notion-legacy-bug-cases-v5.json')),
    'f4ba64271c02cdbc7549be3061dc0171952fae8ac6555d2bba67d896209a1e61');
  for (const manifest of V9_MATRIX_MANIFESTS) {
    assert.equal(sha256(read(manifest.file)), manifest.sha256, manifest.file);
    if (manifest.variations) {
      assert.equal(sha256(read(manifest.variations.file)), manifest.variations.sha256);
    }
  }
  assert.deepEqual(V9_MATRIX_MANIFESTS.map((manifest) => manifest.file), [
    'customer-acceptance-cases-v2.json', 'customer-audit-20260921-cases.json',
    'notion-legacy-bug-cases-v6.json', 'systemic-cardinality-cases.json',
  ]);
});

test('V9 changes only three heat-shrink oracles and keeps all messages and other assertions', () => {
  const customerOld = suite('customer-acceptance-cases.json');
  const customerNew = suite('customer-acceptance-cases-v2.json');
  const notionOld = suite('notion-legacy-bug-cases-v5.json');
  const notionNew = suite('notion-legacy-bug-cases-v6.json');
  assert.equal(customerNew.schema_version, 3);
  assert.equal(notionNew.schema_version, 6);
  assert.deepEqual(customerNew.cases.map((item) => item.id), customerOld.cases.map((item) => item.id));
  assert.deepEqual(notionNew.cases.map((item) => item.id), notionOld.cases.map((item) => item.id));
  for (const [before, after, changedIds] of [
    [customerOld, customerNew, new Set(['customer-new-heat-shrink-12mm', 'customer-new-heat-shrink-10mm'])],
    [notionOld, notionNew, new Set(['bt929-heat-shrink-12mm'])],
  ]) {
    assert.deepEqual(after.default_expectations, before.default_expectations);
    for (const oldCase of before.cases) {
      const next = findCase(after, oldCase.id);
      assert.deepEqual(next.turns.map((turn) => turn.message), oldCase.turns.map((turn) => turn.message));
      assert.equal(next.repeat ?? 1, oldCase.repeat ?? 1);
      assert.equal(next.synthetic, oldCase.synthetic);
      if (!changedIds.has(oldCase.id)) assert.deepEqual(next, oldCase, oldCase.id);
    }
    validateExpectationSuite(after);
  }
  for (const [id, lower, cable, source] of [
    ['customer-new-heat-shrink-12mm', 14.4, 12, customerNew],
    ['customer-new-heat-shrink-10mm', 12, 10, customerNew],
    ['bt929-heat-shrink-12mm', 14.4, 12, notionNew],
  ]) {
    const nextCase = findCase(source, id);
    const expect = nextCase.turns[0].expect;
    assert.deepEqual(expect.require_every_product_page.facets, [
      { name: 'Внутр диаметр до термоусадки,мм', min_numeric: lower },
      { name: 'Внутр диаметр после термоусадки, мм', less_than: cable },
    ], id);
    assert.deepEqual(expect.require_selection_criteria_exact.map(({ op, value, exclusive }) =>
      [op, value, exclusive]), [['min', lower, false], ['max', cable, true]], id);
    assert.equal(expect.require_every_product_pair_around, cable, id);
    const oldCase = findCase(source === customerNew ? customerOld : notionOld, id);
    const expectedCase = structuredClone(oldCase);
    const expectedRule = expectedCase.turns[0].expect;
    expectedRule.require_every_product_page = expect.require_every_product_page;
    if (source === customerNew) delete expectedRule.require_selection_criteria_groups;
    expectedRule.require_selection_criteria_exact = expect.require_selection_criteria_exact;
    assert.deepEqual(nextCase, expectedCase, `${id}: unrelated assertion changed`);
  }
});

test('V9 strict suite names, hashes and complete dimensions are recognized offline', () => {
  for (const [name, expectedCases, expectedTurns, expectedRuns, expectedEvaluated] of [
    ['customer-acceptance-cases-v2.json', 27, 42, 81, 126],
    ['notion-legacy-bug-cases-v6.json', 32, 53, 40, 61],
  ]) {
    const bytes = read(name);
    assert.deepEqual(validateStrictFullSuite({
      argv: ['node', 'runner', '--strict-full-suite', '--endpoint=https://example.supabase.co/functions/v1/chat-consultant-v3-preview'],
      suite: JSON.parse(bytes), variationSuite: null, casesPath: `/qa/${name}`,
      variantsPath: null, suiteBytes: bytes, variantsBytes: null,
    }), {
      name, expected_cases: expectedCases, expected_turns_per_base_suite: expectedTurns,
      expected_repeat: name.startsWith('customer') ? 3 : 1,
      expected_runs: expectedRuns, expected_evaluated_turns: expectedEvaluated,
    });
  }
});

test('V9 ledger has complete plan but no borrowed PASS or candidate identity', () => {
  const ledger = buildReleaseLedgerV9();
  assert.deepEqual(ledger.counts, { matrix_files: 5, runs: 190, ordered_turns: 280 });
  assert.equal(ledger.candidate.status, 'NOT_RUN');
  assert.equal(ledger.candidate.commit_sha, null);
  assert.equal(ledger.candidate.preview_version, null);
  assert.equal(ledger.historical_report_results_joined, false);
  assert(ledger.runs.every((run) => run.candidate_status === 'NOT_RUN' &&
    run.turns.every((turn) => turn.candidate_status === 'NOT_RUN')));
  assert.equal(ledger.supersedes.sha256,
    'd41603654570985dc055fd2b82354604bcf903740329983ba66dd91e6f069ecd');
  assert.equal(ledger.runs.filter((run) => run.case_id === 'bt929-heat-shrink-12mm').length, 1);
  assert.equal(ledger.runs.filter((run) => run.case_id === 'customer-new-heat-shrink-12mm').length, 3);
  assert.equal(ledger.runs.filter((run) => run.case_id === 'customer-new-heat-shrink-10mm').length, 3);
  assert.equal(fs.readFileSync(new URL('../../docs/qa/release-inventory-v9-20261020.json', import.meta.url), 'utf8'),
    serializeReleaseLedger(ledger));
});

test('pinned V9 SHA rejects a changed successor expectation before a run', () => {
  const changed = suite('customer-acceptance-cases-v2.json');
  findCase(changed, 'customer-new-heat-shrink-12mm').turns[0].expect
    .require_every_product_page.facets[0].min_numeric = 12;
  const altered = Buffer.from(JSON.stringify(changed));
  assert.throws(() => buildReleaseLedgerV9({
    readBytes: (file) => path.basename(file) === 'customer-acceptance-cases-v2.json'
      ? altered : fs.readFileSync(file),
  }), /SHA256 changed/u);
});

test('generic exact-criterion oracle rejects stale limits while page facets reject 14/7', () => {
  const source = suite('customer-acceptance-cases-v2.json');
  const required = findCase(source, 'customer-new-heat-shrink-12mm').turns[0].expect;
  const url = 'https://220volt.kz/catalog/kabeli/trubki/ttu-16-8/';
  const identity = productUrlIdentity(url);
  const keyBefore = 'vnutr_diametr_do_termousadki_mm__catalog';
  const keyAfter = 'vnutr_diametr_posle_termousadki_mm__catalog';
  const criterion = (key, op, value, exclusive) => ({
    key, op, value, exclusive, unit: 'мм', evidence: 'derived_required',
  });
  const proof = (before) => new Map([[identity, {
    verified: true, sku: 'T-16-8', name: `Трубка ТТУ ${before}/8`, description: '',
    facets: {
      'Внутр диаметр до термоусадки,мм': String(before),
      'Внутр диаметр после термоусадки, мм': '8',
    },
  }]]);
  const response = {
    text: '', productsMarkdown: '', links: [{ title: 'Трубка ТТУ 16/8', url }],
    completed: true, diagnosticError: null, serverProductsCount: 1,
    verifiedProductPages: proof(16),
    selectionContract: { mandatory_criteria: [
      criterion(keyBefore, 'min', 14.4, false), criterion(keyAfter, 'max', 12, true),
    ] },
  };
  const oracle = {
    require_every_product_page: required.require_every_product_page,
    require_selection_criteria_exact: required.require_selection_criteria_exact,
  };
  assert.deepEqual(evaluate(oracle, response), []);
  assert(evaluate(oracle, {
    ...response, verifiedProductPages: proof(14),
  }).some((failure) => failure.includes('source numeric value 14 < 14.4')));
  assert(evaluate(oracle, {
    ...response, selectionContract: { mandatory_criteria: [
      criterion(keyBefore, 'min', 12, true), criterion(keyAfter, 'max', 12, true),
    ] },
  }).some((failure) => failure.includes('value=12 != 14.4')));
  assert(evaluate(oracle, {
    ...response, selectionContract: { mandatory_criteria: [
      criterion(keyBefore, 'min', 14.4, true), criterion(keyAfter, 'max', 12, true),
    ] },
  }).some((failure) => failure.includes('exclusive=true != false')));
  assert(evaluate(oracle, { ...response, selectionContract: null })
    .includes('machine-readable mandatory selection criteria are missing'));
  assert.throws(() => validateExpectationObject({ require_selection_criteria_exact: [
    { key_contains: keyBefore, op: 'min', value: 12, exclusive: 'false' },
  ] }), /requires op=min\|max\|eq/u);
});

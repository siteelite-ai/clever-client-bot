import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import test from 'node:test';

import { V9_MATRIX_MANIFESTS, buildReleaseLedgerV9 } from './build-release-ledger-v9.mjs';
import {
  confirmedAnalogFailures,
  evaluate,
  parseSse,
  productUrlIdentity,
  validateExpectationObject,
  validateExpectationSuite,
} from './run-customer-acceptance.mjs';

const prospectiveBytes = fs.readFileSync(new URL('./dn027b-direct-analogs-prospective-v1.json', import.meta.url));
const suite = JSON.parse(prospectiveBytes);
const expect = suite.cases.find(({ id }) => id === 'prospective-dn027b-confirmed-direct-analogs').turns[0].expect;
const contract = expect.require_confirmed_analogs;
const nowMs = Date.parse('2026-10-20T12:00:00Z');
const catalogBase = 'https://220volt.kz/catalog/svetotexnika/svetilniki/';

test('prospective three-analog gate is separate from immutable V9 and has no live PASS', () => {
  assert.equal(createHash('sha256').update(prospectiveBytes).digest('hex'),
    '7953bbc3a1f6e817fc22bc9ccfdd754b5ab6fd6233219e2a9ec0f04e1b6e74c9',
    'prospective DN027B contract changed; review the minimum and every compatibility axis');
  const v9Bytes = fs.readFileSync(new URL('./customer-acceptance-cases-v2.json', import.meta.url));
  assert.equal(createHash('sha256').update(v9Bytes).digest('hex'),
    '6fb6646ba9f5bf8d612e6aa4c707d2954ad351be6a9a2f43b7cf9239a020c7e7');
  const v9 = JSON.parse(v9Bytes);
  const oldCase = v9.cases.find(({ id }) => id === 'customer-dn027b-analogs');
  assert.equal(oldCase.turns[0].expect.min_products, 3);
  assert.equal(oldCase.turns[0].expect.require_confirmed_analogs, undefined);
  assert.equal(suite.cases.length, 1);
  assert.equal(suite.cases[0].turns[0].message, oldCase.turns[0].message);
  assert.equal(suite.acceptance_status, 'NO_GO_NOT_LIVE_VERIFIED');
  assert.equal(V9_MATRIX_MANIFESTS.some(({ file }) => file === 'dn027b-direct-analogs-prospective-v1.json'), false);
  assert.equal(buildReleaseLedgerV9().candidate.status, 'NOT_RUN');
  assert.doesNotThrow(() => validateExpectationSuite(suite));
  assert(failures({
    ...reply(),
    selectionContract: null,
  }).some((failure) => failure.includes('server proof is missing')),
  'three rendered links without server-owned compatibility proof remain NO-GO');
});

function axisValue(rule) {
  if (rule.op === 'eq') return rule.value;
  if (rule.op === 'covers') return { min: rule.value, max: rule.value };
  return (rule.min + rule.max) / 2;
}

function directCard(number) {
  const url = `${catalogBase}synthetic-confirmed-${number}/`;
  const sku = `SYNTHETIC-${number}`;
  const title = `Светильник тестовый встраиваемый ${number}`;
  const price = 1000 + number;
  return {
    link: { url, title, price, stockLine: 'Астана (2 шт)' },
    page: {
      identity: productUrlIdentity(url), verified: true, sku, name: title,
      offerPrice: price, availability: 'https://schema.org/InStock', facets: {}, description: '',
    },
    server: {
      product_url: url, sku, verdict: 'confirmed_direct',
      axes: contract.required_axes.map((rule) => ({
        key: rule.key, value: axisValue(rule),
        evidence: {
          kind: 'approved_manufacturer_fact',
          source_url: `https://manufacturer.example/documents/fixture-${number}.pdf`,
          approved_at: '2026-10-01T00:00:00Z', valid_until: '2027-10-01T00:00:00Z',
        },
      })),
    },
  };
}

function reply(cards = [directCard(1), directCard(2), directCard(3)]) {
  return {
    text: '', productsMarkdown: '', completed: true, terminalDiagnosticSeen: true,
    logId: 'synthetic-analog-proof', serverProductsCount: cards.length,
    links: cards.map(({ link }) => link),
    verifiedProductPages: new Map(cards.map(({ page }) => [page.identity, page])),
    selectionContract: {
      direct_analog_proof: {
        schema_version: 1, status: 'confirmed_direct',
        source_product_url: contract.source_product_url,
        candidates: cards.map(({ server }) => server),
      },
    },
  };
}

const failures = (response) => evaluate(expect, response, { requireVerifiedPages: true, nowMs });

test('separate prospective gate requires three direct, verified analogs, not three links', () => {
  assert.equal(contract.minimum, 3);
  assert.equal(expect.min_products, 3);
  assert.doesNotThrow(() => validateExpectationObject(expect));
  assert.deepEqual(failures(reply()), []);
  const two = reply([directCard(1), directCard(2)]);
  assert(failures(two).some((error) => error.includes('confirmed direct analogs 2 < 3')));
});

test('assistant prose or a provisional server shortlist cannot impersonate direct proof', () => {
  const noProof = reply();
  noProof.selectionContract = { visible_requirements: [{ kind: 'mounting_cutout', value: 90 }] };
  noProof.text = JSON.stringify({ direct_analog_proof: reply().selectionContract.direct_analog_proof });
  assert(failures(noProof).some((error) => error.includes('server proof is missing')));
  const conditional = reply();
  conditional.selectionContract.direct_analog_proof.candidates[2].verdict = 'conditional';
  assert(failures(conditional).some((error) => error.includes('confirmed direct analogs 2 < 3')));
  const unbound = reply();
  unbound.selectionContract.direct_analog_proof.source_product_url = `${catalogBase}wrong-source/`;
  assert(failures(unbound).some((error) => error.includes('not bound to the source')));
});

test('brightness, colour, packaging and mounting mismatches do not fill the third direct slot', () => {
  for (const [key, value] of [
    ['luminous_flux_lm', 1000],
    ['color_temperature_k', 3000],
    ['package_quantity', 10],
    ['mounting_cutout_mm', { min: 100, max: 110 }],
  ]) {
    const altered = reply();
    altered.selectionContract.direct_analog_proof.candidates[2].axes.find((axis) => axis.key === key).value = value;
    const result = failures(altered);
    assert(result.some((error) => error.includes(`no current approved compatible proof for ${key}`)), key);
    assert(result.some((error) => error.includes('confirmed direct analogs 2 < 3')), key);
  }
});

test('live page SKU, source exclusion, expiry and exact displayed-card binding fail closed', () => {
  const skuMismatch = reply();
  skuMismatch.selectionContract.direct_analog_proof.candidates[2].sku = 'OTHER-SKU';
  assert(failures(skuMismatch).some((error) => error.includes('live-SKU-bound')));

  const unverified = reply();
  unverified.verifiedProductPages.delete(productUrlIdentity(unverified.links[2].url));
  assert(failures(unverified).some((error) => error.includes('unverified product page')));

  const expired = reply();
  expired.selectionContract.direct_analog_proof.candidates[2].axes[0].evidence.valid_until = '2026-10-19T00:00:00Z';
  assert(failures(expired).some((error) => error.includes('no current approved compatible proof')));

  const sourceSelfLink = reply();
  sourceSelfLink.links[2].url = contract.source_product_url;
  assert(failures(sourceSelfLink).some((error) => error.includes('live-SKU-bound')));

  const extraProof = reply();
  extraProof.selectionContract.direct_analog_proof.candidates.push(directCard(4).server);
  assert(failures(extraProof).some((error) => error.includes('does not match exactly the displayed cards')));
});

test('only a server products_block carries the acceptance proof', () => {
  const fake = JSON.stringify({ v3_event: { type: 'delta', content: JSON.stringify(reply().selectionContract) } });
  const parsedFake = parseSse(`data: ${fake}\n\ndata: [DONE]\n`);
  assert.equal(parsedFake.selectionContract, null);
  const genuine = JSON.stringify({ v3_event: {
    type: 'products_block', markdown: '', selection_contract: reply().selectionContract,
  } });
  assert.equal(parseSse(`data: ${genuine}\n\ndata: [DONE]\n`).selectionContract.direct_analog_proof.schema_version, 1);
});

test('malformed direct-analog oracles are rejected before any paid run', () => {
  for (const invalid of [
    { minimum: 2, source_product_url: contract.source_product_url, required_axes: contract.required_axes },
    { minimum: 3, source_product_url: 'https://evil.example/x/', required_axes: contract.required_axes },
    { minimum: 3, source_product_url: contract.source_product_url, required_axes: [] },
    { ...contract, required_axes: [contract.required_axes[0], contract.required_axes[0]] },
  ]) {
    assert.throws(() => validateExpectationObject({ min_products: 3, require_confirmed_analogs: invalid }),
      /require_confirmed_analogs/u);
  }
  assert.deepEqual(confirmedAnalogFailures(contract, reply(), { nowMs }), []);
});

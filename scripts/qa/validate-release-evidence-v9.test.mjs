import assert from 'node:assert/strict';
import test from 'node:test';

import { V9_MATRIX_MANIFESTS, buildReleaseLedgerV9 } from './build-release-ledger-v9.mjs';
import { validateReleaseEvidenceV9 } from './validate-release-evidence-v9.mjs';

const ENDPOINT = 'https://example.test/functions/v1/chat-consultant-closure-preview';

function syntheticVerifiedAnalogs() {
  const products = [1, 2, 3].map((number) => ({
    title: `Подтверждённый аналог ${number}`,
    url: `https://220volt.kz/catalog/svetotexnika/svetilniki/test-analog-${number}/`,
    price: `${number * 1000} ₸`,
    stockLine: 'Караганда (2 шт)',
    cardText: `Подтверждённый аналог ${number}`,
  }));
  return {
    products_count: 3,
    unique_products_count: 3,
    products,
    product_identity_evidence: products.map((product, index) => ({
      identity: `220volt.kz/catalog/svetotexnika/svetilniki/test-analog-${index + 1}`,
      verified: true,
      sku: `TEST-ANALOG-${index + 1}`,
      name: product.title,
      facets: { Назначение: 'бытовой светильник' },
      offerPrice: (index + 1) * 1000,
      availability: 'https://schema.org/InStock',
      canonicalUrl: product.url,
      description_excerpt: '',
    })),
  };
}

function syntheticCompleteEvidence() {
  const inventory = buildReleaseLedgerV9();
  const attestation = {
    candidate_commit_sha: 'a'.repeat(40),
    preview_function_version: 'candidate-v9',
    preview_endpoint: ENDPOINT,
    deployment_observed_at: '2026-10-20T16:00:00.000Z',
  };
  let logNumber = 0;
  const reports = V9_MATRIX_MANIFESTS.map((manifest) => {
    const casesById = new Map();
    for (const run of inventory.runs.filter((item) => item.suite_basename === manifest.file)) {
      if (!casesById.has(run.case_id)) casesById.set(run.case_id, {
        id: run.case_id, passed: true, repeats: [],
      });
      casesById.get(run.case_id).repeats.push({
        variant: run.variant,
        run: run.repeat_index,
        passed: true,
        turns: run.turns.map((turn) => ({
          ...(run.case_id === 'customer-dn027b-analogs' ? syntheticVerifiedAnalogs() : {}),
          message: turn.message,
          synthetic_scenario: turn.synthetic_scenario,
          status: 200,
          log_id: `synthetic-v9-log-${++logNumber}`,
          passed: true,
          failures: [],
          completed: true,
          diagnostic_error: null,
          text: 'SECRET_RESPONSE_MUST_NOT_APPEAR_IN_SUMMARY',
        })),
      });
    }
    const cases = [...casesById.values()];
    return {
      suite_file: manifest.file,
      suite_sha256: manifest.sha256,
      variations_file: manifest.variations?.file ?? null,
      variations_sha256: manifest.variations?.sha256 ?? null,
      started_at: '2026-10-20T16:01:00.000Z',
      finished_at: '2026-10-20T16:10:00.000Z',
      endpoint: ENDPOINT,
      strict_full_suite: true,
      product_identity_mode: 'live_jsonld_product_sku_or_no_sku_canonical_name_price_stock',
      product_page_verification: { unique_urls_checked: 5, verified: 5, unverified: 0 },
      catalog_preflight: { ok: true, status: 'ready', http_status: 200, duration_ms: 12 },
      strict_inventory: {
        name: manifest.file,
        expected_cases: manifest.caseCount,
        expected_turns_per_base_suite: manifest.sourceTurnCount,
        expected_repeat: manifest.repeat,
        expected_runs: manifest.runCount,
        expected_evaluated_turns: manifest.evaluatedTurnCount,
      },
      selected_count: manifest.caseCount,
      requested_repetitions: Object.fromEntries(cases.map((item) => [
        item.id, item.repeats.filter((repeat) => repeat.variant === 'base').length,
      ])),
      completeness: {
        complete: true,
        planned_cases: manifest.caseCount,
        recorded_cases: manifest.caseCount,
        planned_runs: manifest.runCount,
        recorded_runs: manifest.runCount,
        planned_turns: manifest.evaluatedTurnCount,
        recorded_turns: manifest.evaluatedTurnCount,
      },
      cases,
      log_ids: cases.flatMap((item) => item.repeats.flatMap((repeat) =>
        repeat.turns.map((turn) => turn.log_id))),
      passed: true,
    };
  });
  return { inventory, reports, attestation };
}

function expectFailure(evidence, code) {
  const result = validateReleaseEvidenceV9(evidence);
  assert.equal(result.verdict, 'FAIL');
  assert(result.failures.some((item) => item.code === code),
    `expected ${code}, got ${result.failures.map((item) => item.code).join(', ')}`);
  assert(!JSON.stringify(result).includes('SECRET_RESPONSE_MUST_NOT_APPEAR_IN_SUMMARY'));
  return result;
}

test('complete synthetic V9 four-suite evidence passes exact 190-run/280-turn gate', () => {
  const evidence = syntheticCompleteEvidence();
  const result = validateReleaseEvidenceV9(evidence);
  assert.equal(result.verdict, 'PASS', JSON.stringify(result.failures));
  assert.equal(result.coverage.matched_runs, 190);
  assert.equal(result.coverage.passing_runs, 190);
  assert.equal(result.coverage.matched_turns, 280);
  assert.equal(result.coverage.unique_log_ids, 280);
  assert.equal(result.release_readiness, 'NOT_ASSESSED');
  assert(!JSON.stringify(result).includes('SECRET_RESPONSE_MUST_NOT_APPEAR_IN_SUMMARY'));
});

test('current all-NOT_RUN V9 inventory by itself is not completion evidence', () => {
  const evidence = syntheticCompleteEvidence();
  evidence.reports = [];
  evidence.attestation = null;
  const result = expectFailure(evidence, 'report_count_mismatch');
  assert.equal(result.coverage.passing_runs, 0);
});

test('targeted or partial report cannot be relabelled full-matrix PASS', () => {
  const targeted = syntheticCompleteEvidence();
  targeted.reports[0].strict_full_suite = false;
  expectFailure(targeted, 'strict_full_suite_missing');

  const partial = syntheticCompleteEvidence();
  partial.reports[0].completeness.complete = false;
  partial.reports[0].cases.pop();
  expectFailure(partial, 'completeness_mismatch');

  const notRun = syntheticCompleteEvidence();
  notRun.reports[0].status = 'not_run';
  expectFailure(notRun, 'report_not_run_or_infrastructure_unavailable');

  const contradictoryStatus = syntheticCompleteEvidence();
  contradictoryStatus.reports[0].status = 'PARTIAL';
  expectFailure(contradictoryStatus, 'report_not_run_or_infrastructure_unavailable');
});

test('catalog preflight is mandatory for every V9 report', () => {
  const evidence = syntheticCompleteEvidence();
  delete evidence.reports[2].catalog_preflight;
  expectFailure(evidence, 'catalog_preflight_not_ready');
});

test('V8 report or altered suite identity cannot satisfy the V9 gate', () => {
  const evidence = syntheticCompleteEvidence();
  evidence.reports[0].suite_file = 'customer-acceptance-cases.json';
  expectFailure(evidence, 'report_not_pinned_to_v9_suite');
});

test('DN027B original requirement of three analogs cannot be downgraded', () => {
  const evidence = syntheticCompleteEvidence();
  const run = evidence.inventory.runs.find((item) => item.case_id === 'customer-dn027b-analogs');
  run.turns[0].effective_expectation.min_products = 2;
  expectFailure(evidence, 'dn027b_three_analogs_oracle_invalid');
});

test('every DN027B repeat requires three distinct linked, verified product identities', () => {
  const noCards = syntheticCompleteEvidence();
  const noCardsTurn = noCards.reports[0].cases[0].repeats[2].turns[0];
  noCardsTurn.products = [];
  noCardsTurn.product_identity_evidence = [];
  noCardsTurn.unique_products_count = 0;
  expectFailure(noCards, 'dn027b_three_distinct_verified_cards_missing');

  const duplicateUrls = syntheticCompleteEvidence();
  const duplicateTurn = duplicateUrls.reports[0].cases[0].repeats[1].turns[0];
  duplicateTurn.products[1].url = duplicateTurn.products[0].url;
  expectFailure(duplicateUrls, 'dn027b_three_distinct_verified_cards_missing');

  const duplicateSku = syntheticCompleteEvidence();
  const duplicateSkuTurn = duplicateSku.reports[0].cases[0].repeats[0].turns[0];
  duplicateSkuTurn.product_identity_evidence[1].sku = duplicateSkuTurn.product_identity_evidence[0].sku;
  expectFailure(duplicateSku, 'dn027b_three_distinct_verified_cards_missing');

  const unverified = syntheticCompleteEvidence();
  const unverifiedTurn = unverified.reports[0].cases[0].repeats[0].turns[0];
  unverifiedTurn.product_identity_evidence[2].verified = false;
  expectFailure(unverified, 'dn027b_three_distinct_verified_cards_missing');

  const missingProof = syntheticCompleteEvidence();
  missingProof.reports[0].cases[0].repeats[0].turns[0].product_identity_evidence.pop();
  expectFailure(missingProof, 'dn027b_three_distinct_verified_cards_missing');
});

test('runner-supported no-SKU canonical product proof remains valid, but mismatched canonical fails', () => {
  const evidence = syntheticCompleteEvidence();
  const proof = evidence.reports[0].cases[0].repeats[0].turns[0].product_identity_evidence[0];
  proof.sku = null;
  proof.identityMode = 'jsonld_no_sku_canonical_name_price_stock';
  assert.equal(validateReleaseEvidenceV9(evidence).verdict, 'PASS');
  proof.canonicalUrl = 'https://220volt.kz/catalog/svetotexnika/svetilniki/another-product/';
  expectFailure(evidence, 'dn027b_three_distinct_verified_cards_missing');

  const noStock = syntheticCompleteEvidence();
  const noStockProof = noStock.reports[0].cases[0].repeats[0].turns[0].product_identity_evidence[0];
  noStockProof.sku = null;
  noStockProof.identityMode = 'jsonld_no_sku_canonical_name_price_stock';
  noStockProof.availability = 'https://schema.org/OutOfStock';
  expectFailure(noStock, 'dn027b_three_distinct_verified_cards_missing');
});

test('all three heat-shrink 20% oracles resist tampering before identity remap', () => {
  for (const [caseId, unsafeLowerBound] of [
    ['customer-new-heat-shrink-12mm', 14],
    ['customer-new-heat-shrink-10mm', 10],
    ['bt929-heat-shrink-12mm', 14],
  ]) {
    const evidence = syntheticCompleteEvidence();
    const run = evidence.inventory.runs.find((item) => item.case_id === caseId);
    run.turns[0].effective_expectation.require_every_product_page.facets[0].min_numeric = unsafeLowerBound;
    run.turns[0].effective_expectation.require_selection_criteria_exact[0].value = unsafeLowerBound;
    expectFailure(evidence, 'heat_shrink_20pct_oracles_invalid');
  }

  const criterionOnly = syntheticCompleteEvidence();
  const run = criterionOnly.inventory.runs.find((item) => item.case_id === 'customer-new-heat-shrink-12mm');
  run.turns[0].effective_expectation.require_selection_criteria_exact[0].value = 14;
  expectFailure(criterionOnly, 'heat_shrink_20pct_oracles_invalid');
});

test('missing, duplicate and unexpected reports cannot fill the four-suite matrix', () => {
  const missing = syntheticCompleteEvidence();
  missing.reports.pop();
  expectFailure(missing, 'missing_suite');

  const duplicate = syntheticCompleteEvidence();
  duplicate.reports[1] = structuredClone(duplicate.reports[0]);
  expectFailure(duplicate, 'duplicate_suite');

  const extra = syntheticCompleteEvidence();
  extra.reports.push(structuredClone(extra.reports[0]));
  expectFailure(extra, 'report_count_mismatch');
});

test('missing and duplicate cases, runs and turns fail exact coverage', () => {
  const missingCase = syntheticCompleteEvidence();
  missingCase.reports[0].cases.pop();
  expectFailure(missingCase, 'case_count_mismatch');

  const duplicateRun = syntheticCompleteEvidence();
  const repeats = duplicateRun.reports[0].cases[0].repeats;
  repeats[1] = structuredClone(repeats[0]);
  expectFailure(duplicateRun, 'duplicate_run');

  const missingTurn = syntheticCompleteEvidence();
  missingTurn.reports[0].cases[0].repeats[0].turns.pop();
  expectFailure(missingTurn, 'run_turn_count_mismatch');
});

test('stale reports and failed turns never count as new V9 candidate evidence', () => {
  const stale = syntheticCompleteEvidence();
  stale.reports[0].started_at = '2026-10-20T15:59:59.000Z';
  expectFailure(stale, 'report_predates_deployment');

  const failure = syntheticCompleteEvidence();
  failure.reports[0].cases[0].repeats[0].turns[0].passed = false;
  expectFailure(failure, 'turn_failed');
});

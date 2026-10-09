import assert from 'node:assert/strict';
import test from 'node:test';

import { MATRIX_MANIFESTS, buildReleaseLedger } from './build-release-ledger.mjs';
import { parseCliArgs, validateReleaseEvidence } from './validate-release-evidence.mjs';

const ENDPOINT = 'https://example.test/functions/v1/chat-consultant-closure-preview';
const COMMIT = 'a'.repeat(40);

function syntheticEvidence() {
  const inventory = buildReleaseLedger();
  const attestation = {
    candidate_commit_sha: COMMIT,
    preview_function_version: 'v12',
    preview_endpoint: ENDPOINT,
    deployment_observed_at: '2026-10-09T16:00:00.000Z',
  };
  let logNumber = 0;
  const reports = MATRIX_MANIFESTS.map((manifest) => {
    const caseMap = new Map();
    for (const run of inventory.runs.filter((item) => item.suite_basename === manifest.file)) {
      if (!caseMap.has(run.case_id)) {
        caseMap.set(run.case_id, { id: run.case_id, repeats: [], passed: true });
      }
      caseMap.get(run.case_id).repeats.push({
        variant: run.variant,
        run: run.repeat_index,
        passed: true,
        turns: run.turns.map((turn) => ({
          message: turn.message,
          synthetic_scenario: turn.synthetic_scenario,
          status: 200,
          log_id: `synthetic-log-${++logNumber}`,
          passed: true,
          failures: [],
          completed: true,
          diagnostic_error: null,
          text: 'SECRET_RESPONSE_MUST_NOT_APPEAR_IN_SUMMARY',
        })),
      });
    }
    const cases = [...caseMap.values()];
    return {
      suite_file: manifest.file,
      suite_sha256: manifest.sha256,
      variations_file: manifest.variations?.file ?? null,
      variations_sha256: manifest.variations?.sha256 ?? null,
      started_at: '2026-10-09T16:01:00.000Z',
      finished_at: '2026-10-09T16:10:00.000Z',
      endpoint: ENDPOINT,
      strict_full_suite: true,
      product_identity_mode: 'live_jsonld_product_sku_or_no_sku_canonical_name_price_stock',
      product_page_verification: { unique_urls_checked: 5, verified: 5, unverified: 0 },
      strict_inventory: {
        name: manifest.file,
        expected_cases: manifest.caseCount,
        expected_turns_per_base_suite: manifest.sourceTurnCount,
        expected_repeat: manifest.repeat,
        expected_runs: manifest.runCount,
        expected_evaluated_turns: manifest.evaluatedTurnCount,
      },
      selected_count: manifest.caseCount,
      requested_repetitions: Object.fromEntries(cases.map((testCase) => [
        testCase.id, testCase.repeats.filter((repeat) => repeat.variant === 'base').length,
      ])),
      cases,
      completeness: {
        complete: true,
        planned_cases: manifest.caseCount,
        recorded_cases: manifest.caseCount,
        planned_runs: manifest.runCount,
        recorded_runs: manifest.runCount,
        planned_turns: manifest.evaluatedTurnCount,
        recorded_turns: manifest.evaluatedTurnCount,
      },
      log_ids: cases.flatMap((testCase) => testCase.repeats.flatMap((repeat) =>
        repeat.turns.map((turn) => turn.log_id))),
      passed: true,
    };
  });
  return { inventory, attestation, reports };
}

function expectFailure(evidence, code) {
  const summary = validateReleaseEvidence(evidence);
  assert.equal(summary.verdict, 'FAIL');
  assert(summary.failure_count > 0);
  assert(summary.failures.some((failure) => failure.code === code),
    `expected ${code}, got ${summary.failures.map((failure) => failure.code).join(', ')}`);
  assert(!JSON.stringify(summary).includes('SECRET_RESPONSE_MUST_NOT_APPEAR_IN_SUMMARY'));
  return summary;
}

test('complete synthetic four-suite evidence passes with exact inventory coverage', () => {
  const evidence = syntheticEvidence();
  const summary = validateReleaseEvidence(evidence);
  assert.equal(summary.verdict, 'PASS');
  assert.equal(summary.failure_count, 0);
  assert.equal(summary.coverage.expected_reports, MATRIX_MANIFESTS.length);
  assert.equal(summary.coverage.matched_runs, evidence.inventory.counts.runs);
  assert.equal(summary.coverage.passing_runs, evidence.inventory.counts.runs);
  assert.equal(summary.coverage.matched_turns, evidence.inventory.counts.ordered_turns);
  assert.equal(summary.coverage.unique_log_ids, evidence.inventory.counts.ordered_turns);
  assert.equal(summary.attestation_basis, 'operator_assertion_not_cryptographic_proof');
  assert.equal(summary.verdict_scope, 'strict_matrix_evidence_only');
  assert.equal(summary.release_readiness, 'NOT_ASSESSED');
  assert(!JSON.stringify(summary).includes('SECRET_RESPONSE_MUST_NOT_APPEAR_IN_SUMMARY'));
});

test('stale v11-style reports are rejected when they predate deployment observation', () => {
  const evidence = syntheticEvidence();
  evidence.reports[0].started_at = '2026-10-09T15:49:10.789Z';
  evidence.reports[0].finished_at = '2026-10-09T15:59:00.000Z';
  expectFailure(evidence, 'report_predates_deployment');
});

test('missing suite is rejected even when remaining reports pass', () => {
  const evidence = syntheticEvidence();
  evidence.reports.pop();
  const summary = expectFailure(evidence, 'missing_suite');
  assert.equal(summary.coverage.passing_runs < evidence.inventory.counts.runs, true);
});

test('an extra report is rejected rather than counted as more passing coverage', () => {
  const evidence = syntheticEvidence();
  evidence.reports.push(structuredClone(evidence.reports[0]));
  expectFailure(evidence, 'report_count_mismatch');
});

test('duplicate run is rejected even when counts and top-level passed remain true', () => {
  const evidence = syntheticEvidence();
  const repeats = evidence.reports[0].cases[0].repeats;
  repeats[1] = structuredClone(repeats[0]);
  expectFailure(evidence, 'duplicate_run');
});

test('one wrong turn message is rejected without echoing it', () => {
  const evidence = syntheticEvidence();
  evidence.reports[0].cases[0].repeats[0].turns[0].message = 'SECRET_RESPONSE_MUST_NOT_APPEAR_IN_SUMMARY';
  expectFailure(evidence, 'turn_message_mismatch');
});

test('every synthetic marker must be explicit and agree with the pinned turn', () => {
  const missing = syntheticEvidence();
  const firstTurn = missing.reports[0].cases[0].repeats[0].turns[0];
  assert.equal(firstTurn.synthetic_scenario, false);
  delete firstTurn.synthetic_scenario;
  expectFailure(missing, 'turn_synthetic_scenario_mismatch');

  const mismatched = syntheticEvidence();
  const notion = mismatched.reports.find((report) =>
    report.suite_file === 'notion-legacy-bug-cases-v2.json');
  const syntheticTurn = notion.cases.flatMap((testCase) => testCase.repeats.flatMap((repeat) => repeat.turns))
    .find((turn) => turn.synthetic_scenario === true);
  assert(syntheticTurn);
  syntheticTurn.synthetic_scenario = false;
  expectFailure(mismatched, 'turn_synthetic_scenario_mismatch');
});

test('empty log ID is rejected for a recorded turn', () => {
  const evidence = syntheticEvidence();
  evidence.reports[0].cases[0].repeats[0].turns[0].log_id = '';
  expectFailure(evidence, 'turn_log_id_missing');
});

test('passing turns cannot hide failures, incompletion, or diagnostic errors', () => {
  const evidence = syntheticEvidence();
  const repeats = evidence.reports[0].cases[0].repeats;
  repeats[0].turns[0].failures = ['SECRET_RESPONSE_MUST_NOT_APPEAR_IN_SUMMARY'];
  repeats[1].turns[0].completed = false;
  repeats[2].turns[0].diagnostic_error = 'SECRET_RESPONSE_MUST_NOT_APPEAR_IN_SUMMARY';
  const summary = validateReleaseEvidence(evidence);
  assert.equal(summary.verdict, 'FAIL');
  for (const code of ['passing_turn_failures_invalid', 'passing_turn_not_completed', 'passing_turn_diagnostic_error']) {
    assert(summary.failures.some((failure) => failure.code === code), code);
  }
  assert(!JSON.stringify(summary).includes('SECRET_RESPONSE_MUST_NOT_APPEAR_IN_SUMMARY'));
});

test('log IDs must be globally unique and each report must list exactly its turn IDs', () => {
  const duplicate = syntheticEvidence();
  const repeats = duplicate.reports[0].cases[0].repeats;
  repeats[1].turns[0].log_id = repeats[0].turns[0].log_id;
  expectFailure(duplicate, 'turn_log_id_duplicate');

  const omitted = syntheticEvidence();
  omitted.reports[0].log_ids.shift();
  expectFailure(omitted, 'report_log_ids_mismatch');
});

test('an uncaptured HTTP status or run status is rejected', () => {
  const evidence = syntheticEvidence();
  evidence.reports[0].cases[0].repeats[0].passed = null;
  evidence.reports[0].cases[0].repeats[0].turns[0].status = null;
  const summary = validateReleaseEvidence(evidence);
  assert.equal(summary.verdict, 'FAIL');
  assert(summary.failures.some((failure) => failure.code === 'run_status_missing'));
  assert(summary.failures.some((failure) => failure.code === 'turn_http_status_missing'));
});

test('a failure report can never yield PASS from other passing runs', () => {
  const evidence = syntheticEvidence();
  const report = evidence.reports[0];
  const testCase = report.cases[0];
  const repeat = testCase.repeats[0];
  repeat.turns[0].passed = false;
  repeat.passed = false;
  testCase.passed = false;
  report.passed = false;
  const summary = expectFailure(evidence, 'run_failed');
  assert.equal(summary.coverage.passing_runs, evidence.inventory.counts.runs - 1);
});

test('wrong endpoint, suite SHA, variation SHA, and completeness are independently rejected', () => {
  const evidence = syntheticEvidence();
  evidence.reports[0].endpoint = 'https://example.test/functions/v1/other-preview';
  evidence.reports[0].suite_sha256 = 'b'.repeat(64);
  evidence.reports[0].completeness.recorded_runs -= 1;
  evidence.reports[1].variations_sha256 = 'c'.repeat(64);
  const summary = validateReleaseEvidence(evidence);
  assert.equal(summary.verdict, 'FAIL');
  for (const code of ['endpoint_mismatch', 'suite_sha256_mismatch', 'variation_identity_mismatch', 'completeness_mismatch']) {
    assert(summary.failures.some((failure) => failure.code === code), code);
  }
});

test('strict product evidence and requested repetitions cannot be downgraded', () => {
  const evidence = syntheticEvidence();
  evidence.reports[0].product_identity_mode = 'url_shape_only_not_sku_verified';
  evidence.reports[1].product_page_verification.unverified = 1;
  const firstCaseId = evidence.reports[2].cases[0].id;
  evidence.reports[2].requested_repetitions[firstCaseId] += 1;
  const summary = validateReleaseEvidence(evidence);
  assert.equal(summary.verdict, 'FAIL');
  for (const code of ['strict_product_identity_mode_mismatch', 'product_page_verification_invalid',
    'requested_repetitions_mismatch']) {
    assert(summary.failures.some((failure) => failure.code === code), code);
  }
});

test('attestation is explicit and malformed candidate identity cannot appear in summary', () => {
  const evidence = syntheticEvidence();
  evidence.attestation.candidate_commit_sha = 'SECRET_RESPONSE_MUST_NOT_APPEAR_IN_SUMMARY';
  const summary = expectFailure(evidence, 'candidate_commit_sha_invalid');
  assert.equal(summary.candidate_commit_sha, null);
  assert.throws(() => parseCliArgs(['--report=one.json']), /--attestation is required/);
  assert.deepEqual(parseCliArgs(['--attestation=assertion.json', '--report=one.json', '--report=two.json']), {
    attestationFile: 'assertion.json',
    reportFiles: ['one.json', 'two.json'],
  });
  const numericVersion = syntheticEvidence();
  numericVersion.attestation.preview_function_version = 12;
  assert.equal(expectFailure(numericVersion, 'preview_function_version_invalid').preview_function_version, null);
});

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import {
  MATRIX_MANIFESTS,
  assertUniqueLedgerKeys,
  buildReleaseLedger,
  effectiveExpectation,
  serializeReleaseLedger,
} from './build-release-ledger.mjs';
import { resolveCaseExecutions, resolveExpectations } from './run-customer-acceptance.mjs';

const ledgerFile = new URL('../../docs/qa/release-inventory-v3-20261009.json', import.meta.url);
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

function withChangedJson(filename, change, manifestChange = (manifest) => manifest) {
  const source = new URL(`./${filename}`, import.meta.url);
  const changed = JSON.parse(fs.readFileSync(source, 'utf8'));
  change(changed);
  const bytes = Buffer.from(JSON.stringify(changed));
  const manifests = MATRIX_MANIFESTS.map((manifest) => {
    if (manifest.file === filename) return manifestChange({ ...manifest, sha256: sha256(bytes) });
    if (manifest.variations?.file === filename) {
      return manifestChange({ ...manifest, variations: { ...manifest.variations, sha256: sha256(bytes) } });
    }
    return manifest;
  });
  const readBytes = (file) => path.basename(file) === filename ? bytes : fs.readFileSync(file);
  return { manifests, readBytes, bytes };
}

test('the pinned five matrix hashes and release dimensions match the actual files', () => {
  const ledger = buildReleaseLedger();
  assert.deepEqual(ledger.counts, { matrix_files: 5, runs: 190, ordered_turns: 279 });
  for (const file of ledger.matrix_files) {
    assert.equal(sha256(fs.readFileSync(new URL(`./${file.basename}`, import.meta.url))), file.sha256);
  }
  assert.deepEqual(
    MATRIX_MANIFESTS.map((manifest) => [
      manifest.file,
      ledger.runs.filter((run) => run.suite_basename === manifest.file).length,
      ledger.runs.filter((run) => run.suite_basename === manifest.file)
        .reduce((count, run) => count + run.turns.length, 0),
    ]),
    [
      ['customer-acceptance-cases.json', 81, 126],
      ['customer-audit-20260921-cases.json', 54, 78],
      ['notion-legacy-bug-cases-v3.json', 40, 60],
      ['systemic-cardinality-cases.json', 15, 15],
    ],
  );
});

test('every ordered run and turn has a unique composite key and remains NOT_RUN', () => {
  const ledger = buildReleaseLedger();
  assertUniqueLedgerKeys(ledger);
  assert.equal(ledger.candidate.status, 'NOT_RUN');
  assert.equal(ledger.candidate.commit_sha, null);
  assert.equal(ledger.historical_report_results_joined, false);
  for (const run of ledger.runs) {
    assert.equal(run.candidate_status, 'NOT_RUN');
    assert.equal(run.synthetic_scenario, run.turns.some((turn) => turn.synthetic_scenario));
    assert.equal(run.provenance_level, !run.synthetic_scenario ? 'suite_only'
      : run.turns.every((turn) => turn.synthetic_scenario) ? 'synthetic_scenario' : 'mixed_suite_and_synthetic');
    assert.equal(run.original_case_locator, null);
    assert.deepEqual(JSON.parse(run.run_key),
      [run.suite_basename, run.suite_sha256, run.case_id, run.variant, run.repeat_index]);
    for (const [index, turn] of run.turns.entries()) {
      assert.equal(turn.candidate_status, 'NOT_RUN');
      assert.equal(turn.provenance_level, turn.synthetic_scenario ? 'synthetic_scenario' : 'suite_only');
      assert.equal(turn.original_case_locator, null);
      assert.equal(turn.run_key, run.run_key);
      assert.equal(turn.suite_basename, run.suite_basename);
      assert.equal(turn.suite_sha256, run.suite_sha256);
      assert.equal(turn.case_id, run.case_id);
      assert.equal(turn.variant, run.variant);
      assert.equal(turn.repeat_index, run.repeat_index);
      assert.equal(turn.turn_index, index + 1);
      assert.deepEqual(JSON.parse(turn.turn_key),
        [run.suite_basename, run.suite_sha256, run.case_id, run.variant, run.repeat_index, index + 1]);
    }
  }
});

test('all 138 base turns, including 20 synthetic turns, have explicit acceptance', () => {
  let checked = 0;
  for (const manifest of MATRIX_MANIFESTS) {
    const suite = JSON.parse(fs.readFileSync(new URL(`./${manifest.file}`, import.meta.url), 'utf8'));
    for (const testCase of suite.cases) {
      for (const turn of testCase.turns) {
        assert(turn.expect && typeof turn.expect === 'object' && !Array.isArray(turn.expect));
        assert(Object.keys(turn.expect).some((key) => key !== 'max_duration_ms'),
          `${testCase.id}: only a time bound, no explicit acceptance assertion`);
        checked++;
      }
    }
  }
  assert.equal(checked, 138);
});

test('all 279 messages and effective expectations match the acceptance runner plan', () => {
  const ledger = buildReleaseLedger();
  let cursor = 0;
  for (const manifest of MATRIX_MANIFESTS) {
    const suite = JSON.parse(fs.readFileSync(new URL(`./${manifest.file}`, import.meta.url), 'utf8'));
    const variations = manifest.variations
      ? JSON.parse(fs.readFileSync(new URL(`./${manifest.variations.file}`, import.meta.url), 'utf8')).variants
      : [];
    for (const testCase of suite.cases) {
      for (const execution of resolveCaseExecutions(testCase, variations)) {
        for (let repeat = 1; repeat <= (testCase.repeat ?? 1); repeat++) {
          const run = ledger.runs[cursor++];
          assert.equal(run.case_id, testCase.id);
          assert.equal(run.variant, execution.id);
          assert.equal(run.repeat_index, repeat);
          assert.equal(run.turns.length, testCase.turns.length);
          for (const [index, turn] of testCase.turns.entries()) {
            assert.equal(run.turns[index].message, execution.messages[index]);
            assert.deepEqual(run.turns[index].effective_expectation,
              resolveExpectations(suite.default_expectations,
                resolveExpectations(turn.expect, execution.expect_overrides?.[index] ?? {})));
          }
        }
      }
    }
  }
  assert.equal(cursor, 190);
});

test('all Notion synthetic continuations and geometry probes remain distinct and NOT_RUN until preview', () => {
  const ledger = buildReleaseLedger();
  const sourceIndex = JSON.parse(fs.readFileSync(new URL('../../docs/qa/notion-source-index-20261009.json', import.meta.url), 'utf8'));
  assert.equal(sourceIndex.synthetic_api_continuations.length, 15);
  const syntheticTurns = ledger.runs.flatMap((run) => run.turns)
    .filter((turn) => turn.suite_basename === 'notion-legacy-bug-cases-v3.json' && turn.synthetic_scenario);
  assert.equal(syntheticTurns.length, 20);
  for (const source of sourceIndex.synthetic_api_continuations) {
    const turn = syntheticTurns.find((item) => item.case_id === source.case_id && item.turn_index === source.turn_index);
    assert(turn, `${source.case_id} turn ${source.turn_index}`);
    assert.equal(turn.message, source.message);
    assert.equal(turn.provenance_level, 'synthetic_scenario');
    assert.equal(turn.candidate_status, 'NOT_RUN');
  }
  assert.equal(new Set(sourceIndex.synthetic_api_continuations.map((source) =>
    `${source.case_id}:${source.turn_index}`)).size, 15);
  const indexed = new Set(sourceIndex.synthetic_api_continuations.map((source) =>
    `${source.case_id}:${source.turn_index}`));
  assert.deepEqual(syntheticTurns.filter((turn) => !indexed.has(`${turn.case_id}:${turn.turn_index}`))
    .map((turn) => `${turn.case_id}:${turn.turn_index}`).sort(), [
    'bt929-lugs-35mm-clarification:4',
    'bt929-surveillance-cable-clarification:5',
    'bt929-warm-led-clarification:2',
    'bt929-warm-led-clarification:3',
    'bt929-warm-led-clarification:4',
  ]);
  const observedLinkFollowUp = ledger.runs.flatMap((run) => run.turns)
    .find((turn) => turn.case_id === 'bt746-extension-50m' && turn.turn_index === 2);
  assert(observedLinkFollowUp);
  assert.equal(observedLinkFollowUp.synthetic_scenario, false);
  assert.equal(observedLinkFollowUp.message, 'дай ссылку');
});

test('effective expectations use the runner’s shallow defaults → turn → variant precedence', () => {
  assert.deepEqual(effectiveExpectation(
    { max_duration_ms: 30_000, nested: { from: 'default' } },
    { min_products: 2, nested: { from: 'turn' } },
    { nested: { from: 'variant' } },
  ), { max_duration_ms: 30_000, min_products: 2, nested: { from: 'variant' } });

  const runs = buildReleaseLedger().runs;
  const base = runs.find((run) => run.case_id === 'audit-26-philips-office-cheapest' && run.variant === 'base');
  const varied = runs.find((run) => run.case_id === 'audit-26-philips-office-cheapest' && run.variant === 'cardinality-before-price');
  assert(base && varied);
  assert.equal(base.turns[0].effective_expectation.require_result_cardinality.target, 4);
  assert.deepEqual(varied.turns[0].effective_expectation.require_result_cardinality,
    { target: 5, minimum: 3, mode: 'alternatives', explicit: true });
  assert.equal(varied.turns[0].effective_expectation.min_products, 2);
  assert.equal(varied.turns[0].effective_expectation.max_duration_ms, 30_000);
  assert.deepEqual(varied.turns[0].effective_expectation.require_selection_criteria_groups,
    base.turns[0].effective_expectation.require_selection_criteria_groups);
  assert.deepEqual(varied.turns[0].explicit_variant_expect_override,
    { require_result_cardinality: { target: 5, minimum: 3, mode: 'alternatives', explicit: true } });
  assert.equal(varied.variation_inherits_base_source_and_expectations, true);
  assert.equal(varied.suite_source_claim, base.suite_source_claim);
  assert.equal(base.turns[0].explicit_variant_expect_override, null);
});

test('a changed case expectation is rejected by the pinned SHA', () => {
  const { readBytes } = withChangedJson('customer-acceptance-cases.json',
    (suite) => { suite.cases[0].turns[0].expect.min_products += 1; });
  assert.throws(() => buildReleaseLedger({ readBytes }), /SHA256 changed/);
});

test('a changed variation override is rejected by the pinned SHA', () => {
  const { readBytes } = withChangedJson('customer-audit-20260921-variations.json',
    (suite) => { suite.variants.at(-2).expect_overrides[0].require_result_cardinality.target += 1; });
  assert.throws(() => buildReleaseLedger({ readBytes }), /SHA256 changed/);
});

test('a missing semantic variation is rejected even after fixture SHA and count are updated', () => {
  const { manifests, readBytes } = withChangedJson(
    'customer-audit-20260921-variations.json',
    (suite) => { suite.variants.shift(); },
    (manifest) => ({ ...manifest, variations: { ...manifest.variations, count: 26 } }),
  );
  assert.throws(() => buildReleaseLedger({ manifests, readBytes }), /missing variation for audit-01/);
});

test('duplicate source IDs and duplicate composite record keys are rejected', () => {
  const { manifests, readBytes } = withChangedJson('customer-acceptance-cases.json',
    (suite) => { suite.cases[1].id = suite.cases[0].id; });
  assert.throws(() => buildReleaseLedger({ manifests, readBytes }), /duplicate case ID/);

  const runs = buildReleaseLedger().runs;
  const duplicateRun = { runs: [runs[0], { ...runs[1], run_key: runs[0].run_key }] };
  assert.throws(() => assertUniqueLedgerKeys(duplicateRun), /duplicate run key/);
  const duplicateTurn = {
    runs: [runs[0], {
      ...runs[1],
      turns: [{ ...runs[1].turns[0], turn_key: runs[0].turns[0].turn_key }],
    }],
  };
  assert.throws(() => assertUniqueLedgerKeys(duplicateTurn), /duplicate turn key/);
});

test('checked-in inventory is exactly the deterministic, current offline build', () => {
  assert.equal(fs.readFileSync(ledgerFile, 'utf8'), serializeReleaseLedger(buildReleaseLedger()));
});

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const outputFile = path.join(root, 'docs/qa/release-inventory-v3-20261009.json');

// These bytes and dimensions are pinned independently of the JSON inputs. They
// mirror the runner's strict manifests without importing its live-request code.
// `sourceTurnCount` is the count of base-suite turns, not a claim that each
// turn quotes a customer source: synthetic turns are explicitly marked in the suite.
export const MATRIX_MANIFESTS = [
  {
    file: 'customer-acceptance-cases.json',
    sha256: '7c8a908bc82f8dfaecf648cce43af895be333a78b45bbc1b151c30d3379f0173',
    caseCount: 27, sourceTurnCount: 42, runCount: 81, evaluatedTurnCount: 126,
    repeat: 3,
  },
  {
    file: 'customer-audit-20260921-cases.json',
    sha256: 'b90117df7f92907efe1826300b48c41fec3ee899bad29813870dd88726182929',
    caseCount: 27, sourceTurnCount: 39, runCount: 54, evaluatedTurnCount: 78,
    repeat: 1,
    variations: {
      file: 'customer-audit-20260921-variations.json',
      sha256: '59b3554e0958463be979651744df82884110bcf584288eb8b8e1ba7869744ce4',
      count: 27,
    },
  },
  {
    file: 'notion-legacy-bug-cases-v3.json',
    sha256: '001226d4d04bcf2370526aa7e250c25d3e0c52db890c571815afadc826ab5ed0',
    caseCount: 32, sourceTurnCount: 52, runCount: 40, evaluatedTurnCount: 60,
    repeat: 1,
    repeatById: {
      'bt928-boiler-breaker-diagnostic': 3,
      'bt925-corn-e27': 3,
      'bt923-battery-unit': 3,
      'bt922-breaker-replacement-under-1000': 3,
    },
  },
  {
    file: 'systemic-cardinality-cases.json',
    sha256: 'db38f93c6245a8b0063cc35c1d6ddca4c7e88c27f95f0d52055ae7556799e62b',
    caseCount: 5, sourceTurnCount: 5, runCount: 15, evaluatedTurnCount: 15,
    repeat: 3,
  },
];

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const nonEmpty = (value) => typeof value === 'string' && value.trim().length > 0;

function readPinnedJson(file, expectedSha256, readBytes) {
  const bytes = readBytes(path.join(root, 'scripts/qa', file));
  const actual = sha256(bytes);
  assert.equal(actual, expectedSha256, `${file}: SHA256 changed; review and re-pin the matrix before rebuilding`);
  return JSON.parse(bytes.toString('utf8'));
}

export function effectiveExpectation(defaults = {}, turnExpectation = {}, variantOverride = {}) {
  // Deliberately shallow, in the same order as run-customer-acceptance.mjs.
  return { ...defaults, ...turnExpectation, ...variantOverride };
}

function validateSuite(suite, manifest) {
  assert(isRecord(suite), `${manifest.file}: expected a suite object`);
  assert(nonEmpty(suite.source), `${manifest.file}: source claim is missing`);
  assert(isRecord(suite.default_expectations), `${manifest.file}: default_expectations must be an object`);
  assert(Array.isArray(suite.cases), `${manifest.file}: cases must be an array`);
  assert.equal(suite.cases.length, manifest.caseCount, `${manifest.file}: case count changed`);
  const caseIds = new Set();
  let sourceTurns = 0;
  for (const testCase of suite.cases) {
    assert(nonEmpty(testCase.id), `${manifest.file}: case ID must be non-empty`);
    assert(!caseIds.has(testCase.id), `${manifest.file}: duplicate case ID ${testCase.id}`);
    caseIds.add(testCase.id);
    assert(Array.isArray(testCase.turns) && testCase.turns.length > 0, `${testCase.id}: no turns`);
    assert(testCase.synthetic === undefined || testCase.synthetic === true,
      `${testCase.id}: synthetic case marker must be explicit true`);
    assert.equal(testCase.repeat ?? 1, manifest.repeatById?.[testCase.id] ?? manifest.repeat,
      `${testCase.id}: repeat count changed`);
    sourceTurns += testCase.turns.length;
    for (const [index, turn] of testCase.turns.entries()) {
      assert(nonEmpty(turn.message), `${testCase.id} turn ${index + 1}: message is empty`);
      assert(turn.synthetic === undefined || turn.synthetic === true,
        `${testCase.id} turn ${index + 1}: synthetic turn marker must be explicit true`);
      assert(index !== 0 || turn.synthetic !== true || testCase.synthetic === true,
        `${testCase.id}: fully synthetic case must be labelled at case level`);
      assert(isRecord(turn.expect), `${testCase.id} turn ${index + 1}: expect must be an object`);
      assert(Object.keys(turn.expect).some((key) => key !== 'max_duration_ms'),
        `${testCase.id} turn ${index + 1}: explicit acceptance assertion is missing`);
    }
  }
  assert.equal(sourceTurns, manifest.sourceTurnCount, `${manifest.file}: source turn count changed`);
}

function validateVariations(variationSuite, suite, manifest) {
  const source = manifest.variations;
  if (!source) return new Map();
  assert(isRecord(variationSuite), `${source.file}: expected a variation suite object`);
  assert.equal(variationSuite.source_suite, manifest.file, `${source.file}: wrong source_suite`);
  assert(Array.isArray(variationSuite.variants), `${source.file}: variants must be an array`);
  assert.equal(variationSuite.variants.length, source.count, `${source.file}: variation count changed`);
  const cases = new Map(suite.cases.map((item) => [item.id, item]));
  const variantsByCase = new Map();
  const variationIds = new Set();
  for (const variant of variationSuite.variants) {
    const testCase = cases.get(variant.case_id);
    assert(testCase, `${source.file}: unknown case ${variant.case_id}`);
    assert(nonEmpty(variant.id) && variant.id !== 'base', `${source.file}: invalid variation ID`);
    assert(!variationIds.has(variant.id), `${source.file}: duplicate variation ID ${variant.id}`);
    variationIds.add(variant.id);
    assert(!variantsByCase.has(variant.case_id), `${source.file}: duplicate variation for ${variant.case_id}`);
    assert(Array.isArray(variant.messages) && variant.messages.length === testCase.turns.length,
      `${variant.case_id}/${variant.id}: one message is required per turn`);
    assert(variant.messages.every(nonEmpty), `${variant.case_id}/${variant.id}: empty variation message`);
    assert(variant.messages.some((message, index) => message !== testCase.turns[index].message),
      `${variant.case_id}/${variant.id}: variation does not vary the source wording`);
    if (variant.expect_overrides !== undefined) {
      assert(Array.isArray(variant.expect_overrides) &&
        variant.expect_overrides.length === testCase.turns.length &&
        variant.expect_overrides.every((override) => override === null || isRecord(override)),
      `${variant.case_id}/${variant.id}: expect_overrides must have one object or null per turn`);
    }
    variantsByCase.set(variant.case_id, variant);
  }
  for (const testCase of suite.cases) {
    assert(variantsByCase.has(testCase.id), `${source.file}: missing variation for ${testCase.id}`);
  }
  return variantsByCase;
}

export function assertUniqueLedgerKeys(ledger) {
  const runKeys = new Set();
  const turnKeys = new Set();
  for (const run of ledger.runs) {
    assert(!runKeys.has(run.run_key), `duplicate run key ${run.run_key}`);
    runKeys.add(run.run_key);
    for (const turn of run.turns) {
      assert(!turnKeys.has(turn.turn_key), `duplicate turn key ${turn.turn_key}`);
      turnKeys.add(turn.turn_key);
    }
  }
}

export function buildReleaseLedger({ readBytes = fs.readFileSync, manifests = MATRIX_MANIFESTS } = {}) {
  const matrixFiles = [];
  const runs = [];
  for (const manifest of manifests) {
    const suite = readPinnedJson(manifest.file, manifest.sha256, readBytes);
    validateSuite(suite, manifest);
    matrixFiles.push({ basename: manifest.file, sha256: manifest.sha256, role: 'case_suite' });
    const variationSuite = manifest.variations
      ? readPinnedJson(manifest.variations.file, manifest.variations.sha256, readBytes)
      : null;
    if (manifest.variations) {
      matrixFiles.push({
        basename: manifest.variations.file,
        sha256: manifest.variations.sha256,
        role: 'semantic_variations',
        source_suite: manifest.file,
      });
    }
    const variantsByCase = validateVariations(variationSuite, suite, manifest);
    const firstRun = runs.length;
    for (const testCase of suite.cases) {
      const executions = [
        { id: 'base', messages: testCase.turns.map((turn) => turn.message), expect_overrides: null },
      ];
      const variation = variantsByCase.get(testCase.id);
      if (variation) executions.push(variation);
      for (const execution of executions) {
        const isVariation = execution.id !== 'base';
        for (let repeatIndex = 1; repeatIndex <= (testCase.repeat ?? 1); repeatIndex++) {
          const runKey = JSON.stringify([manifest.file, manifest.sha256, testCase.id, execution.id, repeatIndex]);
          const turns = testCase.turns.map((turn, index) => {
            const override = execution.expect_overrides?.[index] ?? null;
            const syntheticScenario = testCase.synthetic === true || turn.synthetic === true;
            return {
              turn_key: JSON.stringify([manifest.file, manifest.sha256, testCase.id, execution.id, repeatIndex, index + 1]),
              run_key: runKey,
              suite_basename: manifest.file,
              suite_sha256: manifest.sha256,
              case_id: testCase.id,
              variant: execution.id,
              repeat_index: repeatIndex,
              turn_index: index + 1,
              message: execution.messages[index],
              effective_expectation: effectiveExpectation(suite.default_expectations, turn.expect, override ?? {}),
              explicit_variant_expect_override: override,
              suite_source_claim: suite.source,
              synthetic_scenario: syntheticScenario,
              provenance_level: syntheticScenario ? 'synthetic_scenario' : 'suite_only',
              original_case_locator: null,
              candidate_status: 'NOT_RUN',
            };
          });
          const syntheticTurnCount = turns.filter((turn) => turn.synthetic_scenario).length;
          runs.push({
            run_key: runKey,
            suite_basename: manifest.file,
            suite_sha256: manifest.sha256,
            case_id: testCase.id,
            variant: execution.id,
            repeat_index: repeatIndex,
            variation_source: isVariation ? {
              basename: manifest.variations.file,
              sha256: manifest.variations.sha256,
            } : null,
            variation_inherits_base_source_and_expectations: isVariation,
            suite_source_claim: suite.source,
            synthetic_scenario: syntheticTurnCount > 0,
            provenance_level: syntheticTurnCount === 0 ? 'suite_only'
              : syntheticTurnCount === turns.length ? 'synthetic_scenario' : 'mixed_suite_and_synthetic',
            original_case_locator: null,
            candidate_status: 'NOT_RUN',
            turns,
          });
        }
      }
    }
    const suiteRuns = runs.slice(firstRun);
    assert.equal(suiteRuns.length, manifest.runCount, `${manifest.file}: planned run count changed`);
    assert.equal(suiteRuns.reduce((count, run) => count + run.turns.length, 0), manifest.evaluatedTurnCount,
      `${manifest.file}: planned evaluated turn count changed`);
  }
  const counts = {
    matrix_files: matrixFiles.length,
    runs: runs.length,
    ordered_turns: runs.reduce((count, run) => count + run.turns.length, 0),
  };
  assert.deepEqual(counts, { matrix_files: 5, runs: 190, ordered_turns: 279 });
  const ledger = {
    schema_version: 1,
    kind: 'offline_release_inventory',
    candidate: {
      commit_sha: null,
      preview_version: null,
      status: 'NOT_RUN',
      note: 'No live result is bound to this inventory. Pin the candidate commit and preview identity in new execution evidence.',
    },
    historical_report_results_joined: false,
    provenance_note: 'This inventory stores suite-level claims only. V3 preserves the first prompts from the pinned Notion v2 suite; exact source-paragraph matches for 29 first prompts are recorded separately in docs/qa/source-provenance-20261009.json. The first 15 explicitly marked BT-929/BT-924 synthetic turns are indexed in docs/qa/notion-source-index-20261009.json; five further v3 turns are marked synthetic API continuations, not customer quotations or browser clicks. The BT-746 “дай ссылку” continuation is source-observed, but its product identity is tested against the prior verified catalog URL. The BT-929 20% reserve versus 14/7 example remains unresolved.',
    expectation_resolution: 'shallow merge: suite default_expectations, then case turn expect, then explicit variation expect_overrides',
    counts,
    matrix_files: matrixFiles,
    runs,
  };
  assertUniqueLedgerKeys(ledger);
  return ledger;
}

export const serializeReleaseLedger = (ledger) => `${JSON.stringify(ledger, null, 2)}\n`;

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const flag = process.argv[2];
  if (!['--write', '--check'].includes(flag) || process.argv.length !== 3) {
    process.stderr.write('Usage: node scripts/qa/build-release-ledger.mjs --write|--check\n');
    process.exitCode = 2;
  } else {
    const serialized = serializeReleaseLedger(buildReleaseLedger());
    if (flag === '--write') {
      fs.writeFileSync(outputFile, serialized);
      process.stdout.write(`Wrote ${path.relative(root, outputFile)}\n`);
    } else {
      assert.equal(fs.readFileSync(outputFile, 'utf8'), serialized,
        'release inventory is stale; rebuild with --write after reviewing matrix changes');
      process.stdout.write('Release inventory matches the pinned five-file matrix (190 runs, 279 turns).\n');
    }
  }
}

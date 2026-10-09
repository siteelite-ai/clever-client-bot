import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { MATRIX_MANIFESTS, buildReleaseLedger, serializeReleaseLedger } from './build-release-ledger.mjs';

// Read-only CLI:
// node scripts/qa/validate-release-evidence.mjs \
//   --attestation=deployment-assertion.json \
//   --report=first-strict.json --report=second-strict.json \
//   --report=third-strict.json --report=fourth-strict.json
// The attestation JSON must have candidate_commit_sha (full 40-hex Git SHA),
// preview_function_version, preview_endpoint, and deployment_observed_at (UTC ISO).
// These fields are an operator assertion, not cryptographic deployment proof.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const inventoryFile = path.join(root, 'docs/qa/release-inventory-v2-20261009.json');
const STRICT_PRODUCT_IDENTITY_MODE = 'live_jsonld_product_sku_or_no_sku_canonical_name_price_stock';
// Dimensions come from the independently pinned manifests, not from a pass subset.
// A reviewed matrix re-pin can change run/turn counts without changing this gate.
const EXPECTED_COUNTS = Object.freeze({
  reports: MATRIX_MANIFESTS.length,
  matrix_files: MATRIX_MANIFESTS.reduce((count, manifest) => count + 1 + Number(Boolean(manifest.variations)), 0),
  runs: MATRIX_MANIFESTS.reduce((count, manifest) => count + manifest.runCount, 0),
  turns: MATRIX_MANIFESTS.reduce((count, manifest) => count + manifest.evaluatedTurnCount, 0),
});
const MAX_DISPLAYED_FAILURES = 20;
const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const nonEmpty = (value) => typeof value === 'string' && value.trim().length > 0;

function timestamp(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(value)) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function previewEndpoint(value) {
  if (!nonEmpty(value)) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash &&
      /^\/functions\/v1\/[a-z0-9-]*preview$/i.test(url.pathname) &&
      url.toString() === value;
  } catch {
    return false;
  }
}

function summaryWithFailures(failures, coverage, attestation) {
  return {
    verdict: failures.length === 0 && coverage.passing_runs === EXPECTED_COUNTS.runs ? 'PASS' : 'FAIL',
    verdict_scope: 'strict_matrix_evidence_only',
    release_readiness: 'NOT_ASSESSED',
    attestation_basis: 'operator_assertion_not_cryptographic_proof',
    candidate_commit_sha: /^[a-f0-9]{40}$/i.test(attestation?.candidate_commit_sha ?? '')
      ? attestation.candidate_commit_sha : null,
    preview_function_version: typeof attestation?.preview_function_version === 'string' &&
      /^[a-z0-9._-]{1,128}$/i.test(attestation.preview_function_version)
      ? attestation.preview_function_version : null,
    coverage,
    failure_count: failures.length,
    failures: failures.slice(0, MAX_DISPLAYED_FAILURES),
    omitted_failure_count: Math.max(0, failures.length - MAX_DISPLAYED_FAILURES),
  };
}

/** Validate already-loaded JSON. This function performs no I/O and never exposes response text. */
export function validateReleaseEvidence({ inventory, reports, attestation }) {
  const failures = [];
  const fail = (code, location = null) => failures.push(location ? { code, location } : { code });
  const coverage = {
    expected_reports: EXPECTED_COUNTS.reports,
    recorded_reports: Array.isArray(reports) ? reports.length : 0,
    expected_runs: EXPECTED_COUNTS.runs,
    recorded_runs: 0,
    matched_runs: 0,
    passing_runs: 0,
    expected_turns: EXPECTED_COUNTS.turns,
    recorded_turns: 0,
    matched_turns: 0,
    unique_log_ids: 0,
  };

  if (!isRecord(attestation)) {
    fail('attestation_missing');
  } else {
    if (!/^[a-f0-9]{40}$/i.test(attestation.candidate_commit_sha ?? '')) fail('candidate_commit_sha_invalid');
    if (typeof attestation.preview_function_version !== 'string' ||
      !/^[a-z0-9._-]{1,128}$/i.test(attestation.preview_function_version)) {
      fail('preview_function_version_invalid');
    }
    if (!previewEndpoint(attestation.preview_endpoint)) fail('preview_endpoint_invalid');
    if (timestamp(attestation.deployment_observed_at) === null) fail('deployment_observed_at_invalid');
  }
  const deploymentTime = timestamp(attestation?.deployment_observed_at);

  const manifests = new Map(MATRIX_MANIFESTS.map((manifest) => [manifest.file, manifest]));
  const inventoryRuns = new Map();
  const expectedCases = new Map(MATRIX_MANIFESTS.map((manifest) => [manifest.file, new Set()]));
  if (!isRecord(inventory) || inventory.kind !== 'offline_release_inventory' || inventory.schema_version !== 1 ||
    !Array.isArray(inventory.matrix_files) || !Array.isArray(inventory.runs) ||
    inventory.counts?.matrix_files !== EXPECTED_COUNTS.matrix_files || inventory.counts?.runs !== EXPECTED_COUNTS.runs ||
    inventory.counts?.ordered_turns !== EXPECTED_COUNTS.turns ||
    inventory.matrix_files.length !== EXPECTED_COUNTS.matrix_files || inventory.runs.length !== EXPECTED_COUNTS.runs) {
    fail('inventory_invalid');
  } else {
    const matrixFiles = new Map();
    for (const file of inventory.matrix_files) {
      if (!isRecord(file) || !nonEmpty(file.basename) || matrixFiles.has(file.basename)) {
        fail('inventory_matrix_file_duplicate_or_invalid');
        continue;
      }
      matrixFiles.set(file.basename, file);
    }
    for (const manifest of MATRIX_MANIFESTS) {
      const suiteFile = matrixFiles.get(manifest.file);
      if (suiteFile?.sha256 !== manifest.sha256 || suiteFile?.role !== 'case_suite') {
        fail('inventory_suite_matrix_mismatch', manifest.file);
      }
      if (manifest.variations) {
        const variationFile = matrixFiles.get(manifest.variations.file);
        if (variationFile?.sha256 !== manifest.variations.sha256 ||
          variationFile?.role !== 'semantic_variations' || variationFile?.source_suite !== manifest.file) {
          fail('inventory_variation_matrix_mismatch', manifest.file);
        }
      }
    }
    if (matrixFiles.size !== EXPECTED_COUNTS.matrix_files) fail('inventory_matrix_file_count_mismatch');

    let inventoryTurns = 0;
    for (const [index, run] of inventory.runs.entries()) {
      const location = `inventory.runs[${index}]`;
      const manifest = manifests.get(run?.suite_basename);
      if (!manifest || run.suite_sha256 !== manifest.sha256 || !nonEmpty(run.case_id) ||
        !nonEmpty(run.variant) || !Number.isInteger(run.repeat_index) || run.repeat_index < 1 ||
        !Array.isArray(run.turns) || run.turns.length < 1) {
        fail('inventory_run_invalid', location);
        continue;
      }
      const key = JSON.stringify([manifest.file, manifest.sha256, run.case_id, run.variant, run.repeat_index]);
      if (run.run_key !== key || inventoryRuns.has(key)) {
        fail('inventory_run_key_invalid_or_duplicate', location);
        continue;
      }
      const expectedVariation = run.variant === 'base' ? null : manifest.variations;
      if (run.variant !== 'base' && !expectedVariation) fail('inventory_variation_source_invalid', location);
      if ((expectedVariation === null && run.variation_source !== null) ||
        (expectedVariation && (run.variation_source?.basename !== expectedVariation.file ||
          run.variation_source?.sha256 !== expectedVariation.sha256))) {
        fail('inventory_variation_source_invalid', location);
      }
      expectedCases.get(manifest.file).add(run.case_id);
      inventoryRuns.set(key, run);
      for (const [turnIndex, turn] of run.turns.entries()) {
        inventoryTurns++;
        const turnKey = JSON.stringify([manifest.file, manifest.sha256, run.case_id,
          run.variant, run.repeat_index, turnIndex + 1]);
        if (turn?.turn_key !== turnKey || turn.run_key !== key || turn.turn_index !== turnIndex + 1 ||
          !nonEmpty(turn.message)) fail('inventory_turn_invalid', `${location}.turns[${turnIndex}]`);
      }
    }
    if (inventoryTurns !== EXPECTED_COUNTS.turns) fail('inventory_turn_count_mismatch');
  }

  if (!Array.isArray(reports) || reports.length !== EXPECTED_COUNTS.reports) fail('report_count_mismatch');
  const seenSuites = new Set();
  const seenRuns = new Set();
  const seenTurns = new Set();
  const seenLogIds = new Set();
  for (const [reportIndex, report] of (Array.isArray(reports) ? reports : []).entries()) {
    const reportLocation = `reports[${reportIndex}]`;
    if (!isRecord(report)) {
      fail('report_invalid', reportLocation);
      continue;
    }
    const manifest = manifests.get(report.suite_file);
    if (!manifest) {
      fail('unexpected_suite', reportLocation);
      continue;
    }
    const suiteLocation = manifest.file;
    if (seenSuites.has(manifest.file)) fail('duplicate_suite', suiteLocation);
    seenSuites.add(manifest.file);
    if (report.suite_sha256 !== manifest.sha256) fail('suite_sha256_mismatch', suiteLocation);
    if (report.variations_file !== (manifest.variations?.file ?? null) ||
      report.variations_sha256 !== (manifest.variations?.sha256 ?? null)) {
      fail('variation_identity_mismatch', suiteLocation);
    }
    if (report.strict_full_suite !== true) fail('strict_full_suite_missing', suiteLocation);
    if (report.product_identity_mode !== STRICT_PRODUCT_IDENTITY_MODE) {
      fail('strict_product_identity_mode_mismatch', suiteLocation);
    }
    const pageVerification = report.product_page_verification;
    if (!isRecord(pageVerification) ||
      !Number.isInteger(pageVerification.unique_urls_checked) || pageVerification.unique_urls_checked < 0 ||
      !Number.isInteger(pageVerification.verified) || pageVerification.verified < 0 ||
      pageVerification.unverified !== 0 ||
      pageVerification.verified !== pageVerification.unique_urls_checked) {
      fail('product_page_verification_invalid', suiteLocation);
    }
    if (report.endpoint !== attestation?.preview_endpoint) fail('endpoint_mismatch', suiteLocation);
    const reportTime = timestamp(report.started_at);
    if (reportTime === null) fail('report_started_at_invalid', suiteLocation);
    else if (deploymentTime !== null && reportTime < deploymentTime) fail('report_predates_deployment', suiteLocation);
    const finishedTime = timestamp(report.finished_at);
    if (finishedTime === null || (reportTime !== null && finishedTime < reportTime)) {
      fail('report_finished_at_invalid', suiteLocation);
    }
    if (typeof report.passed !== 'boolean') fail('report_status_missing', suiteLocation);
    else if (!report.passed) fail('report_failed', suiteLocation);
    if (!Array.isArray(report.cases)) {
      fail('report_cases_missing', suiteLocation);
      continue;
    }
    const suiteCases = expectedCases.get(manifest.file);
    const expectedRuns = (Array.isArray(inventory?.runs) ? inventory.runs : [])
      .filter((run) => run?.suite_basename === manifest.file);
    const expectedRepetitions = new Map();
    for (const run of expectedRuns) {
      if (run.variant === 'base') {
        expectedRepetitions.set(run.case_id, (expectedRepetitions.get(run.case_id) ?? 0) + 1);
      }
    }
    if (!isRecord(report.requested_repetitions) ||
      Object.keys(report.requested_repetitions).length !== expectedRepetitions.size ||
      [...expectedRepetitions].some(([caseId, count]) => report.requested_repetitions[caseId] !== count)) {
      fail('requested_repetitions_mismatch', suiteLocation);
    }
    const expectedTurnCount = expectedRuns.reduce((count, run) => count + (run.turns?.length ?? 0), 0);
    const expectedSourceTurns = manifest.sourceTurnCount;
    const strictInventory = report.strict_inventory;
    if (!isRecord(strictInventory) || strictInventory.name !== manifest.file ||
      strictInventory.expected_cases !== manifest.caseCount ||
      strictInventory.expected_turns_per_base_suite !== expectedSourceTurns ||
      strictInventory.expected_repeat !== manifest.repeat ||
      strictInventory.expected_runs !== manifest.runCount ||
      strictInventory.expected_evaluated_turns !== manifest.evaluatedTurnCount) {
      fail('strict_inventory_mismatch', suiteLocation);
    }
    if (report.selected_count !== manifest.caseCount) fail('selected_count_mismatch', suiteLocation);
    const completeness = report.completeness;
    if (!isRecord(completeness) || completeness.complete !== true ||
      completeness.planned_cases !== manifest.caseCount || completeness.recorded_cases !== manifest.caseCount ||
      completeness.planned_runs !== manifest.runCount || completeness.recorded_runs !== manifest.runCount ||
      completeness.planned_turns !== manifest.evaluatedTurnCount ||
      completeness.recorded_turns !== manifest.evaluatedTurnCount) {
      fail('completeness_mismatch', suiteLocation);
    }
    if (report.cases.length !== manifest.caseCount) fail('case_count_mismatch', suiteLocation);
    let actualRuns = 0;
    let actualTurns = 0;
    const seenCases = new Set();
    const reportLogIds = new Set();
    for (const [caseIndex, testCase] of report.cases.entries()) {
      const caseLocation = `${suiteLocation}.cases[${caseIndex}]`;
      if (!isRecord(testCase) || !nonEmpty(testCase.id) || !Array.isArray(testCase.repeats)) {
        fail('case_invalid', caseLocation);
        continue;
      }
      if (!suiteCases?.has(testCase.id)) fail('unexpected_case', caseLocation);
      if (seenCases.has(testCase.id)) fail('duplicate_case', caseLocation);
      seenCases.add(testCase.id);
      if (typeof testCase.passed !== 'boolean') fail('case_status_missing', caseLocation);
      else if (!testCase.passed) fail('case_failed', caseLocation);
      for (const [repeatIndex, repeat] of testCase.repeats.entries()) {
        actualRuns++;
        coverage.recorded_runs++;
        const runLocation = `${caseLocation}.repeats[${repeatIndex}]`;
        if (!isRecord(repeat) || !nonEmpty(repeat.variant) || !Number.isInteger(repeat.run) || repeat.run < 1) {
          fail('run_identity_invalid', runLocation);
          continue;
        }
        const key = JSON.stringify([manifest.file, manifest.sha256, testCase.id, repeat.variant, repeat.run]);
        const expectedRun = inventoryRuns.get(key);
        if (!expectedRun) fail('unexpected_run', runLocation);
        const firstOccurrence = !seenRuns.has(key);
        if (!firstOccurrence) fail('duplicate_run', runLocation);
        else {
          seenRuns.add(key);
          if (expectedRun) coverage.matched_runs++;
        }
        if (typeof repeat.passed !== 'boolean') fail('run_status_missing', runLocation);
        else if (!repeat.passed) fail('run_failed', runLocation);
        else if (expectedRun && firstOccurrence) coverage.passing_runs++;
        if (!Array.isArray(repeat.turns)) {
          fail('run_turns_missing', runLocation);
          continue;
        }
        actualTurns += repeat.turns.length;
        coverage.recorded_turns += repeat.turns.length;
        if (expectedRun && repeat.turns.length !== expectedRun.turns.length) {
          fail('run_turn_count_mismatch', runLocation);
        }
        for (const [turnIndex, turn] of repeat.turns.entries()) {
          const turnLocation = `${runLocation}.turns[${turnIndex}]`;
          const expectedTurn = expectedRun?.turns[turnIndex];
          const turnKey = JSON.stringify([manifest.file, manifest.sha256, testCase.id,
            repeat.variant, repeat.run, turnIndex + 1]);
          if (!expectedTurn) fail('unexpected_turn', turnLocation);
          else if (seenTurns.has(turnKey)) fail('duplicate_turn', turnLocation);
          else {
            seenTurns.add(turnKey);
            coverage.matched_turns++;
          }
          if (!isRecord(turn)) {
            fail('turn_invalid', turnLocation);
            continue;
          }
          if (expectedTurn && turn.message !== expectedTurn.message) fail('turn_message_mismatch', turnLocation);
          if (expectedTurn && (typeof turn.synthetic_scenario !== 'boolean' ||
            turn.synthetic_scenario !== expectedTurn.synthetic_scenario)) {
            fail('turn_synthetic_scenario_mismatch', turnLocation);
          }
          if (!nonEmpty(turn.log_id)) {
            fail('turn_log_id_missing', turnLocation);
          } else {
            if (seenLogIds.has(turn.log_id)) fail('turn_log_id_duplicate', turnLocation);
            seenLogIds.add(turn.log_id);
            reportLogIds.add(turn.log_id);
          }
          if (!Number.isInteger(turn.status) || turn.status < 100 || turn.status > 599) {
            fail('turn_http_status_missing', turnLocation);
          } else if (turn.passed === true && (turn.status < 200 || turn.status > 299)) {
            fail('passing_turn_http_status_invalid', turnLocation);
          }
          if (typeof turn.passed !== 'boolean') fail('turn_status_missing', turnLocation);
          else if (!turn.passed) fail('turn_failed', turnLocation);
          else {
            if (!Array.isArray(turn.failures) || turn.failures.length !== 0) {
              fail('passing_turn_failures_invalid', turnLocation);
            }
            if (turn.completed !== true) fail('passing_turn_not_completed', turnLocation);
            if (turn.diagnostic_error !== null) fail('passing_turn_diagnostic_error', turnLocation);
          }
        }
        if (repeat.passed === true && repeat.turns.some((turn) => turn?.passed !== true)) {
          fail('run_status_inconsistent', runLocation);
        }
      }
      if (testCase.passed === true && testCase.repeats.some((repeat) => repeat?.passed !== true)) {
        fail('case_status_inconsistent', caseLocation);
      }
    }
    if (actualRuns !== manifest.runCount || actualTurns !== expectedTurnCount) {
      fail('actual_suite_counts_mismatch', suiteLocation);
    }
    if (!Array.isArray(report.log_ids) || report.log_ids.length !== reportLogIds.size ||
      report.log_ids.some((logId) => !nonEmpty(logId) || !reportLogIds.has(logId)) ||
      new Set(report.log_ids).size !== report.log_ids.length) {
      fail('report_log_ids_mismatch', suiteLocation);
    }
  }
  for (const manifest of MATRIX_MANIFESTS) {
    if (!seenSuites.has(manifest.file)) fail('missing_suite', manifest.file);
  }
  for (const [key, run] of inventoryRuns) {
    if (!seenRuns.has(key)) fail('missing_run', `${run.suite_basename}/${run.case_id}/${run.variant}/${run.repeat_index}`);
    for (const turn of run.turns) {
      if (!seenTurns.has(turn.turn_key)) fail('missing_turn', `${run.suite_basename}/${run.case_id}/${run.variant}/${run.repeat_index}/${turn.turn_index}`);
    }
  }
  if (coverage.recorded_runs !== EXPECTED_COUNTS.runs) fail('total_run_count_mismatch');
  if (coverage.recorded_turns !== EXPECTED_COUNTS.turns) fail('total_turn_count_mismatch');
  coverage.unique_log_ids = seenLogIds.size;
  if (coverage.unique_log_ids !== EXPECTED_COUNTS.turns) fail('total_log_id_count_mismatch');
  if (coverage.passing_runs !== EXPECTED_COUNTS.runs) fail('not_all_runs_passed');
  return summaryWithFailures(failures, coverage, attestation);
}

export function parseCliArgs(argv = process.argv.slice(2)) {
  let attestationFile = null;
  const reportFiles = [];
  for (const arg of argv) {
    if (arg.startsWith('--attestation=') && arg.slice('--attestation='.length).trim()) {
      if (attestationFile !== null) throw new Error('duplicate --attestation');
      attestationFile = arg.slice('--attestation='.length);
    } else if (arg.startsWith('--report=') && arg.slice('--report='.length).trim()) {
      reportFiles.push(arg.slice('--report='.length));
    } else {
      throw new Error('unknown or incomplete argument');
    }
  }
  if (attestationFile === null) throw new Error('--attestation is required');
  return { attestationFile, reportFiles };
}

function readJson(filename) {
  return JSON.parse(fs.readFileSync(path.resolve(filename), 'utf8'));
}

function cliFailure(code) {
  const summary = summaryWithFailures([{ code }], {
    expected_reports: EXPECTED_COUNTS.reports, recorded_reports: 0,
    expected_runs: EXPECTED_COUNTS.runs, recorded_runs: 0, matched_runs: 0, passing_runs: 0,
    expected_turns: EXPECTED_COUNTS.turns, recorded_turns: 0, matched_turns: 0, unique_log_ids: 0,
  }, null);
  summary.usage = 'node scripts/qa/validate-release-evidence.mjs --attestation=FILE --report=FILE --report=FILE --report=FILE --report=FILE';
  return summary;
}

export function runCli(argv = process.argv.slice(2)) {
  let summary;
  try {
    const { attestationFile, reportFiles } = parseCliArgs(argv);
    const inventoryBytes = fs.readFileSync(inventoryFile, 'utf8');
    if (inventoryBytes !== serializeReleaseLedger(buildReleaseLedger())) {
      summary = cliFailure('inventory_not_current_pinned_matrix');
    } else {
      summary = validateReleaseEvidence({
        inventory: JSON.parse(inventoryBytes),
        reports: reportFiles.map(readJson),
        attestation: readJson(attestationFile),
      });
    }
  } catch {
    summary = cliFailure('invalid_arguments_or_unreadable_json');
  }
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  return summary.verdict === 'PASS' ? 0 : 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = runCli();
}

import fs from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { MATRIX_MANIFESTS, serializeReleaseLedger } from './build-release-ledger.mjs';
import { V9_MATRIX_MANIFESTS, buildReleaseLedgerV9 } from './build-release-ledger-v9.mjs';
import { evaluate } from './run-customer-acceptance.mjs';
import { parseCliArgs, validateReleaseEvidence } from './validate-release-evidence.mjs';

// Read-only V9 full-matrix gate. Run after deploying a pinned preview candidate:
// node scripts/qa/validate-release-evidence-v9.mjs \
//   --attestation=deployment-assertion.json \
//   --report=customer-v9.json --report=audit-v9.json \
//   --report=notion-v9.json --report=cardinality-v9.json \
//   --dn027b-report=dn027b-direct-analogs-prospective.json
// All four reports must be strict full-suite runs with a successful catalog
// preflight. The attestation is an operator assertion, not cryptographic proof.
// This gate assesses the V9 matrix evidence only; it does not authorize deploy.
// V9's original DN027B min_products=3 oracle does not prove direct replacements.
// The V9 verdict remains matrix-only. CLI success additionally requires a fresh,
// exact prospective report with server proof + independently fetched live pages.
// The server's approved_manufacturer_fact metadata is NOT independent inspection
// of the manufacturer document's actual contents. The runner does not emit a
// deployed commit/version fingerprint: preview identity is an operator assertion.
// Neither result by itself assesses every production-release prerequisite.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const inventoryFile = path.join(root, 'docs/qa/release-inventory-v9-20261020.json');
const directAnalogContractFile = path.join(root, 'scripts/qa/dn027b-direct-analogs-prospective-v1.json');
const directAnalogContractSha256 = 'd3de1cce662a96b3a1c330593b450dd217b940bbb8b281d6f1d76c4c7c19b9d3';
const directAnalogSuiteFile = path.basename(directAnalogContractFile);
const directAnalogCaseId = 'prospective-dn027b-confirmed-direct-analogs';
const directAnalogMaxAgeMs = 24 * 60 * 60 * 1000;
const expectedCounts = Object.freeze({
  reports: V9_MATRIX_MANIFESTS.length,
  runs: V9_MATRIX_MANIFESTS.reduce((count, manifest) => count + manifest.runCount, 0),
  turns: V9_MATRIX_MANIFESTS.reduce((count, manifest) => count + manifest.evaluatedTurnCount, 0),
});
const priorByV9 = new Map(V9_MATRIX_MANIFESTS.map((manifest, index) => [manifest.file, MATRIX_MANIFESTS[index]]));
const currentByName = new Map(V9_MATRIX_MANIFESTS.map((manifest) => [manifest.file, manifest]));
const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const nonEmpty = (value) => typeof value === 'string' && value.trim().length > 0;
const MAX_DISPLAYED_FAILURES = 20;

function releaseEvidenceGate(matrixVerdict, directAnalogFailures) {
  return {
    status: matrixVerdict === 'PASS' && directAnalogFailures.length === 0 ? 'PASS' : 'NO_GO',
    scope: 'v9_matrix_plus_dn027b_direct_analogs_evidence_only_not_deployment_approval',
    manufacturer_document_review: 'NOT_ASSESSED',
    runtime_version_binding: 'operator_assertion_only',
    dn027b_direct_analogs: {
      status: directAnalogFailures.length === 0 ? 'PASS' : 'FAIL',
      failures: directAnalogFailures.map((code) => ({ code })),
    },
  };
}

function failed(code, location = null) {
  return {
    verdict: 'FAIL',
    verdict_scope: 'strict_v9_matrix_evidence_only',
    release_readiness: 'NOT_ASSESSED',
    release_evidence_gate: releaseEvidenceGate('FAIL', ['dn027b_prospective_report_not_validated']),
    attestation_basis: 'operator_assertion_not_cryptographic_proof',
    candidate_commit_sha: null,
    preview_function_version: null,
    coverage: {
      expected_reports: expectedCounts.reports,
      recorded_reports: 0,
      expected_runs: expectedCounts.runs,
      recorded_runs: 0,
      matched_runs: 0,
      passing_runs: 0,
      expected_turns: expectedCounts.turns,
      recorded_turns: 0,
      matched_turns: 0,
      unique_log_ids: 0,
    },
    failure_count: 1,
    failures: [location ? { code, location } : { code }],
    omitted_failure_count: 0,
  };
}

function utcTimestamp(value) {
  if (typeof value !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/u.test(value)) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function directAnalogContract() {
  try {
    const bytes = fs.readFileSync(directAnalogContractFile);
    if (createHash('sha256').update(bytes).digest('hex') !== directAnalogContractSha256) return null;
    const suite = JSON.parse(bytes.toString('utf8'));
    if (suite.schema_version !== 1 || suite.cases?.length !== 1 ||
      suite.cases[0]?.id !== directAnalogCaseId || suite.cases[0]?.repeat !== 1 ||
      suite.cases[0]?.turns?.length !== 1 ||
      suite.cases[0].turns[0]?.expect?.min_products !== 3 ||
      suite.cases[0].turns[0]?.expect?.require_confirmed_analogs?.minimum !== 3) return null;
    return suite.cases[0];
  } catch {
    return null;
  }
}

// The prospective acceptance runner emits this report through --report-file.
// It cannot use --strict-full-suite (the prospective contract is deliberately
// outside the immutable V9 manifests), so validate its complete one-case shape
// and re-check the typed direct_analog_proof against exact live-page SKU proof.
function directAnalogProspectiveFailures(report, attestation, v9Reports, nowMs) {
  const contractCase = directAnalogContract();
  if (!contractCase) return ['dn027b_prospective_contract_unavailable_or_changed'];
  if (!isRecord(report)) return ['dn027b_prospective_report_missing'];
  const startedAt = utcTimestamp(report.started_at);
  const finishedAt = utcTimestamp(report.finished_at);
  const deployedAt = utcTimestamp(attestation?.deployment_observed_at);
  if (report.suite_file !== directAnalogSuiteFile ||
    report.suite_sha256 !== directAnalogContractSha256 || report.suite_version !== 1 ||
    report.variations_file !== null || report.variations_sha256 !== null ||
    report.strict_full_suite !== false || report.strict_inventory !== null ||
    report.endpoint !== attestation?.preview_endpoint ||
    // The runner has no deployed-bytes attestation. Reject hand-added fields
    // rather than implying that matching strings prove the runtime version.
    Object.hasOwn(report, 'candidate_commit_sha') ||
    Object.hasOwn(report, 'preview_function_version') ||
    startedAt === null || finishedAt === null || deployedAt === null ||
    startedAt < deployedAt || finishedAt < startedAt || finishedAt > nowMs ||
    nowMs - finishedAt > directAnalogMaxAgeMs ||
    Object.hasOwn(report, 'status') || Object.hasOwn(report, 'infrastructure_status') ||
    Object.hasOwn(report, 'reason') ||
    report.catalog_preflight?.ok !== true || report.catalog_preflight?.status !== 'ready' ||
    report.catalog_preflight?.http_status !== 200 || report.passed !== true ||
    report.selected_count !== 1 ||
    !isRecord(report.requested_repetitions) ||
    Object.keys(report.requested_repetitions).length !== 1 ||
    report.requested_repetitions[directAnalogCaseId] !== 1 ||
    report.completeness?.complete !== true ||
    ['planned_cases', 'recorded_cases', 'planned_runs', 'recorded_runs', 'planned_turns', 'recorded_turns']
      .some((key) => report.completeness[key] !== 1) ||
    !Array.isArray(report.cases) || report.cases.length !== 1 ||
    report.cases[0]?.id !== directAnalogCaseId || report.cases[0]?.passed !== true ||
    !Array.isArray(report.cases[0].repeats) || report.cases[0].repeats.length !== 1) {
    return ['dn027b_prospective_report_incomplete_or_stale'];
  }
  const run = report.cases[0].repeats[0];
  const turn = run?.turns?.[0];
  const priorLogs = new Set(v9Reports.flatMap((v9Report) => v9Report?.log_ids ?? []));
  if (run.variant !== 'base' || run.run !== 1 || run.passed !== true ||
    !Array.isArray(run.turns) || run.turns.length !== 1 ||
    turn?.message !== contractCase.turns[0].message || turn.synthetic_scenario !== false ||
    turn.status !== 200 || turn.passed !== true || turn.completed !== true ||
    turn.diagnostic_error !== null || !Array.isArray(turn.failures) || turn.failures.length !== 0 ||
    typeof turn.text !== 'string' || !Array.isArray(turn.tool_events) ||
    !nonEmpty(turn.log_id) || priorLogs.has(turn.log_id) ||
    !Array.isArray(report.log_ids) || report.log_ids.length !== 1 ||
    report.log_ids[0] !== turn.log_id ||
    turn.product_identity_mode !== 'live_jsonld_product_sku' ||
    !Number.isSafeInteger(turn.duration_ms) || turn.duration_ms < 0 ||
    turn.duration_ms > 45_000 ||
    !Array.isArray(turn.products) || turn.products.length < 3 || turn.products.length > 5 ||
    turn.products_count !== turn.products.length ||
    turn.unique_products_count !== turn.products.length ||
    !Array.isArray(turn.product_identity_evidence) ||
    turn.product_identity_evidence.length !== turn.products.length ||
    !Number.isSafeInteger(report.product_page_verification?.verified) ||
    report.product_page_verification.verified < turn.products.length ||
    report.product_page_verification?.unverified !== 0 ||
    !Number.isSafeInteger(report.product_page_verification?.unique_urls_checked) ||
    report.product_page_verification.unique_urls_checked < turn.products.length ||
    report.product_page_verification.verified + report.product_page_verification.unverified !==
      report.product_page_verification.unique_urls_checked) {
    return ['dn027b_prospective_turn_or_live_page_proof_incomplete'];
  }
  const cardIdentities = turn.products.map((product) => catalogProductIdentity(product?.url));
  const pages = new Map();
  const skus = new Set();
  for (const proof of turn.product_identity_evidence) {
    if (!isRecord(proof) || !nonEmpty(proof.identity) || pages.has(proof.identity) ||
      proof.verified !== true || !nonEmpty(proof.sku) || skus.has(proof.sku) ||
      !nonEmpty(proof.name) ||
      sourceCanonicalIdentity(proof.canonicalUrl) !== proof.identity ||
      !Number.isFinite(proof.offerPrice) || proof.offerPrice <= 0 ||
      !/^https?:\/\/schema\.org\/InStock$/iu.test(proof.availability ?? '')) {
      return ['dn027b_prospective_live_page_identity_invalid'];
    }
    pages.set(proof.identity, proof);
    skus.add(proof.sku);
  }
  if (cardIdentities.some((identity) => !identity || !pages.has(identity)) ||
    new Set(cardIdentities).size !== cardIdentities.length ||
    turn.products.some((product) => !nonEmpty(product?.title) || !nonEmpty(product?.stockLine) ||
      !Number.isFinite(product?.price))) {
    return ['dn027b_prospective_cards_not_bound_to_live_pages'];
  }
  const response = {
    text: turn.text,
    textBeforeProducts: '',
    productsMarkdown: '',
    links: turn.products,
    verifiedProductPages: pages,
    selectionContract: turn.selection_contract,
    completed: turn.completed,
    terminalDiagnosticSeen: true, // The report's validated log_id comes from the terminal event.
    logId: turn.log_id,
    diagnosticError: turn.diagnostic_error,
    serverProductsCount: turn.products_count,
    durationMs: turn.duration_ms,
    toolEvents: turn.tool_events,
  };
  if (evaluate(contractCase.turns[0].expect, response,
    { nowMs, requireVerifiedPages: true }).length > 0 ||
    turn.products.some((product) => /DN027B/iu.test(product.title))) {
    return ['dn027b_prospective_direct_analogue_certificate_invalid'];
  }
  return [];
}

function dn027bOracleIntact(inventory) {
  const runs = inventory?.runs?.filter((run) =>
    run?.suite_basename === 'customer-acceptance-cases-v2.json' &&
    run.case_id === 'customer-dn027b-analogs');
  return runs?.length === 3 && runs.every((run) =>
    run.variant === 'base' && run.turns?.length === 1 &&
    run.turns[0]?.effective_expectation?.min_products === 3 &&
    run.turns[0]?.effective_expectation?.forbid_product_title?.includes('DN027B'));
}

function heatShrinkOraclesIntact(inventory) {
  const requirements = [
    { caseId: 'customer-new-heat-shrink-12mm', runs: 3, before: 14.4, after: 12 },
    { caseId: 'customer-new-heat-shrink-10mm', runs: 3, before: 12, after: 10 },
    { caseId: 'bt929-heat-shrink-12mm', runs: 1, before: 14.4, after: 12 },
  ];
  return requirements.every(({ caseId, runs: requiredRuns, before, after }) => {
    const runs = inventory?.runs?.filter((run) => run?.case_id === caseId);
    return runs?.length === requiredRuns && runs.every((run) => {
      const expect = run.turns?.[0]?.effective_expectation;
      const facets = expect?.require_every_product_page?.facets;
      const criteria = expect?.require_selection_criteria_exact;
      return run.turns?.length === 1 &&
        Array.isArray(facets) && facets.some((facet) =>
          facet?.name === 'Внутр диаметр до термоусадки,мм' && facet.min_numeric === before) &&
        facets.some((facet) =>
          facet?.name === 'Внутр диаметр после термоусадки, мм' && facet.less_than === after) &&
        Array.isArray(criteria) && criteria.some((criterion) =>
          criterion?.key_contains === 'vnutr_diametr_do_termousadki' && criterion.op === 'min' &&
          criterion.value === before && criterion.exclusive === false) &&
        criteria.some((criterion) =>
          criterion?.key_contains === 'vnutr_diametr_posle_termousadki' && criterion.op === 'max' &&
          criterion.value === after && criterion.exclusive === true);
    });
  });
}

function catalogProductIdentity(rawUrl) {
  if (!nonEmpty(rawUrl)) return null;
  try {
    const url = new URL(rawUrl);
    const segments = url.pathname.split('/').filter(Boolean);
    if (url.protocol !== 'https:' || !['220volt.kz', 'www.220volt.kz'].includes(url.hostname.toLowerCase()) ||
      url.username || url.password || url.port || segments[0]?.toLowerCase() !== 'catalog' ||
      segments.length < 4 || segments.some((segment) => /%2f|%5c/iu.test(segment))) return null;
    return `220volt.kz${decodeURIComponent(url.pathname).normalize('NFC').replace(/\/+$/u, '').toLowerCase()}`;
  } catch {
    return null;
  }
}

function sourceCanonicalIdentity(rawUrl) {
  try {
    const url = new URL(rawUrl);
    return url.search || url.hash ? null : catalogProductIdentity(rawUrl);
  } catch {
    return null;
  }
}

function confirmedDn027bCardinality(turn) {
  if (!isRecord(turn) || !Array.isArray(turn.products) || !Array.isArray(turn.product_identity_evidence) ||
    !Number.isSafeInteger(turn.unique_products_count) || turn.unique_products_count < 3 ||
    turn.products.length < 3 || turn.product_identity_evidence.length < 3) return false;
  const cardIdentities = turn.products.map((product) => catalogProductIdentity(product?.url));
  if (cardIdentities.some((identity) => !identity) ||
    new Set(cardIdentities).size !== cardIdentities.length ||
    turn.unique_products_count !== cardIdentities.length ||
    turn.product_identity_evidence.length !== cardIdentities.length) return false;
  const cardSet = new Set(cardIdentities);
  const proofIdentities = new Set();
  const productKeys = new Set();
  for (const proof of turn.product_identity_evidence) {
    if (!isRecord(proof) || proof.verified !== true || !cardSet.has(proof.identity) ||
      proofIdentities.has(proof.identity) || !nonEmpty(proof.name) || proof.name.trim().length < 3) return false;
    const sku = nonEmpty(proof.sku) && proof.sku.trim() !== '0' ? proof.sku.trim() : null;
    const noSkuIdentity = proof.sku === null &&
      proof.identityMode === 'jsonld_no_sku_canonical_name_price_stock' &&
      sourceCanonicalIdentity(proof.canonicalUrl) === proof.identity &&
      isRecord(proof.facets) && Object.keys(proof.facets).length > 0 &&
      Number.isFinite(proof.offerPrice) && proof.offerPrice > 0 &&
      /^https?:\/\/schema\.org\/InStock$/iu.test(proof.availability ?? '');
    if (!sku && !noSkuIdentity) return false;
    proofIdentities.add(proof.identity);
    productKeys.add(sku ? `sku:${sku.toUpperCase()}` : `canonical:${proof.identity}`);
  }
  return proofIdentities.size >= 3 && productKeys.size >= 3;
}

function dn027bReportFailures(reports) {
  const failures = [];
  for (const report of reports) {
    if (report?.suite_file !== 'customer-acceptance-cases-v2.json' || !Array.isArray(report.cases)) continue;
    for (const testCase of report.cases) {
      if (testCase?.id !== 'customer-dn027b-analogs' || !Array.isArray(testCase.repeats)) continue;
      for (const [index, repeat] of testCase.repeats.entries()) {
        if (repeat?.variant !== 'base') continue;
        if (!confirmedDn027bCardinality(repeat.turns?.[0])) {
          failures.push({
            code: 'dn027b_three_distinct_verified_cards_missing',
            location: `customer-dn027b-analogs.repeats[${index}].turns[0]`,
          });
        }
      }
    }
  }
  return failures;
}

// The V8 validator is the shared, already-tested exact case/run/turn gate.
// Adapt *identities only* after proving the input is precisely the reviewed V9
// matrix. The adapter never changes prompts, oracles, statuses or result data.
function adaptInventoryToSharedGate(inventory) {
  const adapted = structuredClone(inventory);
  for (const file of adapted.matrix_files) {
    const prior = priorByV9.get(file.basename);
    if (prior) {
      file.basename = prior.file;
      file.sha256 = prior.sha256;
    }
  }
  for (const run of adapted.runs) {
    const prior = priorByV9.get(run.suite_basename);
    run.suite_basename = prior.file;
    run.suite_sha256 = prior.sha256;
    run.run_key = JSON.stringify([prior.file, prior.sha256, run.case_id, run.variant, run.repeat_index]);
    for (const turn of run.turns) {
      turn.suite_basename = prior.file;
      turn.suite_sha256 = prior.sha256;
      turn.run_key = run.run_key;
      turn.turn_key = JSON.stringify([
        prior.file, prior.sha256, run.case_id, run.variant, run.repeat_index, turn.turn_index,
      ]);
    }
  }
  return adapted;
}

function adaptReportsToSharedGate(reports) {
  return reports.map((report) => {
    if (!isRecord(report)) return report;
    const adapted = structuredClone(report);
    const prior = priorByV9.get(report.suite_file);
    if (prior) {
      adapted.suite_file = prior.file;
      adapted.suite_sha256 = prior.sha256;
      if (isRecord(adapted.strict_inventory)) adapted.strict_inventory.name = prior.file;
    }
    return adapted;
  });
}

/** Validate loaded V9 and separate prospective JSON without network calls or response-text output. */
export function validateReleaseEvidenceV9({ inventory, reports, attestation, dn027bProspectiveReport = null, nowMs = Date.now() }) {
  let canonical;
  try {
    canonical = buildReleaseLedgerV9(); // Verifies all five pinned source-file SHA256 values.
  } catch {
    return failed('pinned_v9_matrix_unavailable_or_changed');
  }
  if (!dn027bOracleIntact(canonical) || !dn027bOracleIntact(inventory)) {
    return failed('dn027b_three_analogs_oracle_invalid');
  }
  if (!heatShrinkOraclesIntact(canonical) || !heatShrinkOraclesIntact(inventory)) {
    return failed('heat_shrink_20pct_oracles_invalid');
  }
  if (!isRecord(inventory) || serializeReleaseLedger(inventory) !== serializeReleaseLedger(canonical)) {
    return failed('inventory_not_current_pinned_v9_matrix');
  }
  if (!Array.isArray(reports)) {
    return failed('report_count_mismatch');
  }
  for (const [index, report] of reports.entries()) {
    if (!isRecord(report)) continue; // The shared gate emits report_invalid.
    const manifest = currentByName.get(report.suite_file);
    if (!manifest || report.suite_sha256 !== manifest.sha256 ||
      report.variations_file !== (manifest.variations?.file ?? null) ||
      report.variations_sha256 !== (manifest.variations?.sha256 ?? null) ||
      report.strict_inventory?.name !== manifest.file) {
      return failed('report_not_pinned_to_v9_suite', `reports[${index}]`);
    }
    if (Object.hasOwn(report, 'status') || Object.hasOwn(report, 'infrastructure_status') ||
      Object.hasOwn(report, 'reason')) {
      return failed('report_not_run_or_infrastructure_unavailable', `reports[${index}]`);
    }
  }
  const summary = validateReleaseEvidence({
    inventory: adaptInventoryToSharedGate(inventory),
    reports: adaptReportsToSharedGate(reports),
    attestation,
    requireCatalogPreflight: true,
  });
  const evidenceFailures = dn027bReportFailures(reports);
  const failureCount = summary.failure_count + evidenceFailures.length;
  const failures = [...summary.failures, ...evidenceFailures].slice(0, MAX_DISPLAYED_FAILURES);
  const verdict = failureCount === 0 ? summary.verdict : 'FAIL';
  const prospectiveFailures = directAnalogProspectiveFailures(dn027bProspectiveReport, attestation, reports, nowMs);
  return {
    ...summary,
    verdict,
    verdict_scope: 'strict_v9_matrix_evidence_only',
    release_evidence_gate: releaseEvidenceGate(verdict, prospectiveFailures),
    failure_count: failureCount,
    failures,
    omitted_failure_count: Math.max(0, failureCount - failures.length),
  };
}

export function runCli(argv = process.argv.slice(2)) {
  let summary;
  try {
    const prospectiveArgs = argv.filter((arg) => arg.startsWith('--dn027b-report='));
    if (prospectiveArgs.length !== 1 || !prospectiveArgs[0].slice('--dn027b-report='.length).trim()) {
      throw new Error('one --dn027b-report=FILE is required');
    }
    const { attestationFile, reportFiles } = parseCliArgs(argv.filter((arg) => !arg.startsWith('--dn027b-report=')));
    if (argv.includes('--require-catalog-preflight')) {
      throw new Error('V9 catalog preflight is mandatory; this option is not needed');
    }
    const inventoryBytes = fs.readFileSync(inventoryFile, 'utf8');
    const canonicalBytes = serializeReleaseLedger(buildReleaseLedgerV9());
    summary = inventoryBytes === canonicalBytes
      ? validateReleaseEvidenceV9({
          inventory: JSON.parse(inventoryBytes),
          reports: reportFiles.map((filename) => JSON.parse(fs.readFileSync(path.resolve(filename), 'utf8'))),
          attestation: JSON.parse(fs.readFileSync(path.resolve(attestationFile), 'utf8')),
          dn027bProspectiveReport: JSON.parse(fs.readFileSync(
            path.resolve(prospectiveArgs[0].slice('--dn027b-report='.length)), 'utf8')),
        })
      : failed('inventory_not_current_pinned_v9_matrix');
  } catch {
    summary = failed('invalid_arguments_or_unreadable_json');
  }
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  return summary.release_evidence_gate.status === 'PASS' ? 0 : 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = runCli();
}

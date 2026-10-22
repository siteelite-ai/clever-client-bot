import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { MATRIX_MANIFESTS, serializeReleaseLedger } from './build-release-ledger.mjs';
import { V9_MATRIX_MANIFESTS, buildReleaseLedgerV9 } from './build-release-ledger-v9.mjs';
import { parseCliArgs, validateReleaseEvidence } from './validate-release-evidence.mjs';

// Read-only V9 full-matrix gate. Run after deploying a pinned preview candidate:
// node scripts/qa/validate-release-evidence-v9.mjs \
//   --attestation=deployment-assertion.json \
//   --report=customer-v9.json --report=audit-v9.json \
//   --report=notion-v9.json --report=cardinality-v9.json
// All four reports must be strict full-suite runs with a successful catalog
// preflight. The attestation is an operator assertion, not cryptographic proof.
// This gate assesses the V9 matrix evidence only; it does not authorize deploy.
// V9's original DN027B min_products=3 oracle does not prove that three SKUs are
// direct technical replacements. Even a V9 PASS requires the separate prospective
// DN027B contract and live SKU/stock/fit check tracked by GitHub issue #124.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const inventoryFile = path.join(root, 'docs/qa/release-inventory-v9-20261020.json');
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

function failed(code, location = null) {
  return {
    verdict: 'FAIL',
    verdict_scope: 'strict_v9_matrix_evidence_only',
    release_readiness: 'NOT_ASSESSED',
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

/** Validate loaded V9 JSON without network calls or response-text output. */
export function validateReleaseEvidenceV9({ inventory, reports, attestation }) {
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
  return {
    ...summary,
    verdict: failureCount === 0 ? summary.verdict : 'FAIL',
    verdict_scope: 'strict_v9_matrix_evidence_only',
    failure_count: failureCount,
    failures,
    omitted_failure_count: Math.max(0, failureCount - failures.length),
  };
}

export function runCli(argv = process.argv.slice(2)) {
  let summary;
  try {
    const { attestationFile, reportFiles } = parseCliArgs(argv);
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
        })
      : failed('inventory_not_current_pinned_v9_matrix');
  } catch {
    summary = failed('invalid_arguments_or_unreadable_json');
  }
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  return summary.verdict === 'PASS' ? 0 : 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = runCli();
}

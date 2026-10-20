import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { MATRIX_MANIFESTS, buildReleaseLedger, serializeReleaseLedger } from './build-release-ledger.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const outputFile = path.join(root, 'docs/qa/release-inventory-v9-20261020.json');

const HISTORICAL_V8_SHA256 = 'd41603654570985dc055fd2b82354604bcf903740329983ba66dd91e6f069ecd';
const CUSTOMER_V2_SHA256 = '6fb6646ba9f5bf8d612e6aa4c707d2954ad351be6a9a2f43b7cf9239a020c7e7';
const NOTION_V6_SHA256 = 'c45ef36b7bd713f003bfa4a46f2530f8e25b528947eb198f7f5243ff23a6f737';

// Replacement, not an append: historical suites and their evidence remain
// pinned to V8, while all 190 V9 runs bind to the successor bytes.
export const V9_MATRIX_MANIFESTS = MATRIX_MANIFESTS.map((manifest) => {
  if (manifest.file === 'customer-acceptance-cases.json') {
    return { ...manifest, file: 'customer-acceptance-cases-v2.json', sha256: CUSTOMER_V2_SHA256 };
  }
  if (manifest.file === 'notion-legacy-bug-cases-v5.json') {
    return { ...manifest, file: 'notion-legacy-bug-cases-v6.json', sha256: NOTION_V6_SHA256 };
  }
  return manifest;
});

export function buildReleaseLedgerV9({ readBytes = fs.readFileSync, manifests = V9_MATRIX_MANIFESTS } = {}) {
  const ledger = buildReleaseLedger({ readBytes, manifests });
  ledger.revision_note = 'V9 supersedes V8 only for three heat-shrink acceptance oracles: customer Ø12 mm, customer ТТУ Ø10 mm and Notion BT-929 Ø12 mm. For each product, live catalog facets must prove D before shrink >= 1.2 × cable diameter and D after shrink < cable diameter. The machine-readable mandatory selection criteria must express the same inclusive lower bound and strict upper bound. All customer prompts, other assertions, repetitions, synthetic markers and suite dimensions are preserved; V8/V5 files and reports are historical, not candidate evidence.';
  ledger.provenance_note = 'The two successor suites copy historical customer-acceptance-cases.json SHA256 549600818c83cb1813d05bba2e32316f71b42059596c973d5b814356d129b366 and notion-legacy-bug-cases-v5.json SHA256 f4ba64271c02cdbc7549be3061dc0171952fae8ac6555d2bba67d896209a1e61. Their only non-metadata changes are the three heat-shrink expectations. The policy comes from the customer’s direct 2026-10-20 decision «Строгий запас ≥20%: 14/7 не показывать» and is recorded in docs/qa/heat-shrink-20pct-decision-20261020.md. Original case locators are still null; suite-level source claims and synthetic continuations are not re-labelled as source quotations. Historical V8 reports or two targeted 20% runs do not establish V9 full-matrix PASS.';
  ledger.candidate.note = 'The V9 full matrix has not been run on a pinned candidate. Historical V8 results and the two targeted 20% production turns cannot be joined into a complete V9 verdict.';
  ledger.supersedes = {
    basename: 'release-inventory-v8-20261020.json',
    sha256: HISTORICAL_V8_SHA256,
    disposition: 'historical_immutable_not_candidate_evidence',
  };
  return ledger;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const flag = process.argv[2];
  if (!['--write', '--check'].includes(flag) || process.argv.length !== 3) {
    process.stderr.write('Usage: node scripts/qa/build-release-ledger-v9.mjs --write|--check\n');
    process.exitCode = 2;
  } else {
    const serialized = serializeReleaseLedger(buildReleaseLedgerV9());
    if (flag === '--write') {
      fs.writeFileSync(outputFile, serialized);
      process.stdout.write(`Wrote ${path.relative(root, outputFile)}\n`);
    } else {
      assert.equal(fs.readFileSync(outputFile, 'utf8'), serialized,
        'V9 inventory is stale; rebuild with --write after reviewing matrix changes');
      process.stdout.write('V9 inventory matches the pinned five-file successor matrix (190 runs, 280 turns).\n');
    }
  }
}

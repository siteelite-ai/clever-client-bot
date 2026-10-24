import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const runtime = readFileSync(
  new URL("../../supabase/functions/chat-consultant-v3/index.ts", import.meta.url),
  "utf8",
);
const flags = readFileSync(
  new URL(
    "../../supabase/functions/_shared/v3-tools/verified-manufacturer-flags.ts",
    import.meta.url,
  ),
  "utf8",
);

function section(source, start, end) {
  const from = source.indexOf(start);
  const until = source.indexOf(end, from + start.length);
  assert(from >= 0 && until > from, `cannot isolate ${start}`);
  return source.slice(from, until);
}

const guarded = section(
  runtime,
  "async function selectGuardedStructuralReplacement(",
  "async function selectVerifiedCompactReplacementContinuation(",
);
const egress = section(
  runtime,
  '} else if (ev.type === "products_block")',
  'ev.type === "quick_replies"',
);

test("direct proof is a separate default-off, server-owned lane dependent on verified facts", () => {
  const flag = flags.slice(flags.indexOf("export function directAnalogProofEnabled("));
  assert.match(flag, /scope === "preview"\s*\? "VOLT220_DIRECT_ANALOG_PROOF_PREVIEW_ENABLED"\s*: "VOLT220_DIRECT_ANALOG_PROOF_PRODUCTION_ENABLED"/u);
  assert.match(flag, /return verifiedManufacturerFactsEnabled\(scope, readEnv\) &&\s*readEnv\(name\) === "true"/u);
  assert.match(runtime, /const DIRECT_ANALOG_PROOF_ENABLED = directAnalogProofEnabled\(ADMISSION_SCOPE\)/u);
  assert.match(guarded, /const directAnalogProof = DIRECT_ANALOG_PROOF_ENABLED\s*\? buildDirectAnalogProof\(/u);
  assert.match(egress, /DIRECT_ANALOG_PROOF_ENABLED && stagedDirectProof && sourceFull &&/u);
});

test("selector certifies only the exact cards that passed selection and rendering", () => {
  const renderGuard = guarded.indexOf("rendered.rendered_count !== selected.length");
  const orderGuard = guarded.indexOf("rendered.rendered_ids.some((id, index) => id !== selectedIds[index])");
  const selectionContract = guarded.indexOf("const selectionContract = guardedStructuralSelectionContract({");
  const directProof = guarded.indexOf("const directAnalogProof = DIRECT_ANALOG_PROOF_ENABLED");
  const block = guarded.indexOf('type: "products_block"', directProof);
  assert(renderGuard >= 0 && orderGuard > renderGuard);
  assert(selectionContract > orderGuard && directProof > selectionContract && block > directProof);
  assert.match(guarded, /const selectedIds = selected\.map\(\(\{ full \}\) => full\.id\)/u);
  assert.match(guarded, /const selectionContract = guardedStructuralSelectionContract\(\{[\s\S]*?candidates: selected\.map\(\(\{ full \}\) => full\)/u);
  assert.match(guarded, /buildDirectAnalogProof\(\{\s*source,\s*candidates: selected\.map\(\(\{ full \}\) => full\),\s*customerCutoutMm/u);
  assert.match(guarded, /if \(directAnalogProof\) \{\s*Object\.assign\(selectionContract, \{ direct_analog_proof: directAnalogProof \}\)/u);
  assert.match(guarded, /type: "products_block",[\s\S]*?markdown: rendered\.markdown,[\s\S]*?count: rendered\.rendered_count,[\s\S]*?selection_contract: selectionContract/u);
});

test("egress rebuilds proof from exact live cache, source, and rendered order", () => {
  assert.match(egress, /const liveProducts = \[\.\.\.\(replacementEgressCache\?\.values\(\) \?\? \[\]\)\]/u);
  assert.match(egress, /const renderedProducts = liveProducts\.filter\(\(product\) =>\s*ev\.markdown\.includes\(`\]\(\$\{product\.url\}\)`\)\s*\)\.sort\(/u);
  assert.match(egress, /const source = resolveExactReplacementSource\(\s*replacementEgressRequest,\s*liveProducts,\s*renderedIds/u);
  assert.match(egress, /const sourceFull = source\s*\? liveProducts\.find\(\(product\) =>\s*product\.id === source\.id && product\.url ===\s*stagedDirectProof\?\.source_product_url/u);
  assert.match(egress, /DIRECT_ANALOG_PROOF_ENABLED && stagedDirectProof && sourceFull &&\s*renderedProducts\.length === ev\.count/u);
  assert.match(egress, /const rebuilt = buildDirectAnalogProof\(\{\s*source: sourceFull,\s*candidates: renderedProducts,\s*customerCutoutMm: stagedDirectProof\.target_cutout_mm/u);
  assert.match(egress, /rebuilt && JSON\.stringify\(rebuilt\) ===\s*JSON\.stringify\(stagedDirectProof\)/u);
  assert.match(egress, /if \([\s\S]*?\) confirmedDirectAnalogProof = rebuilt/u);
});

test("a missing or changed certificate keeps the provisional claim and cannot leak staged proof", () => {
  assert.match(guarded, /if \(!directAnalogProof\) \{\s*send\(\{\s*type: "delta",\s*origin: "server",\s*content: `Это предварительные кандидаты/u);
  assert.match(egress, /let confirmedDirectAnalogProof: DirectAnalogProof \| null = null/u);
  assert.match(egress, /const caption = confirmedDirectAnalogProof\s*\? `Кандидаты на замену:[\s\S]*?Прошли проверку по восьми критериям[\s\S]*?Совместимость по габаритам, глубине, подключению и условиям установки не подтверждена[\s\S]*?: replacementProofCaption\(replacementLastProof\)/u);
  assert.match(egress, /direct_analog_proof: confirmedDirectAnalogProof \?\? undefined/u);
  assert.doesNotMatch(egress, /direct_analog_proof: stagedDirectProof/u);
  const compare = egress.indexOf("JSON.stringify(stagedDirectProof)");
  const caption = egress.indexOf("const caption = confirmedDirectAnalogProof");
  const publicBlock = egress.indexOf("direct_analog_proof: confirmedDirectAnalogProof ?? undefined");
  assert(compare >= 0 && caption > compare && publicBlock > caption);
});

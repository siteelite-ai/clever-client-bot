import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const code = readFileSync(
  new URL("../../supabase/functions/chat-consultant-v3/index.ts", import.meta.url),
  "utf8",
);
const guardedStart = code.indexOf("async function selectGuardedStructuralReplacement(");
const directStart = code.indexOf("async function selectVerifiedOrdinaryReplacement(");
const directEnd = code.indexOf("async function selectVerifiedExactCompoundProducts(", directStart);
assert(guardedStart >= 0 && directStart > guardedStart && directEnd > directStart);
const guarded = code.slice(guardedStart, code.indexOf(
  "async function selectVerifiedCompactReplacementContinuation(", guardedStart,
));
const direct = code.slice(directStart, directEnd);

test("guarded cards are emitted only with a contract proven from the selected cards", () => {
  assert.match(guarded, /const selectionContract = guardedStructuralSelectionContract\(\{\s*profile,\s*candidates: selected\.map\(\(\{ full \}\) => full\),\s*customerCutoutMm,\s*budgetCap,\s*requested,/u);
  assert.match(guarded, /if \(!selectionContract\) \{[\s\S]*?return \{ handled: true, products: \[\], outcome: "upstream_error" \};\s*\}/u);
  assert.match(guarded, /type: "products_block",[\s\S]*?selection_contract: selectionContract,/u);
  assert(guarded.indexOf("if (!selectionContract)") < guarded.indexOf("selection_contract: selectionContract,"));
});

test("only a verified recessed source uses the cut-out path; surface mounts keep the existing structural branch", () => {
  const guardedMountExpression = direct.match(
    /const guardedStructuralMount\s*=\s*([\s\S]*?);/u,
  )?.[1];
  assert(guardedMountExpression, "guarded structural mount declaration is missing");
  const isGuardedMount = new Function(
    "VERIFIED_MANUFACTURER_FACTS_ENABLED",
    "structuralProfile",
    "hasVerifiedRecessedStructuralMount",
    `return Boolean(${guardedMountExpression});`,
  );
  const recessed = { mount: "recessed" };
  const isRecessed = (profile) => profile.mount === "recessed";
  // A verified recessed source must still follow the old route while the
  // server-owned feature flag is off, including a stale client cut-out slot.
  assert.equal(isGuardedMount(false, recessed, isRecessed), false);
  assert.equal(isGuardedMount(true, recessed, isRecessed), true);
  assert.equal(isGuardedMount(true, { mount: "surface" }, isRecessed), false);
  assert.equal(isGuardedMount(true, null, isRecessed), false);
  assert.match(direct, /if \(sourceOnlyVerified && structuralProfile && guardedStructuralMount\) \{\s*return await selectGuardedStructuralReplacement\(/u);
  assert.match(direct, /const selectionCriteria: Criterion\[\] = structuralProfile\s*\? structuralProfile\.obligations\.map/u);
  assert.match(direct, /if \(\s*customerCutoutMm !== null &&\s*\(!sourceOnlyVerified \|\| !guardedStructuralMount\)\s*\)/u);
});

test("numeric cut-out follow-up retains the original plural cardinality request", () => {
  assert.match(direct, /const requestedCardinality = resolveResultCardinality\(userMessage, \{/u);
  assert.match(direct, /selectGuardedStructuralReplacement\(\s*userMessage,\s*structuralProfile,\s*requestedCardinality,/u);
  assert.match(code, /selectVerifiedOrdinaryReplacement\(\s*issued\.original_request,\s*ctx,\s*send,\s*steps,\s*t0,\s*source,\s*verifiedCutoutMm,/u);
});

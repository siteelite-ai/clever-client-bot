import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  checkCriterion,
  extendSelectionCriteriaPlan,
} from "../../supabase/functions/_shared/v3-tools/criteria-gate.ts";
import {
  directReplacementEmptyOutcome,
  productProvesDirectReplacementAxes,
} from "../../supabase/functions/_shared/v3-tools/replacement-direct-facet-proof.ts";

const source = readFileSync(
  new URL("../../supabase/functions/chat-consultant-v3/index.ts", import.meta.url),
  "utf8",
);
const begin = source.indexOf("async function selectVerifiedOrdinaryReplacement(");
const end = source.indexOf("async function selectVerifiedExactCompoundProducts(", begin);
assert.ok(begin > -1 && end > begin);
const preflight = source.slice(begin, end);
const compactBegin = source.indexOf("async function selectVerifiedCompactReplacementContinuation(");
assert.ok(compactBegin > -1 && compactBegin < begin);
const compactPreflight = source.slice(compactBegin, begin);

test("ordinary direct analogue cards publish only live transferable axes and an explicit price cap", () => {
  assert.match(preflight, /selectExplicitAnchorAxes\(\s*anchor,\s*discovery\.facets,\s*userMessage/u);
  assert.match(preflight, /selectUserOwnedReplacementAxes\(\s*anchor,\s*discovery\.facets,\s*independentRequestFrame/u);
  assert.match(preflight, /options:\s*structuralProfile\?\.searchOptions\s*\?\?\s*Object\.fromEntries\(axes\.map\(\(axis\)\s*=>\s*\[axis\.key,\s*\[axis\.value\]\]\)\)/u);
  assert.match(preflight, /max_price:\s*budgetCap/u);
  assert.match(preflight, /product\.price <= budgetCap/u);

  const contract = preflight.slice(preflight.indexOf("const selectionCriteria: Criterion[]"));
  assert.match(contract, /discovery\.facets\.find\(\(\{ key \}\) => key === axis\.key\)/u);
  assert.match(contract, /key:\s*axis\.caption,[\s\S]*?value:\s*axis\.value,[\s\S]*?evidence:\s*independentRequestFrame !== null\s*\? "user_explicit"\s*:\s*"derived_required"/u);
  assert.match(contract, /if \(budgetCap !== null\) \{[\s\S]*?key:\s*"Цена",[\s\S]*?op:\s*"max",[\s\S]*?value:\s*budgetCap,[\s\S]*?evidence:\s*"user_explicit"/u);
  assert.match(contract, /selection_contract:\s*\{[\s\S]*?hash:\s*selectionPlan\.hash,[\s\S]*?mandatory_criteria:\s*selectionPlan\.mandatory_criteria/u);
  assert.doesNotMatch(contract, /key:\s*(?:sourceModel|sourceModels|anchor\.pagetitle|sourceDescription)/u);
  assert.match(contract, /structuralProfile\.obligations\.map\(\(obligation\)\s*=>/u);
  assert.match(preflight, /evaluateStructuralReplacementCandidate\(\s*structuralProfile,\s*ctx\.cache\.get\(product\.id\)/u);
  assert.match(preflight, /selected\.length < requestedCardinality\.target && structuralProfile &&\s*strict\.ok/u);
  assert.match(preflight, /resultCardinalityShortfallText\(\s*selected\.length,\s*requestedCardinality/u);
  assert.match(preflight, /if \(selected\.length === 0 && !structuralProfile\)/u);
});

test("title-only code is distinguished from live facet proof on every direct branch", () => {
  assert.match(preflight, /requiredVisibleCodes\.every\(\(code\) =>/u);
  assert.match(preflight, /kind:\s*"title_code",\s*label:\s*"Код в названии товара"/u);
  assert.doesNotMatch(preflight, /key:\s*"Характеристика срабатывания"/u);
  assert.match(preflight, /const isCandidate[\s\S]*?productProvesDirectReplacementAxes\(\s*ctx\.cache\.get\(product\.id\),\s*axes,\s*budgetCap,/u);
  assert.match(preflight, /strict\.results\s*\.filter\(isCandidate\)/u);

  const broadStart = preflight.indexOf("if (equivalentOnly && selected.length === 0)");
  const broadCandidateGate = preflight.indexOf("const broadCandidates = broad.results", broadStart);
  const responseStart = preflight.indexOf("const elapsed = Date.now() - started", broadCandidateGate);
  assert.ok(broadStart > -1 && broadCandidateGate > broadStart && responseStart > broadCandidateGate);
  const broad = preflight.slice(broadStart, responseStart);
  assert.match(broad, /broad\.results\s*\.filter\(isCandidate\)/u);
  assert.doesNotMatch(broad, /filterReplacementCompatibleIds\(/u);
  assert.match(preflight, /result\.results\s*\.filter\(isCandidate\)/u);
});

test("compact-code continuation verifies each returned card before publishing its live contract", () => {
  assert.match(compactPreflight, /productProvesDirectReplacementAxes\(product,\s*contract\.axes,\s*budgetCap\)/u);
  assert.match(compactPreflight, /if \(filtered\.total > 0\) \{[\s\S]*?return null;/u);
  assert.match(compactPreflight, /total_available:\s*selected\.length/u);
  assert.match(compactPreflight, /max_price:\s*budgetCap/u);
  assert.match(compactPreflight, /key:\s*"Цена",[\s\S]*?op:\s*"max",[\s\S]*?value:\s*budgetCap/u);
});

test("raw strict matches without per-card facets delegate before any direct products block", () => {
  const axes = [
    { key: "diameter", value: "90" },
    { key: "voltage", value: "220" },
  ];
  for (const facet_values of [
    { voltage: ["220"] },
    { diameter: ["75"], voltage: ["220"] },
  ]) {
    assert.equal(productProvesDirectReplacementAxes({ price: 900, facet_values }, axes, 1000), false);
    assert.equal(directReplacementEmptyOutcome({
      strictTotal: 1,
      splitTotals: [1, 1],
      unverifiedFacetCount: 1,
    }), "query_inconsistent");
  }
  assert.match(preflight, /if \(!proven\) unverifiedFacetCandidateIds\.add\(product\.id\)/u);
  const classification = preflight.indexOf("const emptyOutcome = directReplacementEmptyOutcome({");
  const directReturn = preflight.indexOf("outcome: emptyOutcome,", classification);
  const productsBlock = preflight.indexOf('type: "products_block"', classification);
  assert(classification > -1 && directReturn > classification && productsBlock > directReturn);
});

test("all search pools truly empty retains confirmed_empty", () => {
  assert.equal(directReplacementEmptyOutcome({
    strictTotal: 0,
    splitTotals: [0, 0],
    broadTotal: 0,
    unverifiedFacetCount: 0,
  }), "confirmed_empty");
});

test("portable 1P/16A/4.5kA evidence and customer budget form a non-identity contract", () => {
  const axes = [
    { key: "Номинальный ток", value: "16", unit: "А" },
    { key: "Количество полюсов", value: "1" },
    { key: "Номинальная откл способность, кА", value: "4.5", unit: "кА" },
  ];
  const plan = extendSelectionCriteriaPlan(null, [
    ...axes.map(({ key, value, unit }) => ({
      key,
      op: "eq",
      value,
      ...(unit ? { unit } : {}),
      level: "A",
      evidence: "derived_required",
    })),
    {
      key: "Цена",
      op: "max",
      value: 1000,
      unit: "₸",
      level: "A",
      evidence: "user_explicit",
    },
  ], "guarded_search");
  assert.deepEqual(plan.mandatory_criteria.map(({ key }) => key), [
    ...axes.map(({ key }) => key),
    "Цена",
  ]);
  assert(plan.mandatory_criteria.every(({ key }) => !/GENERICA|IEK|ВА 47-29|модель|артикул/iu.test(key)));
  assert.equal(plan.mandatory_criteria.find(({ key }) => key === "Цена")?.op, "max");

  const affordable = {
    pagetitle: "Автомат Himel 1P 16A C 4.5kA",
    price: 562,
    short_traits: [
      "Номинальный ток: 16",
      "Количество полюсов: 1",
      "Номинальная откл способность, кА: 4.5",
    ],
  };
  assert(plan.mandatory_criteria.every((criterion) =>
    checkCriterion(affordable, criterion).verdict === "pass"
  ));
  assert.equal(checkCriterion({ ...affordable, price: 1200 },
    plan.mandatory_criteria.find(({ key }) => key === "Цена")).verdict, "fail");
});

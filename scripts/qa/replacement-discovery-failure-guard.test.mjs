import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { productContainsExactModelCode } from "../../supabase/functions/_shared/v3-tools/replacement-preflight.ts";

const source = readFileSync(
  new URL("../../supabase/functions/chat-consultant-v3/index.ts", import.meta.url),
  "utf8",
);
const begin = source.indexOf("async function selectVerifiedOrdinaryReplacement(");
const end = source.indexOf("async function selectVerifiedExactCompoundProducts(", begin);
assert.ok(begin > -1 && end > begin);
const preflight = source.slice(begin, end);
const failedDiscoveryGuardStart = preflight.indexOf(
  "if (!anchor && !sourceClassDiscovery.ok) {",
);
const anchorPreflightStart = preflight.indexOf("if (!anchor?.leaf_category) {");
assert.ok(failedDiscoveryGuardStart > -1 && anchorPreflightStart > failedDiscoveryGuardStart);
const failedDiscoveryGuard = preflight.slice(
  failedDiscoveryGuardStart,
  anchorPreflightStart,
);

test("failed source-class discovery is logged without user text or credentials", () => {
  assert.match(preflight, /const sourceClassDiscoveryStarted = Date\.now\(\)/u);
  assert.match(preflight, /const sourceClassDiscoveryMs = Date\.now\(\) - sourceClassDiscoveryStarted/u);
  const logStart = preflight.indexOf('step: "v3_replacement_source_class_discovery_failed"');
  const logEnd = preflight.indexOf("});", logStart);
  assert.ok(logStart > -1 && logEnd > logStart);
  const log = preflight.slice(logStart, logEnd);
  assert.match(log, /error_code: sourceClassDiscovery\.error_code/u);
  assert.match(log, /discovery_ms: sourceClassDiscoveryMs/u);
  assert.doesNotMatch(log, /catalogToken|openrouterKey|userMessage|sourceDescription/u);
});

test("unknown class avoids broad serial searches and accepts only unique literal model identity", () => {
  assert.match(preflight, /if \(sourceDescription && sourceClassDiscovery\.ok\) \{[\s\S]*?mode: "by_query",\s*query: sourceDescription/u);
  assert.match(preflight, /sourceClassDiscovery\.ok \? 3 : 2/u);
  assert.match(preflight, /const uniqueLiteralModel = found\.ok && found\.total === 1/u);
  assert.match(preflight, /uniqueLiteralModel && productContainsExactModelCode\(product, code\)/u);
  assert.match(preflight, /if \(grounded\.length === 0 && sourceClassDiscovery\.ok\) \{[\s\S]*?mode: "by_query",\s*query: code/u);
  assert.match(preflight, /let failedClassLiteralQueryUsed = false/u);
  assert.match(preflight, /grounded\.length === 0 && !sourceClassDiscovery\.ok &&\s*sourceClassDiscovery\.error_code === "category_not_found" &&\s*!failedClassLiteralQueryUsed &&\s*normalizeCodeLike\(code\)\.length >= 5/u);
  assert.match(preflight, /failedClassLiteralQueryUsed = true;\s*const literal = await executeSearchCatalog/u);
  assert.match(preflight, /mode: "by_query",\s*query: code,\s*per_page: 5/u);
  assert.match(preflight, /literal\.ok && literal\.total === 1\s*\? literal\.results\.filter\(\(product\) =>\s*productContainsExactModelCode\(product, code\)/u);
  assert.match(preflight, /for \(const article of lookup\.articles\) \{[\s\S]*?mode: "by_article"/u);
});

test("literal model fallback requires an exact title code, not a partial prefix", () => {
  const exact = { pagetitle: "Светильник встраиваемый DN027B G2 LED6/NW" };
  assert.equal(productContainsExactModelCode(exact, "DN027B"), true);
  assert.equal(productContainsExactModelCode(exact, "DN027"), false);
});

test("unverified source stops before expert delegation and never claims empty catalog", () => {
  assert.match(failedDiscoveryGuard, /sourceClassDiscovery\.error_code === "category_not_found"/u);
  assert.match(failedDiscoveryGuard, /Повторите запрос на подбор аналога, указав тип исходного товара и точный артикул или его полное название/u);
  assert.match(failedDiscoveryGuard, /Повторите запрос на подбор аналога позже, указав точный артикул или полное название исходного товара/u);
  assert.match(failedDiscoveryGuard, /Это не означает, что аналогов нет/u);
  assert.doesNotMatch(failedDiscoveryGuard, /ссылк/u);
  assert.match(failedDiscoveryGuard, /handled: true,[\s\S]*?products: \[\],[\s\S]*?outcome: categoryUnresolved \? "query_inconsistent" : "upstream_error"/u);
  assert.doesNotMatch(failedDiscoveryGuard, /runExpertLoop\(|confirmed_empty|Ничего не наш/u);
  assert.ok(preflight.indexOf("anchor = [...sourcePool.values()]") < failedDiscoveryGuardStart);
});

test("successful live-facet clarification and anchored preflight remain available", () => {
  assert.ok(preflight.indexOf("sourceClassDiscovery.ok && liveClarification &&") < failedDiscoveryGuardStart);
  assert.match(preflight, /shouldClarifyCompactReplacementSource\(\{/u);
  assert.match(preflight, /const discovery = await executeDiscoverCategory\(\{\s*noun: anchor\.leaf_category/u);
  assert.ok(preflight.indexOf("const discovery = await executeDiscoverCategory({\n    noun: anchor.leaf_category") > failedDiscoveryGuardStart);
});

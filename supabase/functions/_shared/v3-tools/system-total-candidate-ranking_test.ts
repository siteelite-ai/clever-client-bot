import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  rankSystemTotalCandidates,
  type SystemTotalRankingPolicy,
  type SystemTotalRankingRequirement,
} from "./system-total-candidate-ranking.ts";
import type { SystemPlanProductEvidence } from "./system-total-capacity.ts";

const requirement: SystemTotalRankingRequirement = {
  measurementScope: "system_total",
  outputFacet: { key: "flux", caption: "Световой поток, лм", unit: "лм" },
  unit: "лм",
};

const policy: SystemTotalRankingPolicy = {
  minimumVerifiedAlternatives: 3,
  severeOutputGapFactor: 2,
};

function product(id: string, output: string): SystemPlanProductEvidence {
  return {
    id,
    pagetitle: `Прожектор ${id}`,
    facet_values: { flux: [output] },
    short_traits: [`Световой поток: ${output}`],
  };
}

function ids(products: { product: SystemPlanProductEvidence }[]): string[] {
  return products.map(({ product }) => product.id);
}

Deno.test("800 lm is output-dominated when three verified 1800+ alternatives remain", () => {
  const ranking = rankSystemTotalCandidates(requirement, [
    product("low", "800 лм"),
    product("mid", "1 800 лм"),
    product("high", "2 400 лм"),
    product("middle", "1 900 лм"),
  ], policy);
  assertEquals(ranking.rankingEligible, true);
  assertEquals(ids(ranking.retained), ["high", "middle", "mid"]);
  assertEquals(ids(ranking.excludedVeryLowOutput), ["low"]);
  assertEquals(ranking.retained[0].perUnitOutput, 2400);
  assertEquals(ranking.canClaimSystemSufficiency, false);
});

Deno.test("a low-output option stays when not enough stronger verified alternatives exist", () => {
  const ranking = rankSystemTotalCandidates(requirement, [
    product("low", "800 лм"),
    product("mid", "1 800 лм"),
    product("high", "2 000 лм"),
  ], policy);
  assertEquals(ids(ranking.retained), ["high", "mid", "low"]);
  assertEquals(ranking.excludedVeryLowOutput, []);
});

Deno.test("missing and mixed-unit outputs are never counted as stronger proof", () => {
  const ranking = rankSystemTotalCandidates(requirement, [
    product("low", "800 лм"),
    product("strong-a", "1 800 лм"),
    product("strong-b", "2 000 лм"),
    { id: "missing", pagetitle: "Без потока", facet_values: {} },
    product("wrong-unit", "3 000 Вт"),
  ], policy);
  assertEquals(ids(ranking.retained), [
    "strong-b",
    "strong-a",
    "low",
    "missing",
    "wrong-unit",
  ]);
  assertEquals(ranking.excludedVeryLowOutput, []);
  assertEquals(ranking.retained[3].outputIssue, "missing_output");
  assertEquals(ranking.retained[4].outputIssue, "unit_mismatch");
  assertEquals(ranking.retained[3].perUnitOutput, null);
  assertEquals(ranking.retained[4].perUnitOutput, null);
});

Deno.test("unknown outputs remain visible even when verified low output is pruned", () => {
  const ranking = rankSystemTotalCandidates(requirement, [
    product("low", "800 лм"),
    product("strong-a", "1 800 лм"),
    product("strong-b", "1 900 лм"),
    product("strong-c", "2 000 лм"),
    product("range", "800–1000 лм"),
  ], policy);
  assertEquals(ids(ranking.retained), [
    "strong-c",
    "strong-b",
    "strong-a",
    "range",
  ]);
  assertEquals(ids(ranking.excludedVeryLowOutput), ["low"]);
  assertEquals(ranking.retained[3].outputIssue, "ambiguous_output");
});

Deno.test("distinct live SKUs, not duplicate search hits, set the safety margin", () => {
  const ranking = rankSystemTotalCandidates(requirement, [
    product("low", "800 лм"),
    product("strong-a", "1 800 лм"),
    product("strong-a", "1 800 лм"),
    product("strong-b", "2 000 лм"),
  ], policy);
  assertEquals(ids(ranking.retained), ["strong-b", "strong-a", "low"]);
  assertEquals(ranking.excludedVeryLowOutput, []);
});

Deno.test("relative output policy is unit-neutral and not a per-card total threshold", () => {
  const outputRequirement = {
    measurementScope: "system_total" as const,
    outputFacet: {
      key: "yield",
      caption: "Производительность, кг",
      unit: "кг",
    },
    unit: "кг",
  };
  const options: SystemPlanProductEvidence[] = [
    { id: "low", facet_values: { yield: ["4 кг"] } },
    { id: "a", facet_values: { yield: ["9 кг"] } },
    { id: "b", facet_values: { yield: ["10 кг"] } },
    { id: "c", facet_values: { yield: ["11 кг"] } },
  ];
  const ranking = rankSystemTotalCandidates(outputRequirement, options, policy);
  assertEquals(ids(ranking.retained), ["c", "b", "a"]);
  assertEquals(ids(ranking.excludedVeryLowOutput), ["low"]);
  assertEquals(ranking.canClaimSystemSufficiency, false);
});

Deno.test("scope or overly aggressive pruning policy fails closed", () => {
  const options = [product("low", "800 лм"), product("high", "2 000 лм")];
  const wrongScope = rankSystemTotalCandidates(
    { ...requirement, measurementScope: "per_product" },
    options,
    { minimumVerifiedAlternatives: 1, severeOutputGapFactor: 2 },
  );
  assertEquals(wrongScope.rankingEligible, false);
  assertEquals(ids(wrongScope.retained), ["low", "high"]);
  assertEquals(wrongScope.excludedVeryLowOutput, []);

  const weakGap = rankSystemTotalCandidates(requirement, options, {
    minimumVerifiedAlternatives: 1,
    severeOutputGapFactor: 1.5,
  });
  assertEquals(weakGap.rankingEligible, false);
  assertEquals(ids(weakGap.retained), ["low", "high"]);
  assertEquals(weakGap.excludedVeryLowOutput, []);
});

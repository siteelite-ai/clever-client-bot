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
  minimumTotal: 1800,
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

Deno.test("800 lm remains a possible multi-unit choice alongside closer verified options", () => {
  const ranking = rankSystemTotalCandidates(requirement, [
    product("low", "800 лм"),
    product("mid", "1 800 лм"),
    product("high", "2 400 лм"),
    product("middle", "1 900 лм"),
  ], policy);
  assertEquals(ranking.rankingEligible, true);
  assertEquals(ids(ranking.retained), ["mid", "middle", "high", "low"]);
  assertEquals(ranking.excludedVeryLowOutput, []);
  assertEquals(ranking.retained[0].perUnitOutput, 1800);
  assertEquals(ranking.canClaimSystemSufficiency, false);
});

Deno.test("a low-output option stays when not enough stronger verified alternatives exist", () => {
  const ranking = rankSystemTotalCandidates(requirement, [
    product("low", "800 лм"),
    product("mid", "1 800 лм"),
    product("high", "2 000 лм"),
  ], policy);
  assertEquals(ids(ranking.retained), ["mid", "high", "low"]);
  assertEquals(ranking.excludedVeryLowOutput, []);
});

Deno.test("missing and mixed-unit outputs are not offered when enough verified alternatives exist", () => {
  const ranking = rankSystemTotalCandidates(requirement, [
    product("low", "800 лм"),
    product("strong-a", "1 800 лм"),
    product("strong-b", "2 000 лм"),
    { id: "missing", pagetitle: "Без потока", facet_values: {} },
    product("wrong-unit", "3 000 Вт"),
  ], policy);
  assertEquals(ids(ranking.retained), [
    "strong-a",
    "strong-b",
    "low",
  ]);
  assertEquals(ranking.excludedVeryLowOutput, []);
  assertEquals(ids(ranking.excludedUnverifiedOutput), [
    "missing",
    "wrong-unit",
  ]);
  assertEquals(ranking.excludedUnverifiedOutput[0].outputIssue, "missing_output");
  assertEquals(ranking.excludedUnverifiedOutput[1].outputIssue, "unit_mismatch");
});

Deno.test("unknown output is a fallback only when verified choices fall short", () => {
  const ranking = rankSystemTotalCandidates(requirement, [
    product("strong-a", "1 800 лм"),
    product("range", "800–1000 лм"),
  ], policy);
  assertEquals(ids(ranking.retained), ["strong-a", "range"]);
  assertEquals(ranking.excludedUnverifiedOutput, []);
  assertEquals(ranking.retained[1].outputIssue, "ambiguous_output");
});

Deno.test("distinct live SKUs, not duplicate search hits, set the safety margin", () => {
  const ranking = rankSystemTotalCandidates(requirement, [
    product("low", "800 лм"),
    product("strong-a", "1 800 лм"),
    product("strong-a", "1 800 лм"),
    product("strong-b", "2 000 лм"),
  ], policy);
  assertEquals(ids(ranking.retained), ["strong-a", "strong-b", "low"]);
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
    minimumTotal: 10,
  };
  const options: SystemPlanProductEvidence[] = [
    { id: "low", facet_values: { yield: ["4 кг"] } },
    { id: "a", facet_values: { yield: ["9 кг"] } },
    { id: "b", facet_values: { yield: ["10 кг"] } },
    { id: "c", facet_values: { yield: ["11 кг"] } },
  ];
  const ranking = rankSystemTotalCandidates(outputRequirement, options, policy);
  assertEquals(ids(ranking.retained), ["b", "c", "a", "low"]);
  assertEquals(ranking.excludedVeryLowOutput, []);
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

Deno.test("system-total proximity ranks moderately sized proven options before MEGA and unknown", () => {
  const ranking = rankSystemTotalCandidates(requirement, [
    product("mega-1000w", "100 000 лм"),
    product("mega-600w", "60 000 лм"),
    product("mega-400w", "40 000 лм"),
    product("compact-800", "800 лм"),
    product("compact-1500", "1 500 лм"),
    product("compact-1800", "1 800 лм"),
    product("compact-2200", "2 200 лм"),
    product("compact-3000", "3 000 лм"),
    { id: "rgb-no-flow", facet_values: {} },
  ], policy);
  assertEquals(ids(ranking.retained).slice(0, 5), [
    "compact-1800",
    "compact-1500",
    "compact-2200",
    "compact-3000",
    "compact-800",
  ]);
  assertEquals(ids(ranking.retained).slice(5), [
    "mega-400w",
    "mega-600w",
    "mega-1000w",
  ]);
  assertEquals(ids(ranking.excludedUnverifiedOutput), ["rgb-no-flow"]);
  assertEquals(ranking.canClaimSystemSufficiency, false);
});

Deno.test("a pool containing only oversized proven cards cannot invent suitable alternatives", () => {
  const ranking = rankSystemTotalCandidates(requirement, [
    product("mega-1000w", "100 000 лм"),
    product("mega-600w", "60 000 лм"),
    product("mega-500w", "50 000 лм"),
    product("mega-400w", "40 000 лм"),
    { id: "rgb-no-flow", facet_values: {} },
  ], policy);
  assertEquals(ids(ranking.retained), [
    "mega-400w",
    "mega-500w",
    "mega-600w",
    "mega-1000w",
  ]);
  assertEquals(ids(ranking.excludedUnverifiedOutput), ["rgb-no-flow"]);
  assertEquals(ranking.canClaimSystemSufficiency, false);
});

Deno.test("missing total proof or non-total scope cannot reorder other applications", () => {
  const options = [product("first", "5 000 лм"), product("second", "2 000 лм")];
  const noTotal = rankSystemTotalCandidates(
    { ...requirement, minimumTotal: NaN },
    options,
    policy,
  );
  assertEquals(noTotal.rankingEligible, false);
  assertEquals(ids(noTotal.retained), ["first", "second"]);
  assertEquals(noTotal.excludedUnverifiedOutput, []);
});

import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import type { Criterion } from "./criteria-gate.ts";
import type { Facet } from "./discover-category.ts";
import type { PartialApplicationClassGuard } from "./partial-application-class-guard.ts";
import {
  buildSparseFeatureRecoveryPlan,
  hasPriceOrderingIntentForSparseRecovery,
  mergeProvenRecoveryIds,
} from "./sparse-feature-recovery-plan.ts";

const facets: Facet[] = [
  {
    key: "kind",
    caption: "Вид изделия",
    type: "string",
    unit: null,
    values: [
      { value: "Бытовые накладные", products_count: 40 },
      { value: "Бытовые настенные", products_count: 35 },
      { value: "Изделия для ЖКХ", products_count: 80 },
    ],
  },
  {
    key: "feature",
    caption: "С датчиком движения",
    type: "string",
    unit: null,
    values: [
      { value: "Да", products_count: 9 },
      { value: "Нет", products_count: 120 },
    ],
  },
];
const guards: PartialApplicationClassGuard[] = [{
  facetKey: "kind",
  facetCaption: "Вид изделия",
  ownedStems: ["бытов"],
  compatibleValues: ["Бытовые накладные", "Бытовые настенные"],
  contradictoryValues: ["Изделия для ЖКХ"],
  productClassStems: ["издел"],
}];
const affirmative: Criterion = {
  key: "С датчиком движения",
  op: "eq",
  value: "Да",
  level: "A",
  evidence: "user_explicit",
};

Deno.test("sparse positive feature retrieves only exact compatible live class values", () => {
  const plan = buildSparseFeatureRecoveryPlan({
    facets,
    categoryTotal: 200,
    customerCriteria: [affirmative],
    terminalCriteria: [affirmative],
    classGuards: guards,
  });
  assertEquals(plan?.featureFacetKey, "feature");
  assertEquals(plan?.positiveCount, 9);
  assertEquals(plan?.branches.map(({ options }) => options), [
    { kind: ["Бытовые накладные"] },
    { kind: ["Бытовые настенные"] },
  ]);
  assertEquals(
    plan?.branches.every(({ options }) => !("feature" in options)),
    true,
  );
});

Deno.test("no sparse, frozen, customer-owned affirmative feature means no recovery", () => {
  const common = {
    facets,
    categoryTotal: 200,
    customerCriteria: [affirmative],
    terminalCriteria: [affirmative],
    classGuards: guards,
  };
  assertEquals(
    buildSparseFeatureRecoveryPlan({
      ...common,
      facets: facets.map((facet) =>
        facet.key === "feature"
          ? { ...facet, values: [{ value: "Да", products_count: 100 }] }
          : facet
      ),
    }),
    null,
  );
  assertEquals(
    buildSparseFeatureRecoveryPlan({
      ...common,
      customerCriteria: [{ ...affirmative, evidence: "model_assumption" }],
    }),
    null,
  );
  assertEquals(
    buildSparseFeatureRecoveryPlan({
      ...common,
      terminalCriteria: [],
    }),
    null,
  );
  assertEquals(
    buildSparseFeatureRecoveryPlan({
      ...common,
      classGuards: [],
    }),
    null,
  );
  assertEquals(
    buildSparseFeatureRecoveryPlan({
      ...common,
      facets: facets.map((facet) =>
        facet.key === "feature"
          ? { ...facet, values: [{ value: "Да" }] }
          : facet
      ),
    }),
    null,
  );
});

Deno.test("stale class values and feature/class key collision fail closed", () => {
  const common = {
    facets,
    categoryTotal: 200,
    customerCriteria: [affirmative],
    terminalCriteria: [affirmative],
    classGuards: guards,
  };
  assertEquals(
    buildSparseFeatureRecoveryPlan({
      ...common,
      classGuards: [{ ...guards[0], compatibleValues: ["Missing subtype"] }],
    }),
    null,
  );
  assertEquals(
    buildSparseFeatureRecoveryPlan({
      ...common,
      classGuards: [{ ...guards[0], facetKey: "feature" }],
    }),
    null,
  );
});

Deno.test("live class counts establish sparsity when category total is unavailable", () => {
  const plan = buildSparseFeatureRecoveryPlan({
    facets: facets.map((facet) =>
      facet.key === "feature"
        ? { ...facet, values: [{ value: "Да", products_count: 9 }] }
        : facet
    ),
    categoryTotal: 0,
    customerCriteria: [affirmative],
    terminalCriteria: [affirmative],
    classGuards: guards,
  });
  assertEquals(plan?.scopeCount, 155);
  assertEquals(plan?.branches.length, 2);
});

Deno.test("one live frozen class guard can retrieve while another stays final-only", () => {
  const plan = buildSparseFeatureRecoveryPlan({
    facets,
    categoryTotal: 200,
    customerCriteria: [affirmative],
    terminalCriteria: [affirmative],
    classGuards: [
      { ...guards[0], facetKey: "stale_kind" },
      guards[0],
    ],
  });
  assertEquals(plan?.branches.length, 2);
  assertEquals(plan?.branches[0].options, { kind: ["Бытовые накладные"] });
});

Deno.test("partial proven pools can fill cardinality without duplicate cards", () => {
  assertEquals(
    mergeProvenRecoveryIds(["sparse-1"], ["broad-1"], [
      "sparse-1",
      "query-1",
    ]),
    ["sparse-1", "broad-1", "query-1"],
  );
  assertEquals(mergeProvenRecoveryIds(["sparse-1"], [], []), ["sparse-1"]);
});

Deno.test("price ordering, including a simultaneous budget, excludes unsorted sparse recovery", () => {
  assertEquals(
    hasPriceOrderingIntentForSparseRecovery("самый дешевый до 4000 тенге"),
    true,
  );
  assertEquals(
    hasPriceOrderingIntentForSparseRecovery("самые дорогие модели"),
    true,
  );
  assertEquals(
    hasPriceOrderingIntentForSparseRecovery("вариант подешевле"),
    true,
  );
  assertEquals(
    hasPriceOrderingIntentForSparseRecovery("не дороже 4000 тенге"),
    false,
  );
  assertEquals(hasPriceOrderingIntentForSparseRecovery("до 4000 тенге"), false);
});

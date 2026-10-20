import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { extendSelectionCriteriaPlan } from "../_shared/v3-tools/criteria-gate.ts";
import { hasUnresolvedEnvironmentalProtectionObligation } from "../_shared/v3-tools/selection-actionability.ts";

// Import the pure controller helpers without starting the HTTP handler.
const originalServe = Deno.serve;
const originalEnvGet = Deno.env.get;
Deno.serve = (() => ({
  finished: Promise.resolve(),
  shutdown() {},
})) as unknown as typeof Deno.serve;
Deno.env.get = (() => undefined) as typeof Deno.env.get;
const { declaredExactFacetCriterion, omitUnownedExactFacetOptions } =
  await import("./index.ts").finally(() => {
    Deno.serve = originalServe;
    Deno.env.get = originalEnvGet;
  });

const facets = [
  {
    key: "ip",
    caption: "Степень защиты",
    type: "string",
    unit: null,
    values: [{ value: "IP20" }, { value: "IP44" }, { value: "IP54" }, {
      value: "IP65",
    }],
  },
  {
    key: "brand",
    caption: "Бренд",
    type: "string",
    unit: null,
    values: [{ value: "Alpha" }, { value: "Beta" }],
  },
];

Deno.test("model-only exact IP is advice, not a frozen hard criterion or outdoor proof", () => {
  const proposed = declaredExactFacetCriterion("Степень защиты", "IP44", false);
  assertEquals(proposed.level, "B");
  assertEquals(proposed.evidence, "model_assumption");
  const plan = extendSelectionCriteriaPlan(
    null,
    [proposed],
    "reasoning_projection",
  );
  assertEquals(plan.mandatory_criteria, []);
  assertEquals(
    hasUnresolvedEnvironmentalProtectionObligation(
      "Нужен прожектор на улицу для двора частного дома, высота до 4 м, площадь до 50 м²",
      facets,
      {
        requiredFacetValues: plan.mandatory_criteria.map(({ key, value }) => ({
          key,
          value: String(value),
        })),
      },
    ),
    true,
  );
});

Deno.test("explicit exact IP remains mandatory and cannot be removed from retrieval", () => {
  const explicit = declaredExactFacetCriterion("Степень защиты", "IP65", true);
  const plan = extendSelectionCriteriaPlan(
    null,
    [explicit],
    "reasoning_projection",
  );
  assertEquals(plan.mandatory_criteria, [explicit]);
  const filtered = omitUnownedExactFacetOptions(
    { ip: ["IP44", "IP65"] },
    facets,
    [{ key: "Степень защиты", value: "IP44" }, {
      key: "Степень защиты",
      value: "IP65",
    }],
    [{ key: "Степень защиты", value: "IP65" }],
  );
  assertEquals(filtered.options, { ip: ["IP65"] });
  assertEquals(filtered.removed, [{ key: "ip", value: "IP44" }]);
});

Deno.test("ungrounded exact advice never narrows an unrelated catalog facet", () => {
  const modelBrand = declaredExactFacetCriterion("Бренд", "Alpha", false);
  const derivedMeasured = {
    key: "Мощность",
    op: "min" as const,
    value: 100,
    unit: "Вт",
    level: "A" as const,
    evidence: "derived_required" as const,
  };
  const plan = extendSelectionCriteriaPlan(
    null,
    [modelBrand, derivedMeasured],
    "reasoning_projection",
  );
  assertEquals(plan.mandatory_criteria, [derivedMeasured]);
  const filtered = omitUnownedExactFacetOptions(
    { brand: ["Alpha", "Beta"], ip: ["IP65"] },
    facets,
    [{ key: "Бренд", value: "Alpha" }],
  );
  assertEquals(filtered.options, { brand: ["Beta"], ip: ["IP65"] });
});

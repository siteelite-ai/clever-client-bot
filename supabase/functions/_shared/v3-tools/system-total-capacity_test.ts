import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  type SystemTotalCapacityRequirement,
  verifySystemTotalCapacityPlan,
} from "./system-total-capacity.ts";

const fluxRequirement: SystemTotalCapacityRequirement = {
  measurementScope: "system_total",
  outputFacet: { key: "flux", caption: "Световой поток, лм", unit: "лм" },
  unit: "лм",
  minimumTotal: 1800,
  minimumUnits: 2,
  aggregationProof: "verified_additive_plan",
};

function fluxProduct(id: string, value: string) {
  return {
    id,
    facet_values: { flux: [value] },
    short_traits: [`Световой поток: ${value} лм`],
  };
}

Deno.test("a visible two-SKU plan proves its summed output from live cards", () => {
  const result = verifySystemTotalCapacityPlan(fluxRequirement, [
    {
      product: fluxProduct("A", "1 000"),
      quantity: 1,
      quantitySource: "visible_plan",
    },
    {
      product: fluxProduct("B", "800"),
      quantity: 1,
      quantitySource: "visible_plan",
    },
  ]);
  assertEquals(result.status, "sufficient");
  assertEquals(result.canClaimSufficient, true);
  assertEquals(result.disposition, "present_verified_system");
  assertEquals(result.totalUnits, 2);
  assertEquals(result.totalCapacity, 1800);
  assertEquals(result.verifiedLines.map(({ subtotal }) => subtotal), [
    1000,
    800,
  ]);
  assertEquals(result.issues, []);
});

Deno.test("one SKU with an explicit count is a system plan, not one card's output", () => {
  const result = verifySystemTotalCapacityPlan(fluxRequirement, [{
    product: fluxProduct("A", "1 000"),
    quantity: 2,
    quantitySource: "customer_explicit",
  }]);
  assertEquals(result.status, "sufficient");
  assertEquals(result.totalUnits, 2);
  assertEquals(result.totalCapacity, 2000);
});

Deno.test("individual candidate cards cannot masquerade as a sufficient system", () => {
  const noCount = verifySystemTotalCapacityPlan(fluxRequirement, [{
    product: fluxProduct("A", "1 800"),
    quantity: null,
    quantitySource: "unverified",
  }]);
  assertEquals(noCount.status, "unverified");
  assertEquals(noCount.canClaimSufficient, false);
  assertEquals(noCount.disposition, "clarify_or_disclose_unverified");
  assertEquals(noCount.totalCapacity, null);
  assertEquals(noCount.issues, [{ code: "missing_quantity", productId: "A" }]);

  const invisibleCount = verifySystemTotalCapacityPlan(fluxRequirement, [{
    product: fluxProduct("A", "1 800"),
    quantity: 2,
    quantitySource: "unverified",
  }]);
  assertEquals(invisibleCount.status, "unverified");
  assertEquals(invisibleCount.issues, [{
    code: "unverified_quantity",
    productId: "A",
  }]);

  const oneUnit = verifySystemTotalCapacityPlan(fluxRequirement, [{
    product: fluxProduct("A", "2 000"),
    quantity: 1,
    quantitySource: "visible_plan",
  }]);
  assertEquals(oneUnit.status, "insufficient");
  assertEquals(oneUnit.issues, [{ code: "insufficient_units" }]);
});

Deno.test("fully evidenced but undersized plans are honestly insufficient", () => {
  const result = verifySystemTotalCapacityPlan(fluxRequirement, [{
    product: fluxProduct("A", "800"),
    quantity: 2,
    quantitySource: "visible_plan",
  }]);
  assertEquals(result.status, "insufficient");
  assertEquals(result.totalCapacity, 1600);
  assertEquals(result.canClaimSufficient, false);
  assertEquals(result.disposition, "disclose_insufficient_plan");
  assertEquals(result.issues, [{ code: "insufficient_capacity" }]);
});

Deno.test("strict and inclusive system thresholds remain distinct", () => {
  const plan = [{
    product: fluxProduct("A", "900"),
    quantity: 2,
    quantitySource: "visible_plan" as const,
  }];
  assertEquals(
    verifySystemTotalCapacityPlan(fluxRequirement, plan).status,
    "sufficient",
  );
  assertEquals(
    verifySystemTotalCapacityPlan(
      { ...fluxRequirement, strictMinimum: true },
      plan,
    )
      .status,
    "insufficient",
  );
});

Deno.test("missing, conflicting and non-scalar catalog outputs never prove a plan", () => {
  const missing = verifySystemTotalCapacityPlan(fluxRequirement, [{
    product: { id: "A", short_traits: [] },
    quantity: 2,
    quantitySource: "visible_plan",
  }]);
  assertEquals(missing.status, "unverified");
  assertEquals(missing.issues, [{ code: "missing_output", productId: "A" }]);

  const conflicting = verifySystemTotalCapacityPlan(fluxRequirement, [{
    product: {
      id: "A",
      facet_values: { flux: ["1000"] },
      short_traits: ["Световой поток: 800 лм"],
    },
    quantity: 2,
    quantitySource: "visible_plan",
  }]);
  assertEquals(conflicting.status, "unverified");
  assertEquals(conflicting.issues, [{
    code: "ambiguous_output",
    productId: "A",
  }]);

  const range = verifySystemTotalCapacityPlan(fluxRequirement, [{
    product: { id: "A", facet_values: { flux: ["800–1000 лм"] } },
    quantity: 2,
    quantitySource: "visible_plan",
  }]);
  assertEquals(range.status, "unverified");
  assertEquals(range.issues, [{ code: "ambiguous_output", productId: "A" }]);
});

Deno.test("capacity proof requires matching units and an authorized additive system", () => {
  const wrongUnit = verifySystemTotalCapacityPlan(fluxRequirement, [{
    product: { id: "A", facet_values: { flux: ["1800 Вт"] } },
    quantity: 2,
    quantitySource: "visible_plan",
  }]);
  assertEquals(wrongUnit.status, "unverified");
  assertEquals(wrongUnit.canClaimSufficient, false);
  assertEquals(wrongUnit.issues, [{ code: "unit_mismatch", productId: "A" }]);

  const noAdditivity = verifySystemTotalCapacityPlan(
    { ...fluxRequirement, aggregationProof: undefined },
    [{
      product: fluxProduct("A", "1000"),
      quantity: 2,
      quantitySource: "visible_plan",
    }],
  );
  assertEquals(noAdditivity.status, "unverified");
  assertEquals(noAdditivity.issues, [{ code: "missing_additivity_proof" }]);
});

Deno.test("a same-card explicit trait unit can qualify a unitless live facet value", () => {
  const requirement = {
    ...fluxRequirement,
    outputFacet: { key: "flux", caption: "Световой поток", unit: null },
  };
  const evidenced = verifySystemTotalCapacityPlan(requirement, [{
    product: {
      id: "A",
      facet_values: { flux: ["1000"] },
      short_traits: ["Световой поток: 1000 лм"],
    },
    quantity: 2,
    quantitySource: "visible_plan",
  }]);
  assertEquals(evidenced.status, "sufficient");
  assertEquals(evidenced.totalCapacity, 2000);

  const unitless = verifySystemTotalCapacityPlan(requirement, [{
    product: { id: "A", facet_values: { flux: ["1000"] } },
    quantity: 2,
    quantitySource: "visible_plan",
  }]);
  assertEquals(unitless.status, "unverified");
  assertEquals(unitless.issues, [{ code: "ambiguous_output", productId: "A" }]);
});

Deno.test("the contract is unit- and category-neutral", () => {
  const result = verifySystemTotalCapacityPlan({
    measurementScope: "system_total",
    outputFacet: {
      key: "throughput",
      caption: "Производительность, кг",
      unit: "кг",
    },
    unit: "кг",
    minimumTotal: 35,
    aggregationProof: "verified_additive_plan",
  }, [{
    product: {
      id: "machine",
      short_traits: ["Производительность: 12 кг"],
    },
    quantity: 3,
    quantitySource: "visible_plan",
  }]);
  assertEquals(result.status, "sufficient");
  assertEquals(result.unit, "кг");
  assertEquals(result.totalCapacity, 36);
});

Deno.test("duplicate SKUs and invalid counts cannot inflate capacity", () => {
  const duplicate = verifySystemTotalCapacityPlan(fluxRequirement, [
    {
      product: fluxProduct("A", "1000"),
      quantity: 1,
      quantitySource: "visible_plan",
    },
    {
      product: fluxProduct("A", "1000"),
      quantity: 1,
      quantitySource: "visible_plan",
    },
  ]);
  assertEquals(duplicate.status, "unverified");
  assertEquals(duplicate.issues, [{
    code: "duplicate_product",
    productId: "A",
  }]);

  const fractional = verifySystemTotalCapacityPlan(fluxRequirement, [{
    product: fluxProduct("A", "1000"),
    quantity: 1.5,
    quantitySource: "visible_plan",
  }]);
  assertEquals(fractional.status, "unverified");
  assertEquals(fractional.issues, [{
    code: "invalid_quantity",
    productId: "A",
  }]);
});

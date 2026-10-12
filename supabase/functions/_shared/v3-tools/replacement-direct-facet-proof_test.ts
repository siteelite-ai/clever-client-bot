import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  directReplacementEmptyOutcome,
  productProvesDirectReplacementAxes,
} from "./replacement-direct-facet-proof.ts";

const axes = [
  { key: "diameter", value: "90" },
  { key: "voltage", value: "220" },
];

Deno.test("direct replacement accepts exact live facets even when the title has no axis values", () => {
  assertEquals(productProvesDirectReplacementAxes({
    price: 900,
    facet_values: { diameter: ["90"], voltage: ["220"] },
  }, axes, 1000), true);
  const facetOnlyTechnicalCode = {
    pagetitle: "Автомат стандартной серии",
    price: 850,
    facet_values: { pole_code: ["1P"], rated_current: ["16"] },
  };
  assertEquals(productProvesDirectReplacementAxes(facetOnlyTechnicalCode, [
    { key: "pole_code", value: "1P" },
    { key: "rated_current", value: "16" },
  ], 1000), true);
});

Deno.test("a title numeral or an unrelated facet never rescues a contradictory diameter", () => {
  const misleadingTitle = {
    pagetitle: "Светильник 90V, диаметр 75 мм",
    price: 900,
    facet_values: { diameter: ["75"], voltage: ["220"], title_voltage: ["90V"] },
  };
  assertEquals(productProvesDirectReplacementAxes(misleadingTitle, axes, 1000), false);
  assertEquals(productProvesDirectReplacementAxes({
    price: 900,
    facet_values: { diameter: ["75", "90"], voltage: ["220"] },
  }, axes, 1000), false);
});

Deno.test("direct replacement fails closed on missing facet or price above cap", () => {
  assertEquals(productProvesDirectReplacementAxes({
    price: 900,
    facet_values: { voltage: ["220"] },
  }, axes, 1000), false);
  assertEquals(productProvesDirectReplacementAxes({
    price: 1001,
    facet_values: { diameter: ["90"], voltage: ["220"] },
  }, axes, 1000), false);
});

Deno.test("only inconsequential text formatting and decimal separators normalize", () => {
  assertEquals(productProvesDirectReplacementAxes({
    price: 900,
    facet_values: { size: ["  4.5  кА  "] },
  }, [{ key: "size", value: "4,5 кА" }], 1000), true);
  assertEquals(productProvesDirectReplacementAxes({
    price: 900,
    facet_values: { size: ["4.5 В"] },
  }, [{ key: "size", value: "4,5 кА" }], 1000), false);
});

Deno.test("raw strict matches with missing or contradictory facets are unverified, not empty", () => {
  const missing = { price: 900, facet_values: { voltage: ["220"] } };
  const contradictory = {
    price: 900,
    facet_values: { diameter: ["75"], voltage: ["220"] },
  };
  for (const product of [missing, contradictory]) {
    assertEquals(productProvesDirectReplacementAxes(product, axes, 1000), false);
    assertEquals(directReplacementEmptyOutcome({
      strictTotal: 1,
      splitTotals: [1, 1],
      unverifiedFacetCount: 1,
    }), "query_inconsistent");
  }
});

Deno.test("only genuinely zero search pools may be confirmed empty", () => {
  assertEquals(directReplacementEmptyOutcome({
    strictTotal: 0,
    splitTotals: [0, 0],
    broadTotal: 0,
    unverifiedFacetCount: 0,
  }), "confirmed_empty");
  assertEquals(directReplacementEmptyOutcome({
    strictTotal: 0,
    splitTotals: [0, null],
    unverifiedFacetCount: 0,
  }), "query_inconsistent");
});

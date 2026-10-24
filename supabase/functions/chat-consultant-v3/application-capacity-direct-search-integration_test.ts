// Offline contract integration: customer application threshold -> live facet
// options -> ordinary search guard -> certified direct-search recovery ->
// per-card gate. No model or catalog network request is made.
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  certifiedCustomerApplicationCapacityOptions,
  filterPerProductMeasuredCriteria,
  preserveCertifiedCustomerCapacityOptions,
  projectLiteralMeasuredCriteria,
} from "../_shared/v3-tools/criteria-reasoning.ts";
import {
  applyCriteriaGate,
  projectCriteriaFacetOptions,
} from "../_shared/v3-tools/criteria-gate.ts";
import { guardSearchFilters } from "../_shared/v3-tools/search-filter-guard.ts";

Deno.test("direct search preserves only catalog tiers certified by a 27 m² customer room", () => {
  const customer = "Хочу поменять люстру в комнате 27 м²";
  const facet = {
    key: "max_lighting_area",
    caption: "Максимальная площадь освещения, м²",
    type: "number",
    unit: "м²",
    values: [{ value: "25" }, { value: "30" }, { value: "35" }],
  };
  const direct = projectLiteralMeasuredCriteria(
    [],
    customer,
    customer,
    [facet],
  ).matched.map((criterion) => ({
    ...criterion,
    evidence: "user_explicit" as const,
  }));
  const scoped = filterPerProductMeasuredCriteria(
    direct,
    customer,
    customer,
    "per_product",
    [facet],
  ).criteria;
  assertEquals(scoped.length, 1);
  assertEquals(scoped[0].op, "min");
  assertEquals(String(scoped[0].value), "27");

  const proposed = projectCriteriaFacetOptions(scoped, [facet]).options;
  assertEquals(proposed, { max_lighting_area: ["30", "35"] });
  // This is the production `scopeLiveFacetOptions` certificate input before
  // the generic guard reinterprets catalog tiers as customer equalities.
  assertEquals(
    certifiedCustomerApplicationCapacityOptions(scoped, customer, [facet]),
    proposed,
  );
  const guarded = guardSearchFilters(
    { mode: "by_filter", options: proposed },
    [facet],
    "Проверяю варианты для вашей комнаты.",
    customer,
    "Проверяю варианты для вашей комнаты.",
    [],
    {
      allowProseOnlyFacetInference: false,
      // Do not lend the generic guard catalog tiers it may not have in its
      // own authority list. The server certificate must survive even when
      // this guard drops the options before the direct search executes.
      authoritativeFacetValues: [],
    },
  );
  assertEquals(guarded.args.options ?? {}, {});
  const safeSearchOptions = preserveCertifiedCustomerCapacityOptions(
    scoped,
    customer,
    [facet],
    proposed,
    (guarded.args.options ?? {}) as Record<string, string[]>,
  );
  assertEquals(safeSearchOptions, { max_lighting_area: ["30", "35"] });

  // The search may return a wrong or incomplete card. Live option tiers are
  // retrieval candidates, not a substitute for per-card capacity evidence.
  const cards = [25, 30, 35].map((area) => ({
    id: String(area),
    pagetitle: `Светильник ${area}`,
    vendor: null,
    price: 1000,
    stock: "in_stock" as const,
    short_traits: [`${facet.caption}: ${area}`],
  }));
  const unknown = {
    id: "unknown",
    pagetitle: "Светильник без подтверждённой площади",
    vendor: null,
    price: 1000,
    stock: "in_stock" as const,
    short_traits: [] as string[],
  };
  assertEquals(
    applyCriteriaGate([...cards, unknown], scoped).passed_ids,
    ["30", "35"],
  );
  assertEquals(
    certifiedCustomerApplicationCapacityOptions(
      [{ ...scoped[0], op: "eq", value: "35", evidence: "model_assumption" }],
      customer,
      [facet],
    ),
    {},
  );
  assertEquals(
    preserveCertifiedCustomerCapacityOptions(
      scoped,
      customer,
      [facet],
      { max_lighting_area: ["25", "30", "35", "45"] },
      {},
    ),
    { max_lighting_area: ["30", "35"] },
  );
});

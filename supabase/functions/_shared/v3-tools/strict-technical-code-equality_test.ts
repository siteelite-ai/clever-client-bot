import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import {
  applyCriteriaGate,
  checkCriterion,
  type CriteriaFacet,
  criteriaProvenByExecutedFacetOptions,
  type Criterion,
  projectCriteriaFacetOptions,
} from "./criteria-gate.ts";
import type { ProductRef } from "./types.ts";

const protection: Criterion = {
  key: "Степень защиты",
  op: "eq",
  value: "IP44",
  level: "A",
  evidence: "user_explicit",
};

function product(
  id: string,
  trait: string | null,
  title = `Прибор ${id}`,
): ProductRef {
  return {
    id,
    pagetitle: title,
    vendor: null,
    price: 100,
    stock: "in_stock",
    short_traits: trait ? [`Степень защиты: ${trait}`] : [],
  };
}

const facets: CriteriaFacet[] = [{
  key: "protection",
  caption: "Степень защиты",
  unit: null,
  values: [
    { value: "IP44" },
    { value: "IP54" },
    { value: "IP44-IP20" },
    { value: "IP44 / IP54" },
    { value: "IP20" },
  ],
}];

Deno.test("named facet requires the whole atomic technical code, even with a unit", () => {
  const withUnit: Criterion = { ...protection, unit: "IP" };
  assertEquals(
    checkCriterion(product("exact", "IP44"), withUnit).verdict,
    "pass",
  );
  assertEquals(
    checkCriterion(product("spaced", "IР 44"), withUnit).verdict,
    "pass",
  );
  assertEquals(
    checkCriterion(product("compound", "IP44-IP20"), withUnit).verdict,
    "fail",
  );
  assertEquals(
    checkCriterion(product("slash", "IP44 / IP20"), withUnit).verdict,
    "fail",
  );
  assertEquals(
    checkCriterion(product("longer", "IP444"), withUnit).verdict,
    "fail",
  );
  assertEquals(
    checkCriterion(product("other", "IP54"), withUnit).verdict,
    "fail",
  );
});

Deno.test("atomic title fallback proves only a standalone code", () => {
  assertEquals(
    checkCriterion(product("title", null, "Прибор с корпусом IP44"), protection)
      .verdict,
    "pass",
  );
  for (
    const title of [
      "Прибор с корпусом IP44-IP20",
      "Прибор с корпусом IP44 / IP20",
      "Прибор с корпусом IP444",
    ]
  ) {
    assertEquals(
      checkCriterion(product("title", null, title), protection).verdict,
      "unknown",
    );
  }
});

Deno.test("descriptive equality and numeric/paired criteria retain their semantics", () => {
  assertEquals(
    checkCriterion(
      product("descriptive", "бытовые светильники"),
      { key: "Степень защиты", op: "eq", value: "бытовой", level: "A" },
    ).verdict,
    "pass",
  );
  assertEquals(
    checkCriterion(
      product("numeric", "20-25"),
      { key: "Степень защиты", op: "eq", value: "25", level: "A" },
    ).verdict,
    "pass",
  );
  assertEquals(
    checkCriterion(
      product("paired", "2x1.5"),
      { key: "Степень защиты", op: "eq", value: "2x1.5", level: "A" },
    ).verdict,
    "pass",
  );
  assertEquals(
    checkCriterion(
      product("measured", "20 Вт"),
      {
        key: "Степень защиты",
        op: "eq",
        value: "20W",
        unit: "Вт",
        level: "A",
      },
    ).verdict,
    "pass",
  );
});

Deno.test("card gate rejects compound protection values but keeps exact OR alternatives", () => {
  const alternatives: Criterion[] = [protection, {
    ...protection,
    value: "IP54",
  }];
  const candidates = [
    product("44", "IP44"),
    product("54", "IP54"),
    product("compound", "IP44-IP20"),
    product("title", null, "Прибор IP44"),
    product("ambiguous-title", null, "Прибор IP44/IP20"),
  ];
  assertEquals(applyCriteriaGate(candidates, alternatives).passed_ids, [
    "44",
    "54",
    "title",
  ]);
});

Deno.test("live facet projection retains only exact technical code alternatives", () => {
  const alternatives: Criterion[] = [protection, {
    ...protection,
    value: "IP54",
  }];
  const projected = projectCriteriaFacetOptions(alternatives, facets);
  assertEquals(projected.options, { protection: ["IP44", "IP54"] });
  assertEquals(projected.proven_criteria, alternatives);
  assertEquals(projected.unmatched_keys, []);
});

Deno.test("executed facet proof excludes a compound value", () => {
  const alternatives: Criterion[] = [protection, {
    ...protection,
    value: "IP54",
  }];
  assertEquals(
    criteriaProvenByExecutedFacetOptions(
      alternatives,
      { protection: ["IP44", "IP54"] },
      facets,
    ),
    alternatives,
  );
  assertEquals(
    criteriaProvenByExecutedFacetOptions(
      alternatives,
      { protection: ["IP44-IP20"] },
      facets,
    ),
    [],
  );
  assertEquals(
    criteriaProvenByExecutedFacetOptions(
      [protection],
      { protection: ["IP44-IP20"] },
      facets,
    ),
    [],
  );
});

import {
  assert,
  assertEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  compileSemanticCompoundFacetPlan,
  productProvesSemanticCompoundFacets,
} from "./semantic-compound-facet-proof.ts";
import type { ProductFull } from "./types.ts";

const leaf = "Прокладки уплотнительные";
const request = "резиновая прокладка термостойкая";
const marking = { first: 3, second: 2.5 };
const row: ProductFull = {
  id: "fixture",
  url: "https://220volt.kz/catalog/fixture/gasket/",
  pagetitle: "Прокладка 3×2,5 K-5",
  vendor: null,
  price: 20,
  stock: "in_stock",
  warehouses: [{ city: "Астана", qty: 7 }],
  leaf_category: leaf,
  short_traits: [],
  facet_values: { material: ["резина"], heat: ["Да"] },
  facet_captions: { material: "Материал", heat: "Термостойкость" },
};

Deno.test("same proof path handles a different product class, size and descriptors", () => {
  const plan = compileSemanticCompoundFacetPlan(request, leaf, [row]);
  assert(plan);
  assertEquals(plan.fields, [
    { key: "material", caption: "Материал", value: "резина" },
    { key: "heat", caption: "Термостойкость", value: "Да" },
  ]);
  assert(productProvesSemanticCompoundFacets(row, plan, marking));
  for (
    const unproved of [
      { ...row, pagetitle: "Прокладка 3×2,6 K-5" },
      { ...row, pagetitle: "Кольцо 3×2,5 K-5" },
      { ...row, leaf_category: "Кольца" },
      { ...row, warehouses: [] },
      { ...row, facet_values: { material: ["резина"] } },
      { ...row, facet_values: { material: ["резина"], heat: ["Да", "Нет"] } },
      {
        ...row,
        facet_captions: { material: "Материал", heat: "Маслостойкость" },
      },
    ]
  ) assert(!productProvesSemanticCompoundFacets(unproved, plan, marking));
});

Deno.test("unknown qualifiers, short codes and ambiguous live axes cannot disappear", () => {
  for (
    const q of [
      `${request} маслостойкая`,
      `${request} FR`,
      `${request} или пластиковая`,
      `не ${request}`,
      `${request} для улицы`,
    ]
  ) assertEquals(compileSemanticCompoundFacetPlan(q, leaf, [row]), null, q);
  assertEquals(
    compileSemanticCompoundFacetPlan(request, leaf, [{
      ...row,
      facet_captions: {
        ...row.facet_captions,
        another_material: "Материал оболочки",
      },
      facet_values: { ...row.facet_values, another_material: ["резина"] },
    }]),
    null,
  );
  assertEquals(
    compileSemanticCompoundFacetPlan(request, leaf, [
      row,
      {
        ...row,
        facet_captions: { ...row.facet_captions, heat: "Маслостойкость" },
      },
    ]),
    null,
  );
});

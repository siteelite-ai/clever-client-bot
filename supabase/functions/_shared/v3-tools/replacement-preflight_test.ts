import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { extractReplacementLookupKeys, productContainsSourceModel, selectExplicitAnchorAxes } from "./replacement-preflight.ts";
import type { ProductRef } from "./types.ts";

const anchor: ProductRef = {
  id: "anchor",
  pagetitle: "Светильник DN027B G2 LED6/NW 7W 220-240V D90 R",
  vendor: "Philips",
  price: 1000,
  stock: "in_stock",
  short_traits: [
    "Бренд: Philips",
    "Мощность ламп, Вт: 7",
    "Напряжение, В: 220-240",
    "Диаметр, см: 9",
    "Цвет свечения: нейтральный",
  ],
};

Deno.test("replacement preflight extracts article and source model without measurement tokens", () => {
  assertEquals(extractReplacementLookupKeys(
    "предложи аналоги DN027B G2 LED6/NW 7W 220-240V; 929002070102/871869967897500",
  ), {
    articles: ["929002070102", "871869967897500"],
    modelCodes: ["DN027B", "LED6NW"],
  });
});

Deno.test("replacement preflight selects only explicit live non-identity facets", () => {
  const axes = selectExplicitAnchorAxes(anchor, [
    { key: "brand", caption: "Бренд", type: "string", unit: null, values: [{ value: "Philips", products_count: 20 }] },
    { key: "power", caption: "Мощность ламп, Вт", type: "number", unit: "Вт", values: [{ value: "7", products_count: 30 }] },
    { key: "voltage", caption: "Напряжение, В", type: "string", unit: "В", values: [{ value: "220-240", products_count: 500 }] },
    { key: "diameter", caption: "Диаметр, см", type: "number", unit: "см", values: [{ value: "9", products_count: 2 }] },
    { key: "color", caption: "Цвет свечения", type: "string", unit: null, values: [{ value: "нейтральный", products_count: 40 }] },
  ], "аналоги на DN027B 7W 220-240V");

  assertEquals(axes, [
    { key: "power", caption: "Мощность ламп, Вт", value: "7", total: 30 },
    { key: "voltage", caption: "Напряжение, В", value: "220-240", total: 500 },
  ]);
});

Deno.test("source model exclusion is structural", () => {
  assertEquals(productContainsSourceModel(anchor, ["DN027B"]), true);
  assertEquals(productContainsSourceModel({ pagetitle: "Светильник BN068C LED6/NW" }, ["DN027B"]), false);
});

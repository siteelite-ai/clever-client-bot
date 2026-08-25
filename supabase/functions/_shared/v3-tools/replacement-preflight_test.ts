import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { extractExplicitSingleLetterCodes, extractReplacementLookupKeys, productContainsSourceModel, selectExplicitAnchorAxes } from "./replacement-preflight.ts";
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

Deno.test("replacement preflight recognizes a spaced letter-number model code", () => {
  const lookup = extractReplacementLookupKeys(
    "Модель АБ 47-29 16 А 4,5 кА — предложи равноценную замену",
  );
  assertEquals(lookup.modelCodes.includes("АБ47-29"), true);
  assertEquals(lookup.modelCodes.some((value) => /16|4,?5/u.test(value)), false);
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

Deno.test("bare binary merchandising values do not become replacement axes", () => {
  const axes = selectExplicitAnchorAxes(
    {
      id: "anchor",
      pagetitle: "Устройство QX-20 1P 16A",
      vendor: "Vendor",
      price: 500,
      stock: "in_stock",
      short_traits: ["Количество полюсов: 1", "Популярный: 1", "Номинальный ток: 16"],
    },
    [
      { key: "poles", caption: "Количество полюсов", type: "string", unit: null, values: [{ value: "1", products_count: 5 }] },
      { key: "popular", caption: "Популярный", type: "string", unit: null, values: [{ value: "1", products_count: 100 }] },
      { key: "current", caption: "Номинальный ток", type: "number", unit: "А", values: [{ value: "16", products_count: 8 }] },
    ],
    "Нужен аналог QX-20: 1 полюс, 16 А",
    6,
  );
  assertEquals(axes.map((axis) => axis.key).sort(), ["current", "poles"]);
});

Deno.test("an explicit one-letter characteristic is a replacement axis only with caption evidence", () => {
  const product = {
    id: "anchor",
    pagetitle: "Устройство QX-20 16A х-ка C",
    vendor: "Vendor",
    price: 500,
    stock: "in_stock" as const,
    short_traits: ["Характеристика срабатывания: Тип C", "Цвет: C"],
  };
  const facets = [
    { key: "curve", caption: "Характеристика срабатывания", type: "string", unit: null, values: [{ value: "Тип C", products_count: 5 }] },
    { key: "color", caption: "Цвет", type: "string", unit: null, values: [{ value: "C", products_count: 5 }] },
  ];
  const axes = selectExplicitAnchorAxes(product, facets, "Нужна характеристика C", 6);
  assertEquals(axes.map((axis) => axis.key), ["curve"]);
});

Deno.test("standalone code after a parameter label becomes visible replacement evidence", () => {
  assertEquals(
    extractExplicitSingleLetterCodes("16 А, характеристика C, серия GENERICA ИЭК"),
    ["c"],
  );
  assertEquals(extractExplicitSingleLetterCodes("бренд CHINT"), []);
});

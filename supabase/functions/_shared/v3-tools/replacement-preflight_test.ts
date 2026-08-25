import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  excludeMandatoryAxisCodesFromSourceModels, extractExplicitSingleLetterCodes, extractReplacementLookupKeys,
  extractPortableTechnicalRequirements,
  portableTechnicalCodeMatchesText, productContainsSourceModel,
  productTitleSupportsMandatoryAxes,
  productTitleSupportsPortableRequirements, selectExplicitAnchorAxes } from "./replacement-preflight.ts";
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

Deno.test("portable replacement requirements do not fuse adjacent measurements", () => {
  assertEquals(
    extractPortableTechnicalRequirements(
      "Автомат 1Р ВА 47-29 16 А 4,5кА характеристика С до 1000 тг",
    ),
    ["1Р", "16А", "4.5кА"],
  );
  assertEquals(
    extractPortableTechnicalRequirements("Замена лампы GX53 12Вт 220В"),
    ["12Вт", "220В", "GX53"],
  );
});

Deno.test("explicit live technical codes become mandatory replacement axes", () => {
  const product: ProductRef = {
    id: "anchor",
    pagetitle: "Лампа ECO T75 таблетка GX53 10Вт",
    vendor: "Vendor",
    price: 900,
    stock: "in_stock",
    short_traits: ["Тип цоколя: GX53", "Форма колбы: T75", "Мощность: 10"],
  };
  const axes = selectExplicitAnchorAxes(product, [
    {
      key: "socket",
      caption: "Тип цоколя",
      type: "string",
      unit: null,
      values: [{ value: "GX53", products_count: 30 }],
    },
    {
      key: "shape",
      caption: "Форма колбы",
      type: "string",
      unit: null,
      values: [{ value: "T75", products_count: 4 }],
    },
    {
      key: "power",
      caption: "Мощность",
      type: "number",
      unit: "Вт",
      values: [{ value: "10", products_count: 2 }],
    },
  ], "Подбери аналоги для лампы ECO T75 таблетка GX53");

  assertEquals(axes, [
    {
      key: "shape",
      caption: "Форма колбы",
      value: "T75",
      total: 4,
      mandatory: true,
    },
    {
      key: "socket",
      caption: "Тип цоколя",
      value: "GX53",
      total: 30,
      mandatory: true,
    },
    { key: "power", caption: "Мощность", value: "10", total: 2 },
  ]);
});

Deno.test("portable technical codes compare as whole codes, not by their digits", () => {
  assertEquals(
    portableTechnicalCodeMatchesText("GX53", "Лампа NLL-GX53-13-230"),
    true,
  );
  assertEquals(
    portableTechnicalCodeMatchesText(
      "GX53",
      "Лампа NLL-GX70-13-230; поток 1053 лм",
    ),
    false,
  );
  assertEquals(portableTechnicalCodeMatchesText("IP 44", "защита IP44"), true);
  assertEquals(portableTechnicalCodeMatchesText("C16", "автомат С16"), true);
  assertEquals(portableTechnicalCodeMatchesText("100W", "светильник 100Вт"), true);
  assertEquals(portableTechnicalCodeMatchesText("220V", "напряжение 220В"), true);
});

Deno.test("near replacement cannot relax a mandatory title code", () => {
  const axes = [
    {
      key: "socket",
      caption: "Тип цоколя",
      value: "GX53",
      total: 30,
      mandatory: true as const,
    },
    { key: "power", caption: "Мощность", value: "12", total: 8 },
  ];
  assertEquals(
    productTitleSupportsMandatoryAxes("Лампа NLL-GX53-12-230", axes),
    true,
  );
  assertEquals(
    productTitleSupportsMandatoryAxes(
      "Лампа NLL-GX70-12-230; поток 1053 лм",
      axes,
    ),
    false,
  );
});

Deno.test("a live compatibility code is not also a source-model exclusion", () => {
  const axes = [
    {
      key: "socket",
      caption: "Тип цоколя",
      value: "GX53",
      total: 30,
      mandatory: true as const,
    },
    { key: "power", caption: "Мощность", value: "12", total: 8 },
  ];
  assertEquals(
    excludeMandatoryAxisCodesFromSourceModels(["GX53", "DN027B"], axes),
    ["DN027B"],
  );
});

Deno.test("final replacement title contract requires every portable code", () => {
  const requirements = ["1P", "16A", "C"];
  assertEquals(
    productTitleSupportsPortableRequirements(
      "Автоматический выключатель M06N 1P 16A C ARMAT ИЭК",
      ["1Р", "16А", "С"],
    ),
    true,
  );
  assertEquals(
    productTitleSupportsPortableRequirements(
      "Авт.выкл-ль iC60N 3П 16А С /A9F79316/",
      requirements,
    ),
    false,
  );
  assertEquals(
    productTitleSupportsPortableRequirements(
      "Авт.выкл-ль iC60N 1П 32А С /A9F79132/",
      requirements,
    ),
    false,
  );
});

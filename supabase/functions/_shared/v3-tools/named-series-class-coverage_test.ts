import {
  assertEquals,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  appendNamedSeriesClassCoverage,
  extractRequestedNamedSeriesClasses,
  namedSeriesClassCoverage,
  productProvesNamedSeriesClass,
  resolveRequestedNamedSeriesClasses,
  shouldSearchNextNamedSeriesClassPage,
  stratifyNamedSeriesProducts,
} from "./named-series-class-coverage.ts";
import type { ProductFull } from "./types.ts";

function product(id: string, title: string, leaf: string | null): ProductFull {
  return {
    id,
    pagetitle: title,
    leaf_category: leaf,
    vendor: "Vendor",
    price: 100,
    stock: "in_stock",
    url: `https://220volt.kz/catalog/test/items/${id}/`,
    short_traits: [],
  };
}

Deno.test("named-series class list comes from the customer's bare nouns, not a brand dictionary", () => {
  assertEquals(
    extractRequestedNamedSeriesClasses(
      "Расскажи, чем хороша серия Галант по розеткам и выключателям?",
    ),
    ["розеткам", "выключателям"],
  );
  assertEquals(
    extractRequestedNamedSeriesClasses(
      "Расскажи о серии Nova по лампам и светильникам",
    ),
    ["лампам", "светильникам"],
  );
  assertEquals(
    extractRequestedNamedSeriesClasses(
      "Расскажи о серии Gallant по розеткам",
    ),
    ["розеткам"],
  );
  assertEquals(
    extractRequestedNamedSeriesClasses(
      "Покажи серию Gallant до 5000 тенге и только в Алматы",
    ),
    [],
  );
  assertEquals(
    extractRequestedNamedSeriesClasses(
      "Расскажи о серии Nova по лампам и светильникам с датчиком движения",
    ),
    [],
  );
  assertEquals(
    extractRequestedNamedSeriesClasses(
      "Расскажи о серии Gallant по белым розеткам",
    ),
    [],
  );
  assertEquals(
    extractRequestedNamedSeriesClasses(
      "Расскажи о серии Gallant по розеткам с USB",
    ),
    [],
  );
  assertEquals(
    extractRequestedNamedSeriesClasses(
      "Расскажи о серии Gallant с рамкой для розеток",
    ),
    [],
  );
  assertEquals(
    resolveRequestedNamedSeriesClasses(
      "Покажи товары этой серии.",
      [
        { role: "user", content: "Расскажи, чем хороша серия Галант по розеткам и выключателям?" },
        { role: "assistant", content: "Серия Gallant представлена розетками и выключателями." },
      ],
      "галант",
    ),
    ["розеткам", "выключателям"],
  );
  assertEquals(
    resolveRequestedNamedSeriesClasses(
      "Покажи товары этой серии.",
      [
        { role: "user", content: "Расскажи о серии Галант по розеткам и выключателям?" },
        { role: "user", content: "Расскажи о серии Nova по лампам и светильникам?" },
      ],
      "галант",
    ),
    [],
  );
  assertEquals(
    resolveRequestedNamedSeriesClasses(
      "Покажи товары этой серии.",
      [{ role: "user", content: "Расскажи о серии Gallant по розеткам" }],
      "gallant",
    ),
    ["розеткам"],
  );
});

Deno.test("series coverage requires independent live product-class proof", () => {
  const socket = product("socket", "Розетка Gallant двойная", "Розетки");
  const switchProduct = product("switch", "Выключатель Gallant", "Выключатели");
  const frame = product("frame", "Рамка для выключателя Gallant", "Рамки");
  const unclassified = product("unclassified", "Выключатель Gallant", null);
  assertEquals(productProvesNamedSeriesClass(socket, "розеткам"), true);
  assertEquals(productProvesNamedSeriesClass(switchProduct, "выключателям"), true);
  assertEquals(productProvesNamedSeriesClass(frame, "выключателям"), false);
  assertEquals(productProvesNamedSeriesClass(unclassified, "выключателям"), true);
  assertEquals(productProvesNamedSeriesClass(unclassified, "выключателям", true), false);
  assertEquals(
    namedSeriesClassCoverage(["выключателям"], [unclassified])[0].products,
    [],
  );
});

Deno.test("series selection shows each requested class before filling one class", () => {
  const products = [
    product("s1", "Розетка Gallant 1", "Розетки"),
    product("s2", "Розетка Gallant 2", "Розетки"),
    product("s3", "Розетка Gallant 3", "Розетки"),
    product("w1", "Выключатель Gallant 1", "Выключатели"),
    product("w2", "Выключатель Gallant 2", "Выключатели"),
    product("f1", "Рамка Gallant", "Рамки"),
  ];
  const coverage = namedSeriesClassCoverage(
    ["розеткам", "выключателям"],
    products,
  );
  assertEquals(coverage.map((group) => group.label), ["Розетки", "Выключатели"]);
  assertEquals(
    stratifyNamedSeriesProducts(coverage, 4).map((item) => item.id),
    ["s1", "w1", "s2", "w2"],
  );
  assertEquals(
    appendNamedSeriesClassCoverage("В серии есть розетки.", coverage, true),
    "В серии есть розетки.\n\nВ этой серии также подтверждены товары раздела «Выключатели».",
  );
});

Deno.test("missing requested series class is disclosed without unrelated product cards", () => {
  const coverage = namedSeriesClassCoverage(
    ["розеткам", "выключателям"],
    [product("s1", "Розетка Gallant", "Розетки")],
  );
  const text = appendNamedSeriesClassCoverage("Розетки представлены.", coverage, false);
  assertStringIncludes(text, "«выключателям»");
  assertStringIncludes(text, "в проверенной части каталога не нашёл");
});

Deno.test("single named-series class scans a bounded window past unrelated first-page classes", () => {
  const otherClasses = [
    product("frame", "Рамка для розетки Gallant", "Рамки"),
    product("switch", "Выключатель Gallant", "Выключатели"),
  ];
  const socket = product("socket", "Розетка Gallant", "Розетки");
  assertEquals(
    shouldSearchNextNamedSeriesClassPage(["розеткам"], otherClasses, 120, 50, 1),
    true,
  );
  assertEquals(
    shouldSearchNextNamedSeriesClassPage(["розеткам"], [...otherClasses, socket], 120, 50, 2),
    false,
  );
  assertEquals(
    stratifyNamedSeriesProducts(
      namedSeriesClassCoverage(["розеткам"], [...otherClasses, socket]),
      10,
    ).map((item) => item.id),
    ["socket"],
  );
  assertEquals(
    shouldSearchNextNamedSeriesClassPage(["розеткам"], otherClasses, 50, 50, 1),
    false,
  );
  assertEquals(
    shouldSearchNextNamedSeriesClassPage(["розеткам"], otherClasses, 200, 50, 3),
    false,
  );
  assertEquals(
    shouldSearchNextNamedSeriesClassPage([], otherClasses, 200, 50, 1),
    false,
  );
  assertEquals(
    shouldSearchNextNamedSeriesClassPage(["розеткам", "выключателям"], [socket], 120, 50, 1),
    true,
  );
});

Deno.test("single bare modifier has no class proof, unrelated cards, or catalog-wide absence claim", () => {
  const products = [
    product("socket", "Розетка Gallant", "Розетки"),
    product("frame", "Рамка Gallant", "Рамки"),
  ];
  for (const message of [
    "Расскажи о серии Gallant по скидкам",
    "Расскажи о серии Gallant по характеристикам",
  ]) {
    const candidates = extractRequestedNamedSeriesClasses(message);
    const coverage = namedSeriesClassCoverage(candidates, products);
    assertEquals(stratifyNamedSeriesProducts(coverage, 8), []);
    const text = appendNamedSeriesClassCoverage("", coverage, true);
    assertStringIncludes(text, "в проверенной части каталога");
    assertStringIncludes(text, "Уточните, какой тип товара");
    assertEquals(text.includes("в каталоге не нашёл"), false);
  }
});

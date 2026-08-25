import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  filterProductsByGroundedCategoryTargets,
  groundedCategoryRecoveryQueries,
  groundedTokenRecoveryQueries,
  guardCategoryScopeByReasoning,
  filterProductsByNamedSeries,
  rankGroundedCategoryRecoveryScopes,
  selectGroundedTokenRecoveryCandidate,
  titleContainsLiteralToken,
} from "./category-reasoning-guard.ts";

const discovered = {
  category: { pagetitle: "Светильники" },
  leaf_categories: [
    { pagetitle: "Уличные светильники" },
    { pagetitle: "Бытовые светильники накладные" },
  ],
};

Deno.test("category reasoning guard drops a real but unsupported sibling leaf", () => {
  const result = guardCategoryScopeByReasoning(
    { mode: "by_filter", category_in: ["Уличные светильники"], options: { mounting: ["Накладной"] } },
    discovered,
    "Подбираю бытовой накладной светильник для дома, внутри помещения.",
  );
  assertEquals(result.args, { mode: "by_filter", options: { mounting: ["Накладной"] } });
  assertEquals(result.dropped, [{ category: "Уличные светильники", reason: "not_declared_in_reasoning" }]);
});

Deno.test("category reasoning guard keeps a morphologically supported leaf", () => {
  const result = guardCategoryScopeByReasoning(
    { mode: "by_filter", category_in: ["Бытовые светильники накладные"] },
    discovered,
    "Нужен бытовой накладной светильник.",
  );
  assertEquals(result.args, { mode: "by_filter", category_in: ["Бытовые светильники накладные"] });
  assertEquals(result.kept, ["Бытовые светильники накладные"]);
  assertEquals(result.dropped, []);
});

Deno.test("category reasoning guard preserves supported leaves and removes unsupported ones", () => {
  const result = guardCategoryScopeByReasoning(
    { mode: "by_filter", category_in: ["Уличные светильники", "Бытовые светильники накладные"] },
    discovered,
    "Ищу бытовой накладной светильник.",
  );
  assertEquals(result.args, { mode: "by_filter", category: "Бытовые светильники накладные" });
});

Deno.test("category reasoning guard does not accept a wrong modifier through a shared feature", () => {
  const result = guardCategoryScopeByReasoning(
    { mode: "by_filter", category_in: ["Уличные светильники с датчиком движения"] },
    {
      category: { pagetitle: "Светильники" },
      leaf_categories: [{ pagetitle: "Уличные светильники с датчиком движения" }],
    },
    "Нужен светильник с датчиком движения для дома, внутри помещения.",
  );
  assertEquals(result.args, { mode: "by_filter", category: "Светильники" });
});

Deno.test("a rejected live branch cannot ground itself through a negative mention", () => {
  const discovered = {
    category: { pagetitle: "Базовые изделия" },
    leaf_categories: [{ pagetitle: "Наружные базовые изделия" }],
  };
  assertEquals(
    groundedCategoryRecoveryQueries(
      discovered,
      "Каталог вернул только наружные базовые изделия, но это не подходит. Нужен другой внутренний тип.",
    ),
    ["Базовые изделия"],
  );
  assertEquals(
    filterProductsByGroundedCategoryTargets(
      [{ pagetitle: "Наружное базовое изделие", leaf_category: "Наружные базовые изделия" }],
      ["Базовые изделия"],
      "Базовые изделия",
      "Ветка наружных изделий неверная, требуется другой тип.",
    ),
    [],
  );
  assertEquals(
    groundedCategoryRecoveryQueries(
      discovered,
      "В общей ветке базовых изделий есть наружные изделия, их нужно отсечь как лишние и взять внутренний тип.",
    ),
    ["Базовые изделия"],
  );
});

Deno.test("category reasoning guard keeps the live umbrella when dropping the only unsupported leaf", () => {
  const result = guardCategoryScopeByReasoning(
    { mode: "by_filter", category: "Уличные светильники" },
    discovered,
    "Нужно светодиодное освещение внутри жилой комнаты.",
  );
  assertEquals(result.args, { mode: "by_filter", category: "Светильники" });
  assertEquals(result.dropped, [{ category: "Уличные светильники", reason: "not_declared_in_reasoning" }]);
});

Deno.test("terminal category retry uses only leaves grounded in the reasoning", () => {
  const queries = groundedCategoryRecoveryQueries({
    category: { pagetitle: "Светотехника" },
    leaf_categories: [
      { pagetitle: "Люстры" },
      { pagetitle: "Уличные светильники" },
    ],
  }, "Ищу современную люстру для зала.");
  assertEquals(queries, ["Люстры"]);
});

Deno.test("terminal category target removes sibling product classes", () => {
  const products = filterProductsByGroundedCategoryTargets([
    { pagetitle: "Светильник потолочный LED 60W", leaf_category: "Потолочные светильники" },
    { pagetitle: "Прожектор светодиодный IP65", leaf_category: "Прожекторы" },
    { pagetitle: "Лампа светодиодная E27", leaf_category: "Светодиодные лампы" },
  ], ["Потолочные светильники"], "Светильники");
  assertEquals(products, [
    { pagetitle: "Светильник потолочный LED 60W", leaf_category: "Потолочные светильники" },
  ]);
});

Deno.test("terminal category target treats supported leaf modifiers as alternatives", () => {
  const products = filterProductsByGroundedCategoryTargets([
    { pagetitle: "Светильник светодиодный потолочный 60W", leaf_category: null },
    { pagetitle: "Прожектор светодиодный потолочный 60W", leaf_category: "Прожекторы" },
  ], ["Светильники потолочные накладные", "Светильники встраиваемые"], "Светильники");
  assertEquals(products, [
    { pagetitle: "Светильник светодиодный потолочный 60W", leaf_category: null },
  ]);
});

Deno.test("terminal category target derives class from common leaf token when umbrella is broader", () => {
  const products = filterProductsByGroundedCategoryTargets([
    { pagetitle: "Светильник потолочный LED 60W", leaf_category: null },
    { pagetitle: "Прожектор потолочный LED 60W", leaf_category: "Прожекторы" },
  ], ["Потолочные светильники", "Накладные светильники"], "Освещение");
  assertEquals(products, [
    { pagetitle: "Светильник потолочный LED 60W", leaf_category: null },
  ]);
});

Deno.test("terminal category target rejects a live leaf unsupported by initial reasoning", () => {
  const products = filterProductsByGroundedCategoryTargets([
    { pagetitle: "Светильник потолочный LED", leaf_category: "Потолочные светильники" },
    { pagetitle: "Светильник уличный LED", leaf_category: "Уличные светильники" },
  ], ["Светильники"], "Светильники", "Нужны потолочные светильники для жилой гостиной");
  assertEquals(products, [
    { pagetitle: "Светильник потолочный LED", leaf_category: "Потолочные светильники" },
  ]);
});

Deno.test("an ungrounded corrective discovery cannot erase an earlier grounded scope", () => {
  const broad = {
    category: { pagetitle: "Светильники" },
    leaf_categories: [{ pagetitle: "Уличные светильники" }],
  };
  const wrongCorrection = {
    category: { pagetitle: "Уличные светильники" },
    leaf_categories: [{ pagetitle: "Уличные прожекторы" }],
  };
  const scopes = rankGroundedCategoryRecoveryScopes(
    [broad, wrongCorrection],
    "Нужен потолочный светильник для гостиной",
  );
  assertEquals(scopes.map(({ discovery }) => discovery.category?.pagetitle), ["Светильники"]);
  assertEquals(scopes[0]?.targets, ["Светильники"]);
});

Deno.test("the source side of replace X with Y does not ground the target category", () => {
  const sourceCategory = {
    category: { pagetitle: "Каталог" },
    leaf_categories: [{ pagetitle: "Исходные устройства" }],
  };
  assertEquals(
    groundedCategoryRecoveryQueries(
      sourceCategory,
      "Хочу заменить исходное устройство на новое решение",
    ),
    [],
  );
  assertEquals(
    groundedCategoryRecoveryQueries(
      sourceCategory,
      "Хочу заменить старое исходное устройство на новое исходное устройство",
    ),
    ["Исходные устройства"],
  );
});

Deno.test("an exact umbrella leaf cannot self-ground from the source side of a transformation", () => {
  const targetScope = {
    category: { pagetitle: "Целевые устройства" },
    leaf_categories: [{ pagetitle: "Побочные устройства" }],
  };
  const sourceScope = {
    category: { pagetitle: "Исходные устройства" },
    leaf_categories: [{ pagetitle: "Исходные устройства" }],
  };
  const scopes = rankGroundedCategoryRecoveryScopes(
    [targetScope, sourceScope],
    "Хочу заменить исходное устройство на целевое устройство",
  );
  assertEquals(scopes.map(({ discovery }) => discovery.category?.pagetitle), ["Целевые устройства"]);
});

Deno.test("terminal token ladder decomposes a failed semantic phrase", () => {
  assertEquals(groundedTokenRecoveryQueries("современные люстры"), ["современные", "люстры"]);
});

Deno.test("token recovery keeps the consultant's selective title token and rejects a broad substitute", () => {
  const selected = selectGroundedTokenRecoveryCandidate([
    { query: "canonical-form", total: 25 },
    { query: "generic-type", total: 1 },
  ], 703);
  assertEquals(selected, { query: "canonical-form", total: 25 });
  assertEquals(selectGroundedTokenRecoveryCandidate([
    { query: "generic-a", total: 180 },
    { query: "generic-b", total: 410 },
  ], 703), null);
});

Deno.test("token recovery requires a complete title word, not a prefix inside another token", () => {
  assert(titleContainsLiteralToken("Product LED DISTINCTIVE capsule", "distinctive"));
  assert(!titleContainsLiteralToken("Product GENERICTOOL floodlight", "generic"));
});

Deno.test("token recovery grounds a Cyrillic series name in a near-identical Latin title", () => {
  assert(titleContainsLiteralToken("Розетка с заземлением Gallant /W5073135", "Галант"));
  assert(!titleContainsLiteralToken("Розетка с заземлением Glossa", "Галант"));
  assert(!titleContainsLiteralToken("Средство LABEL OFF", "Галант"));
});

Deno.test("named series guard removes a non-empty but unrelated collection pool", () => {
  const products = filterProductsByNamedSeries([
    { pagetitle: "Розетка Asfora с заземлением" },
    { pagetitle: "Выключатель BRITE двухклавишный" },
    { pagetitle: "Розетка Gallant с защитными шторками" },
  ], "Галант");
  assertEquals(products, [{ pagetitle: "Розетка Gallant с защитными шторками" }]);
});

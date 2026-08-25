// Unit tests for the universal criteria gate. Data-agnostic fixtures:
// абстрактные имена параметров, никаких реальных категорий/брендов каталога.

import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import {
  applyCriteriaGate,
  buildCriteriaQuery,
  checkCriterion,
  filterProductIdsByBudgetCap,
  findTrait,
  mergeFacetOptionConstraints,
  mergeUserBackedCriteria,
  parseNumSpan,
  projectCatalogFilterEvidence,
  projectCriteriaFacetOptions,
  resolveRenderCriteria,
  resolveTerminalSelectionCriteria,
  titleProvesCompactCriterion,
  type Criterion,
} from "./criteria-gate.ts";
import type { ProductRef } from "./types.ts";

function product(id: string, traits: string[]): ProductRef {
  return { id, pagetitle: `P-${id}`, vendor: null, price: 100, stock: "unknown", short_traits: traits };
}

Deno.test("render criteria: named entity browse keeps only user-backed filters", () => {
  const inferred = [{ key: "Тип", op: "eq", value: "ошибочный", level: "A" }] as Criterion[];
  const raw = [{ key: "Мощность", op: "min", value: 100, level: "A" }] as Criterion[];
  const userBacked = [{ key: "Цвет", op: "eq", value: "белый", level: "A" }] as Criterion[];
  assertEquals(resolveRenderCriteria(inferred, raw, userBacked, true), userBacked);
  assertEquals(resolveRenderCriteria(inferred, raw, userBacked, false), [...userBacked, ...inferred, ...raw]);
});

Deno.test("render criteria: explicit user filters override inferred filters on the same facet", () => {
  const inferred = [{ key: "Connector", op: "eq", value: "B", level: "A" }] as Criterion[];
  const raw = [{ key: "Connector", op: "eq", value: "C", level: "A" }] as Criterion[];
  const userBacked = [{ key: "Connector", op: "eq", value: "A", level: "A" }] as Criterion[];
  assertEquals(resolveRenderCriteria(inferred, raw, userBacked, false), userBacked);
});

Deno.test("user-backed criteria accumulate monotonically across fallback searches", () => {
  const first = [{ key: "Connector", op: "eq", value: "A", level: "A" }] as Criterion[];
  const second = [{ key: "Count", op: "eq", value: "3", level: "A" }] as Criterion[];
  assertEquals(mergeUserBackedCriteria(first, []), first);
  assertEquals(mergeUserBackedCriteria(first, second), [...first, ...second]);
  assertEquals(mergeUserBackedCriteria([...first, ...second], first), [...first, ...second]);
});

Deno.test("a broad semantic recovery cannot discard the latest mandatory contract", () => {
  const latest = [
    { key: "Поток", op: "range", value: [3750, 5000], level: "A" },
    { key: "Площадь", op: "min", value: 25, level: "A" },
  ] as Criterion[];
  const recovered = resolveRenderCriteria([], latest, [], false);
  assertEquals(recovered, latest);
  assertEquals(applyCriteriaGate([
    product("weak", ["Мощность: 7 Вт"]),
  ], recovered).passed_ids, []);
});

Deno.test("terminal recovery preserves frozen user criteria omitted by the model", () => {
  const projected = [{ key: "Power", op: "min", value: 100, unit: "W", level: "A" }] as Criterion[];
  const latest = [{ key: "Curve", op: "eq", value: "C", level: "A" }] as Criterion[];
  const userBacked = [{ key: "Current", op: "eq", value: "16 A", level: "A" }] as Criterion[];
  assertEquals(
    resolveTerminalSelectionCriteria(projected, latest, userBacked),
    [...userBacked, ...projected, ...latest],
  );
});

Deno.test("compact code criterion must be visible in the product title", () => {
  const criterion = { key: "Характеристика", op: "eq", value: "C", level: "A" } as Criterion;
  assertEquals(titleProvesCompactCriterion("Автомат 1P 16A характеристика C", criterion), true);
  assertEquals(titleProvesCompactCriterion("Автомат 1Р 16А х-ка С", criterion), true);
  assertEquals(titleProvesCompactCriterion("Автомат с заземлением 1Р 16А", criterion), false);
  assertEquals(titleProvesCompactCriterion("Автомат 1P 16A CHINT", criterion), false);
  assertEquals(titleProvesCompactCriterion("Товар белый", { ...criterion, value: "белый" }), true);
  assertEquals(titleProvesCompactCriterion("Кабель ВВГнг 2×1,5", { ...criterion, value: "медь" }), true);
});

Deno.test("parseNumSpan: scalar, decimal comma", () => {
  assertEquals(parseNumSpan("12"), { min: 12, max: 12 });
  assertEquals(parseNumSpan("12,5 ед"), { min: 12.5, max: 12.5 });
});

Deno.test("parseNumSpan: ranges in all dash forms", () => {
  assertEquals(parseNumSpan("12-15"), { min: 12, max: 15 });
  assertEquals(parseNumSpan("12 – 15 ед"), { min: 12, max: 15 });
  assertEquals(parseNumSpan("от 12 до 15"), { min: 12, max: 15 });
  assertEquals(parseNumSpan("12…15"), { min: 12, max: 15 });
});

Deno.test("parseNumSpan: open-ended", () => {
  assertEquals(parseNumSpan("не менее 12"), { min: 12, max: Number.POSITIVE_INFINITY });
  assertEquals(parseNumSpan("до 15"), { min: Number.NEGATIVE_INFINITY, max: 15 });
});

Deno.test("parseNumSpan: proportions and versions are not sizes", () => {
  assertEquals(parseNumSpan("2:1"), null);
  assertEquals(parseNumSpan("1.2.3"), null);
  assertEquals(parseNumSpan(""), null);
  assertEquals(parseNumSpan("нет данных"), null);
});

Deno.test("findTrait: exact and partial label match, миссинг", () => {
  const p = product("1", ["Параметр альфа: 10 ед", "Параметр бета расширенный: 20 ед"]);
  assertEquals(findTrait(p, "параметр альфа")?.value, "10 ед");
  assertEquals(findTrait(p, "Параметр бета")?.value, "20 ед");
  assertEquals(findTrait(p, "параметр гамма"), null);
});

Deno.test("findTrait: first-class catalog price is evidence for budget criteria", () => {
  const p = { ...product("1", []), price: 2800 };
  assertEquals(findTrait(p, "Цена")?.value, "2800");
  assertEquals(findTrait(p, "Стоимость товара")?.value, "2800");
  assertEquals(findTrait(p, "Бюджет")?.value, "2800");
});

Deno.test("checkCriterion: price max uses ProductRef.price without a short trait", () => {
  const withinBudget = { ...product("1", []), price: 2800 };
  const overBudget = { ...product("2", []), price: 4300 };
  const criterion: Criterion = { key: "Цена", op: "max", value: 4000, unit: "тенге", level: "A" };

  assertEquals(checkCriterion(withinBudget, criterion).verdict, "pass");
  assertEquals(checkCriterion(overBudget, criterion).verdict, "fail");

  const report = applyCriteriaGate([withinBudget, overBudget], [criterion]);
  assertEquals(report.passed_ids, ["1"]);
  assertEquals(report.unverifiable_keys, []);
  assertEquals(report.rejected, [
    { id: "2", key: "Цена", expected: "≤ 4000 тенге", actual: "4300" },
  ]);
});

Deno.test("budget cap filters ordinary and recovery render ids by catalog price", () => {
  const products = new Map([
    ["within", { price: 900 }],
    ["over", { price: 1745 }],
    ["zero", { price: 0 }],
  ]);
  assertEquals(filterProductIdsByBudgetCap(["within", "over", "zero", "missing"], products, 1000), {
    ids: ["within"],
    dropped: 3,
  });
  assertEquals(filterProductIdsByBudgetCap(["within", "over"], products, null), {
    ids: ["within", "over"],
    dropped: 0,
  });
});

Deno.test("checkCriterion: range overlap → pass, disjoint → fail", () => {
  const p = product("1", ["Параметр альфа: 12-15 ед"]);
  const pass: Criterion = { key: "параметр альфа", op: "range", value: [12, 15], unit: "ед" };
  const fail: Criterion = { key: "параметр альфа", op: "range", value: [20, 25], unit: "ед" };
  assertEquals(checkCriterion(p, pass).verdict, "pass");
  assertEquals(checkCriterion(p, fail).verdict, "fail");
});

Deno.test("checkCriterion: min/max operators", () => {
  const p = product("1", ["Параметр альфа: 10 ед"]);
  assertEquals(checkCriterion(p, { key: "параметр альфа", op: "min", value: 8 }).verdict, "pass");
  assertEquals(checkCriterion(p, { key: "параметр альфа", op: "min", value: 12 }).verdict, "fail");
  assertEquals(checkCriterion(p, { key: "параметр альфа", op: "max", value: 12 }).verdict, "pass");
  assertEquals(checkCriterion(p, { key: "параметр альфа", op: "max", value: 8 }).verdict, "fail");
});

Deno.test("checkCriterion: string eq — нормализованное вхождение", () => {
  const p = product("1", ["Параметр строковый: Значение Икс"]);
  assertEquals(checkCriterion(p, { key: "параметр строковый", op: "eq", value: "значение икс" }).verdict, "pass");
  assertEquals(checkCriterion(p, { key: "параметр строковый", op: "eq", value: "значение игрек" }).verdict, "fail");
});

Deno.test("numeric string equality does not match longer numbers by substring", () => {
  const criterion: Criterion = { key: "Параметр", op: "eq", value: "16", unit: "А", level: "A" };
  assertEquals(checkCriterion(product("exact", ["Параметр: 16"]), criterion).verdict, "pass");
  assertEquals(checkCriterion(product("large", ["Параметр: 1600"]), criterion).verdict, "fail");
  assertEquals(checkCriterion(product("range", ["Параметр: 0.1-0.16"]), criterion).verdict, "fail");
});

Deno.test("checkCriterion: отсутствие характеристики = unknown, не fail", () => {
  const p = product("1", ["Другой параметр: 5 ед"]);
  const ch = checkCriterion(p, { key: "параметр альфа", op: "min", value: 100 });
  assertEquals(ch.verdict, "unknown");
  assertEquals(ch.actual, null);
});

Deno.test("checkCriterion: строковый признак подтверждается описанием товара", () => {
  const p = {
    ...product("1", ["Вид: Бытовой светильник накладной"]),
    description_excerpt: "Данная модель оборудована микроволновым сенсором движения.",
  };
  assertEquals(
    checkCriterion(p, { key: "датчик движения", op: "eq", value: "микроволновый сенсор" }).verdict,
    "pass",
  );
});

Deno.test("checkCriterion: affirmative boolean feature is proven by catalog description", () => {
  const p = {
    ...product("1", []),
    pagetitle: "Светильник с микроволновым сенсором",
    description_excerpt: "Сенсор автоматически включает прибор при появлении движущихся объектов.",
  };
  assertEquals(
    checkCriterion(p, { key: "С датчиком движения", op: "eq", value: "да", level: "A" }).verdict,
    "pass",
  );
});

Deno.test("checkCriterion: affirmative boolean remains unknown without feature evidence", () => {
  const p = {
    ...product("1", []),
    description_excerpt: "Обычный потолочный светильник для сухих помещений.",
  };
  assertEquals(
    checkCriterion(p, { key: "С датчиком движения", op: "eq", value: "да", level: "A" }).verdict,
    "unknown",
  );
});

Deno.test("checkCriterion: строковое противоречие в одноимённом фасете = fail", () => {
  const p = product("1", ["Вид светильника: Светильники для ЖКХ"]);
  assertEquals(
    checkCriterion(p, { key: "Вид светильника", op: "eq", value: "Бытовые светильники накладные" }).verdict,
    "fail",
  );
});

Deno.test("applyCriteriaGate: без критериев пропускает всё", () => {
  const r = applyCriteriaGate([product("1", []), product("2", [])], []);
  assertEquals(r.passed_ids, ["1", "2"]);
  assertEquals(r.rejected.length, 0);
});

Deno.test("applyCriteriaGate: уровень A требует доказательства", () => {
  const items = [
    product("1", ["Параметр альфа: 12-15 ед"]),
    product("2", ["Параметр альфа: 4-6 ед"]),
    product("3", ["Иной параметр: 1 ед"]),
  ];
  const crit: Criterion[] = [{ key: "параметр альфа", op: "range", value: [12, 15], level: "A" }];
  const r = applyCriteriaGate(items, crit);
  assertEquals(r.passed_ids, ["1"]);
  assertEquals(r.rejected, [
    { id: "2", key: "параметр альфа", expected: "12–15", actual: "4-6 ед" },
    { id: "3", key: "параметр альфа", expected: "12–15", actual: "нет данных" },
  ]);
});

Deno.test("repeated equality values of one facet are alternatives, not impossible AND", () => {
  const items = [
    product("20", ["Мощность: 20 Вт"]),
    product("50", ["Мощность: 50 Вт"]),
    product("75", ["Мощность: 75 Вт"]),
  ];
  const criteria: Criterion[] = [20, 30, 50, 100].map((value) => ({
    key: "Мощность",
    op: "eq",
    value,
    unit: "Вт",
    level: "A",
  }));
  const report = applyCriteriaGate(items, criteria);
  assertEquals(report.passed_ids, ["20", "50"]);
  assertEquals(report.rejected.map((item) => item.id), ["75"]);
});

Deno.test("mandatory criteria compile into live facet OR values and numeric bounds", () => {
  const projection = projectCriteriaFacetOptions([
    { key: "Мощность", op: "eq", value: 20, unit: "Вт", level: "A" },
    { key: "Мощность", op: "eq", value: 50, unit: "Вт", level: "A" },
    { key: "Степень защиты", op: "eq", value: "IP65", level: "A" },
    { key: "Световой поток", op: "min", value: 3750, unit: "лм", level: "A" },
  ], [
    { key: "power", caption: "Мощность", unit: "Вт", values: [{ value: "20" }, { value: "30" }, { value: "50" }] },
    { key: "ip", caption: "Степень защиты", unit: null, values: [{ value: "IP44" }, { value: "IP65" }] },
    { key: "flow", caption: "Световой поток", unit: "лм", values: [{ value: "3000" }, { value: "4000" }, { value: "5000" }] },
  ]);
  assertEquals(projection.options, { power: ["20", "50"], ip: ["IP65"], flow: ["4000", "5000"] });
  assertEquals(projection.unmatched_keys, []);
});

Deno.test("machine facet key compiles through the same resolved live facet", () => {
  const projection = projectCriteriaFacetOptions([
    { key: "measured_output__lm", op: "min", value: 3750, unit: "lm", level: "A" },
  ], [{
    key: "measured_output__lm",
    caption: "Measured output, lm",
    unit: "lm",
    values: [{ value: "3000" }, { value: "4000" }, { value: "5000" }],
  }]);
  assertEquals(projection.options, { measured_output__lm: ["4000", "5000"] });
  assertEquals(projection.proven_criteria.length, 1);
  assertEquals(projection.unmatched_keys, []);
});

Deno.test("independent facet projections merge as one strict intersection", () => {
  assertEquals(mergeFacetOptionConstraints(
    { before: ["13", "14", "16"], after: ["4", "6", "7", "8"] },
    { ratio: ["2:1"], before: ["14", "16"] },
  ), {
    options: { before: ["14", "16"], after: ["4", "6", "7", "8"], ratio: ["2:1"] },
    conflicting_keys: [],
  });
});

Deno.test("contradictory projections fail closed", () => {
  assertEquals(mergeFacetOptionConstraints({ axis: ["a"] }, { axis: ["b"] }), {
    options: {},
    conflicting_keys: ["axis"],
  });
});

Deno.test("numeric bounds intersect before the live facet result is bounded", () => {
  const projection = projectCriteriaFacetOptions([
    { key: "Световой поток", op: "min", value: 3750, unit: "лм", level: "A" },
    { key: "Световой поток", op: "max", value: 5000, unit: "лм", level: "A" },
  ], [{
    key: "flow",
    caption: "Световой поток",
    unit: "лм",
    values: [
      ...Array.from({ length: 13 }, (_, index) => ({ value: String(6000 + index * 100) })),
      { value: "3800" }, { value: "4000" }, { value: "4500" }, { value: "4800" }, { value: "5100" },
    ],
  }]);
  assertEquals(projection.options, { flow: ["3800", "4000", "4500", "4800"] });
  assertEquals(projection.proven_criteria.length, 2);
  assertEquals(projection.unmatched_keys, []);
});

Deno.test("successful canonical filter lineage proves an omitted compact trait", () => {
  const criterion: Criterion = { key: "Параметр каталога", op: "eq", value: "6,8–12", level: "A" };
  const items = projectCatalogFilterEvidence([product("1", [])], [criterion]);
  assertEquals(applyCriteriaGate(items, [criterion]).passed_ids, ["1"]);
});

Deno.test("applyCriteriaGate: уровень B не отсеивает", () => {
  const items = [product("1", ["Параметр бета: 1 ед"])];
  const r = applyCriteriaGate(items, [{ key: "параметр бета", op: "min", value: 100, level: "B" }]);
  assertEquals(r.passed_ids, ["1"]);
  assertEquals(r.rejected.length, 0);
});

Deno.test("applyCriteriaGate: unverifiable_keys когда данных нет ни в одной карточке", () => {
  const items = [product("1", ["Иной параметр: 1 ед"]), product("2", [])];
  const r = applyCriteriaGate(items, [{ key: "параметр альфа", op: "min", value: 5 }]);
  assertEquals(r.unverifiable_keys, ["параметр альфа"]);
  assertEquals(r.passed_ids, []);
});

Deno.test("applyCriteriaGate: все карточки провалились → honest-empty", () => {
  const items = [product("1", ["Параметр альфа: 1 ед"]), product("2", ["Параметр альфа: 2 ед"])];
  const r = applyCriteriaGate(items, [{ key: "параметр альфа", op: "min", value: 10 }]);
  assertEquals(r.passed_ids, []);
  assertEquals(r.rejected.length, 2);
});

Deno.test("buildCriteriaQuery: формулировка модели превращается в текстовый запрос", () => {
  const q = buildCriteriaQuery("термоусаживаемая трубка", [
    { key: "Внутренний диаметр до термоусадки", op: "min", value: 40, unit: "мм" },
    { key: "Цвет", op: "eq", value: "черный", level: "B" },
  ]);
  assertEquals(q, "термоусаживаемая трубка Внутренний диаметр до термоусадки от 40 мм");
});

Deno.test("op=min со строковым value сохраняет открытый интервал", () => {
  const p = { id: "1", pagetitle: "x", url: "u", price: 1, stock: "unknown", short_traits: ["Внутр диаметр: 14"] } as never;
  const check = checkCriterion(p, { key: "Внутр диаметр", op: "min", value: "12", unit: "мм", level: "A" });
  assertEquals(check.verdict, "pass");
});

Deno.test("buildCriteriaQuery: многословное описание не попадает в запрос", () => {
  const q = buildCriteriaQuery("КГ 3*6", [
    { key: "Количество жил", op: "eq", value: "3", level: "A" },
    { key: "Сечение кабеля, мм2", op: "eq", value: "6", level: "A" },
    { key: "Назначение", op: "eq", value: "Кабели силовые для нестационарной прокладки", level: "A" },
  ]);
  if (q.includes("нестационарной")) throw new Error("verbose value leaked: " + q);
  if (!q.includes("Количество жил 3")) throw new Error("compact criterion lost: " + q);
});

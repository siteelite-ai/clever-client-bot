// Unit tests for the universal criteria gate. Data-agnostic fixtures:
// абстрактные имена параметров, никаких реальных категорий/брендов каталога.

import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import {
  applyCriteriaGate,
  buildCriteriaQuery,
  checkCriterion,
  findTrait,
  parseNumSpan,
  resolveRenderCriteria,
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
  assertEquals(resolveRenderCriteria(inferred, raw, userBacked, false), [...inferred, ...raw]);
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

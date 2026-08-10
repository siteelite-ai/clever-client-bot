// Unit tests for the universal criteria gate. Data-agnostic fixtures:
// абстрактные имена параметров, никаких реальных категорий/брендов каталога.

import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import {
  applyCriteriaGate,
  checkCriterion,
  findTrait,
  parseNumSpan,
  type Criterion,
} from "./criteria-gate.ts";
import type { ProductRef } from "./types.ts";

function product(id: string, traits: string[]): ProductRef {
  return { id, pagetitle: `P-${id}`, vendor: null, price: 100, stock: "unknown", short_traits: traits };
}

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

Deno.test("applyCriteriaGate: без критериев пропускает всё", () => {
  const r = applyCriteriaGate([product("1", []), product("2", [])], []);
  assertEquals(r.passed_ids, ["1", "2"]);
  assertEquals(r.rejected.length, 0);
});

Deno.test("applyCriteriaGate: отсев только по уровню A", () => {
  const items = [
    product("1", ["Параметр альфа: 12-15 ед"]),
    product("2", ["Параметр альфа: 4-6 ед"]),
    product("3", ["Иной параметр: 1 ед"]),
  ];
  const crit: Criterion[] = [{ key: "параметр альфа", op: "range", value: [12, 15], level: "A" }];
  const r = applyCriteriaGate(items, crit);
  assertEquals(r.passed_ids, ["1", "3"]); // 3 — unknown, не отсеиваем
  assertEquals(r.rejected, [{ id: "2", key: "параметр альфа", expected: "12–15", actual: "4-6 ед" }]);
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
  assertEquals(r.passed_ids, ["1", "2"]);
});

Deno.test("applyCriteriaGate: все карточки провалились → honest-empty", () => {
  const items = [product("1", ["Параметр альфа: 1 ед"]), product("2", ["Параметр альфа: 2 ед"])];
  const r = applyCriteriaGate(items, [{ key: "параметр альфа", op: "min", value: 10 }]);
  assertEquals(r.passed_ids, []);
  assertEquals(r.rejected.length, 2);
});

// Unit tests: Layer 5 — рассуждение модели как источник истины.
// Data-agnostic: абстрактные имена параметров.

import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { alignCriteriaWithReasoning, extractReasoningBounds } from "./criteria-reasoning.ts";
import { checkCriterion, type Criterion } from "./criteria-gate.ts";
import type { ProductRef } from "./types.ts";

function product(id: string, traits: string[]): ProductRef {
  return { id, pagetitle: `P-${id}`, vendor: null, price: 100, stock: "unknown", short_traits: traits };
}

Deno.test("extractReasoningBounds: направления и строгость", () => {
  assertEquals(extractReasoningBounds("нужен диаметр больше 12 мм"), [
    { op: "min", value: 12, unit: "мм", strict: true },
  ]);
  assertEquals(extractReasoningBounds("не менее 40 мм"), [
    { op: "min", value: 40, unit: "мм", strict: false },
  ]);
  assertEquals(extractReasoningBounds("не более 15 а"), [
    { op: "max", value: 15, unit: "а", strict: false },
  ]);
  assertEquals(extractReasoningBounds("нужно 12 штук"), []);
});

Deno.test("alignCriteriaWithReasoning: eq на числе клиента → min по прозе", () => {
  const criteria: Criterion[] = [
    { key: "Параметр альфа", op: "eq", value: 12, unit: "мм", level: "A" },
  ];
  const r = alignCriteriaWithReasoning(criteria, "Диаметр должен быть больше 12 мм с запасом.");
  assertEquals(r.alignments.length, 1);
  assertEquals(r.criteria[0].op, "min");
  assertEquals(r.criteria[0].exclusive, true);
});

Deno.test("alignCriteriaWithReasoning: порог не выдумывается без совпадения числа", () => {
  const criteria: Criterion[] = [
    { key: "Параметр альфа", op: "eq", value: 12, unit: "мм", level: "A" },
  ];
  const r = alignCriteriaWithReasoning(criteria, "нужен запас не менее 40 мм");
  assertEquals(r.alignments.length, 0);
  assertEquals(r.criteria[0].op, "eq");
});

Deno.test("alignCriteriaWithReasoning: уровень B не трогаем", () => {
  const criteria: Criterion[] = [
    { key: "Параметр бета", op: "eq", value: 12, unit: "мм", level: "B" },
  ];
  const r = alignCriteriaWithReasoning(criteria, "больше 12 мм");
  assertEquals(r.alignments.length, 0);
});

Deno.test("гейт: строгое неравенство отсеивает границу", () => {
  const p = product("1", ["Параметр альфа: 12/6 мм"]);
  const strict: Criterion = { key: "Параметр альфа", op: "min", value: 12, unit: "мм", exclusive: true };
  const loose: Criterion = { key: "Параметр альфа", op: "min", value: 12, unit: "мм" };
  assertEquals(checkCriterion(p, strict).verdict, "fail");
  assertEquals(checkCriterion(p, loose).verdict, "pass");
});

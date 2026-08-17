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

Deno.test("строгость задаёт только проза системы, а не совпадение с числом клиента", () => {
  const criteria: Criterion[] = [
    { key: "Параметр альфа", op: "min", value: 12, unit: "мм", level: "A" },
  ];
  const strict = alignCriteriaWithReasoning(criteria, "нужен размер больше 12 мм");
  const inclusive = alignCriteriaWithReasoning(criteria, "нужен размер не менее 12 мм");
  assertEquals(strict.criteria[0].exclusive, true);
  assertEquals(inclusive.criteria[0].exclusive === true, false);
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

Deno.test("строгая формулировка побеждает нестрогую по тому же числу", () => {
  const criteria: Criterion[] = [
    { key: "Параметр альфа", op: "min", value: 12, unit: "мм", level: "A" },
  ];
  const r = alignCriteriaWithReasoning(
    criteria,
    "нужен диаметр больше 12 мм; то есть ≥ 12 мм; беру типоразмеры от 12 мм",
  );
  assertEquals(r.alignments.length, 1);
  assertEquals(r.criteria[0].op, "min");
  assertEquals(r.criteria[0].exclusive, true);
  assertEquals(r.ambiguities.length, 0);
});

Deno.test("противоположные направления: направление берём машинное, строгость — из прозы", () => {
  const criteria: Criterion[] = [
    { key: "Параметр альфа", op: "min", value: 12, unit: "мм", level: "A" },
  ];
  const r = alignCriteriaWithReasoning(
    criteria,
    "до усадки больше 12 мм, после усадки меньше 12 мм",
  );
  assertEquals(r.criteria[0].op, "min");
  assertEquals(r.criteria[0].exclusive, true);
  assertEquals(r.ambiguities.length, 0);
});

Deno.test("противоположные направления без совпадения с машинным op → ambiguity", () => {
  const criteria: Criterion[] = [
    { key: "Параметр альфа", op: "eq", value: 12, unit: "мм", level: "A" },
  ];
  const r = alignCriteriaWithReasoning(
    criteria,
    "до усадки больше 12 мм, после усадки меньше 12 мм",
  );
  assertEquals(r.alignments.length, 0);
  assertEquals(r.criteria[0].op, "eq");
  assertEquals(r.ambiguities.length, 2);
});

Deno.test("регресс fd817c18: трубка 12/6 не проходит после выравнивания", () => {
  const reasoning = [
    "ищу трубки с исходным диаметром (до усадки) больше 12 мм — чтобы надеть кабель, — и усаженным диаметром меньше 12 мм",
    "внутренний диаметр до усадки ≥ 12 мм",
    "иду смотреть типоразмеры с внутренним диаметром от 12 мм",
  ].join("\n");
  const criteria: Criterion[] = [
    { key: "Внутр диаметр до термоусадки, мм", op: "min", value: 12, unit: "мм", level: "A" },
  ];
  const r = alignCriteriaWithReasoning(criteria, reasoning);
  assertEquals(r.criteria[0].exclusive, true);
  const p = product("1", ["Внутр диаметр до термоусадки, мм: 12"]);
  assertEquals(checkCriterion(p, r.criteria[0]).verdict, "fail");
});

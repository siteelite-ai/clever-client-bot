import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  correctCriteria,
  extractClientQuantities,
  findUnderstatedCriteria,
} from "./criteria-consistency.ts";
import type { Criterion } from "./criteria-gate.ts";

Deno.test("extract: число с единицей", () => {
  assertEquals(extractClientQuantities("кабель диаметром 200 мм"), [{ value: 200, unit: "мм" }]);
});

Deno.test("extract: число без единицы игнорируется", () => {
  assertEquals(extractClientQuantities("нужно 5 вариантов"), []);
});

Deno.test("extract: дробное и несколько", () => {
  assertEquals(extractClientQuantities("на 12,5 мм и 30 вт"), [
    { value: 12.5, unit: "мм" },
    { value: 30, unit: "вт" },
  ]);
});

Deno.test("min-критерий ниже числа клиента → violation", () => {
  const criteria: Criterion[] = [{ key: "Внутр диаметр", op: "min", value: 40, unit: "мм", level: "A" }];
  const v = findUnderstatedCriteria(criteria, "кабель 200 мм");
  assertEquals(v.length, 1);
  assertEquals(v[0].stated, 40);
  assertEquals(v[0].client, 200);
});

Deno.test("min-критерий равен/выше числа клиента → ок", () => {
  const criteria: Criterion[] = [{ key: "Внутр диаметр", op: "min", value: 200, unit: "мм", level: "A" }];
  assertEquals(findUnderstatedCriteria(criteria, "кабель 200 мм").length, 0);
});

Deno.test("другая единица не сверяется", () => {
  const criteria: Criterion[] = [{ key: "Мощность", op: "min", value: 5, unit: "Вт", level: "A" }];
  assertEquals(findUnderstatedCriteria(criteria, "кабель 200 мм").length, 0);
});

Deno.test("level B не проверяется", () => {
  const criteria: Criterion[] = [{ key: "Внутр диаметр", op: "min", value: 10, unit: "мм", level: "B" }];
  assertEquals(findUnderstatedCriteria(criteria, "кабель 200 мм").length, 0);
});

Deno.test("max-критерий выше числа клиента → violation", () => {
  const criteria: Criterion[] = [{ key: "Глубина", op: "max", value: 90, unit: "мм", level: "A" }];
  const v = findUnderstatedCriteria(criteria, "ниша 60 мм");
  assertEquals(v.length, 1);
  assertEquals(v[0].client, 60);
});

Deno.test("range: верхняя граница ниже клиента → violation", () => {
  const criteria: Criterion[] = [{ key: "Диаметр", op: "range", value: [10, 20], unit: "мм", level: "A" }];
  assertEquals(findUnderstatedCriteria(criteria, "кабель 200 мм").length, 1);
});

Deno.test("correctCriteria поднимает порог до числа клиента", () => {
  const criteria: Criterion[] = [{ key: "Внутр диаметр", op: "min", value: 40, unit: "мм", level: "A" }];
  const v = findUnderstatedCriteria(criteria, "кабель 200 мм");
  const fixed = correctCriteria(criteria, v);
  assertEquals(fixed[0].value, 200);
  assertEquals(fixed[0].op, "min");
});

Deno.test("correctCriteria не трогает валидные критерии", () => {
  const criteria: Criterion[] = [{ key: "A", op: "min", value: 300, unit: "мм", level: "A" }];
  assertEquals(correctCriteria(criteria, []), criteria);
});

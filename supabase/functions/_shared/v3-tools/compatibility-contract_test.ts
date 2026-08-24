import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import {
  compatibilityRelationsToCriteria,
  mergeCompatibilityCriteria,
  parseCompatibilityRelations,
  reasoningNeedsCompatibilityRelations,
  uncoveredReasoningBounds,
} from "./compatibility-contract.ts";

Deno.test("compatibility contract compiles generic strict relations", () => {
  const relations = parseCompatibilityRelations([
    { product_key: "Параметр до установки", relation: "gt", reference_value: 12, unit: "мм", level: "A" },
    { product_key: "Параметр после установки", relation: "lt", reference_value: 12, unit: "мм", level: "A" },
  ]);
  assertEquals(compatibilityRelationsToCriteria(relations), [
    { key: "Параметр до установки", op: "min", value: 12, unit: "мм", level: "A", exclusive: true },
    { key: "Параметр после установки", op: "max", value: 12, unit: "мм", level: "A", exclusive: true },
  ]);
});

Deno.test("structured relation replaces a contradictory raw criterion for the same key", () => {
  const relations = parseCompatibilityRelations([
    { product_key: "Параметр альфа", relation: "gt", reference_value: 12, unit: "мм" },
  ]);
  assertEquals(mergeCompatibilityCriteria([
    { key: "Параметр альфа", op: "eq", value: 12, unit: "мм" },
    { key: "Материал", op: "eq", value: "медь" },
  ], relations), [
    { key: "Материал", op: "eq", value: "медь" },
    { key: "Параметр альфа", op: "min", value: 12, unit: "мм", level: "A", exclusive: true },
  ]);
});

Deno.test("compatibility detection is based on relation shape, not product names", () => {
  assertEquals(reasoningNeedsCompatibilityRelations("Параметр альфа должен быть больше 12 мм, параметр бета меньше 12 мм"), true);
  assertEquals(reasoningNeedsCompatibilityRelations("Мощность товара должна быть не менее 40 Вт"), false);
  assertEquals(reasoningNeedsCompatibilityRelations("Устройство должно выдерживать нагрузку не менее 250 Вт"), true);
  assertEquals(reasoningNeedsCompatibilityRelations("Для комнаты нужен поток 3750–5000 лм"), false);
  assertEquals(reasoningNeedsCompatibilityRelations("До установки диапазон 15–20 мм, после установки 6–8 мм"), true);
});

Deno.test("all directional prose bounds must be represented", () => {
  const reasoning = "параметр до установки больше 12 мм, после установки меньше 12 мм";
  const one = parseCompatibilityRelations([
    { product_key: "Параметр до установки", relation: "gt", reference_value: 12, unit: "мм" },
  ]);
  assertEquals(uncoveredReasoningBounds(one, reasoning), [
    { op: "max", value: 12, unit: "мм", strict: true },
  ]);
  const both = parseCompatibilityRelations([
    { product_key: "Параметр до установки", relation: "gt", reference_value: 12, unit: "мм" },
    { product_key: "Параметр после установки", relation: "lt", reference_value: 12, unit: "мм" },
  ]);
  assertEquals(uncoveredReasoningBounds(both, reasoning), []);
});

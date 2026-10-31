import { assertEquals, assert } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  buildDerivedSelectionReasoningMessages,
  buildDerivedSelectionReasoningToolSchema,
  resolveDerivedSelectionReasoning,
} from "./selection-actionability.ts";

function ids(facets: Parameters<typeof buildDerivedSelectionReasoningToolSchema>[0], customer: string): string[] {
  const properties = buildDerivedSelectionReasoningToolSchema(facets, customer).function.parameters.properties as Record<string, { items: { enum?: string[] } }>;
  return properties.required_facet_values.items.enum ?? [];
}

Deno.test("decimal values are atomic and do not inherit ownership from their integer or fractional digits", () => {
  for (const unit of ["А", "В", "мм"]) {
    const facet = { key: "value", caption: `Параметр изделия, ${unit}`, unit, values: ["6", "6.3", "6,3", "3", "0.3"].map(value => ({ value })) };
    for (const customer of [`Нужно изделие: параметр изделия 6 ${unit}`, `Параметр изделия ровно 6 ${unit}`]) {
      const allowed = ids([facet], customer);
      assert(!allowed.includes("f0v1"), JSON.stringify({ unit, customer, allowed }));
      assert(!allowed.includes("f0v2"));
      assert(!allowed.includes("f0v4"));
    }
    assert(!ids([facet], `Нужно изделие: параметр изделия 3 ${unit}`).includes("f0v4"));
  }
});

Deno.test("a load point cannot authorize an exact nominal product equality or one enclosing live interval", () => {
  const facets = [
    { key: "setting", caption: "Диапазон уставки тока расцепления, А", unit: "А", values: ["4-6.3", "6-10", "10-16"].map(value => ({ value })) },
    { key: "rated", caption: "Номинальный ток, А", unit: "А", values: ["6", "6.3", "10"].map(value => ({ value })) },
  ];
  const customer = "Подберите автомат для асинхронного двигателя 3 кВт, 380 В, 3 фазы, прямой пуск, номинальный рабочий ток по шильдику 6 А.";
  assertEquals(ids(facets, customer), []);
  const prompt = buildDerivedSelectionReasoningMessages(customer, "Автоматы защиты двигателя", facets)[1].content;
  assert(!prompt.includes('"value":"6.3"'), prompt);
  const declaration = resolveDerivedSelectionReasoning({
    reasoning: "Диапазон уставки тока расцепления 4-6.3 А покрывает рабочий ток 6 А. Номинальный ток 6.3 А.",
    measurement_scope: "per_product", required_facet_values: ["f0v0", "f1v1"],
  }, facets, customer, "Автоматы защиты двигателя");
  assertEquals(declaration?.requiredFacetValues, []);
});

Deno.test("an out-of-contract model ID cannot authorize a scalar absent from the customer request", () => {
  const facets = [{ key: "length", caption: "Длина изделия, мм", unit: "мм", values: [{ value: "60" }, { value: "63" }] }];
  const result = resolveDerivedSelectionReasoning({
    reasoning: "Сравниваю варианты по свойству длина изделия 63 мм, это предварительный ориентир.",
    required_facet_values: ["f0v1"], measurement_scope: "per_product",
  }, facets, "Подбери изделие для помещения", "Изделия");
  assertEquals(result?.requiredFacetValues, []);
});

Deno.test("an exact decimal product requirement remains available with either decimal separator", () => {
  const facets = [{ key: "rated", caption: "Номинальный ток, А", unit: "А", values: ["6.3", "6,3", "6"].map(value => ({ value })) }];
  for (const decimal of ["6.3", "6,3"]) {
    const customer = `Нужен автомат с номинальным током ровно ${decimal} А`;
    const allowed = ids(facets, customer);
    assert(allowed.includes("f0v0") && allowed.includes("f0v1"), JSON.stringify({ customer, allowed }));
    assert(!allowed.includes("f0v2"));
  }
});

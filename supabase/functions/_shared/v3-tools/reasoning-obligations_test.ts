import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { resolveReasoningObligations } from "./reasoning-obligations.ts";

const numeric = {
  key: "волновое сопротивление",
  value: 75,
  unit: "Ом",
  op: "eq",
  scope: "per_product",
  source_span: "Необходимо волновое сопротивление 75 Ом.",
};
const environmental = {
  key: "оболочка",
  value: "УФ-стойкая",
  unit: "",
  op: "eq",
  scope: "per_product",
  source_span: "Обязательна УФ-стойкая оболочка.",
};

Deno.test("obligations do not depend on catalog search facets", () => {
  const result = resolveReasoningObligations(
    [numeric, environmental],
    numeric.source_span + " " + environmental.source_span,
  );
  assertEquals(result.unresolved, []);
  assertEquals(result.obligations.length, 2);
  assertEquals(result.obligations[0].criterion.value, 75);
  assertEquals(result.obligations[1].criterion.value, "УФ-стойкая");
});

Deno.test("unmapped evidence is unresolved rather than silently dropped", () => {
  for (
    const bad of [
      { ...numeric, value: 50 },
      { ...numeric, unit: "Вт" },
      { ...numeric, op: "min" },
      { ...numeric, key: "мощность" },
      { ...numeric, scope: "system_total" },
    ]
  ) {
    const result = resolveReasoningObligations([bad], numeric.source_span);
    assertEquals(result.obligations, []);
    assertEquals(result.unresolved.length, 1);
  }
});

Deno.test("direction and strictness are retained across categories", () => {
  const span = "Необходим световой поток не менее 3500 лм.";
  const item = {
    key: "световой поток",
    value: 3500,
    unit: "лм",
    op: "min",
    scope: "per_product",
    source_span: span,
  };
  assertEquals(
    resolveReasoningObligations([item], span).obligations[0]?.criterion.op,
    "min",
  );
  assertEquals(
    resolveReasoningObligations([{ ...item, op: "max" }], span).unresolved
      .length,
    1,
  );
  const strict = "Необходим диаметр больше 12 мм.";
  const result = resolveReasoningObligations([{
    ...item,
    key: "диаметр",
    value: 12,
    unit: "мм",
    source_span: strict,
  }], strict);
  assertEquals(result.obligations[0]?.criterion.exclusive, true);
});

Deno.test("preferences, hypothetical configurations and fabricated quotes are not obligations", () => {
  for (
    const span of [
      "Желательна УФ-стойкая оболочка.",
      "Если прокладка снаружи, обязательна УФ-стойкая оболочка.",
      "Не обязательна УФ-стойкая оболочка.",
    ]
  ) {
    assertEquals(
      resolveReasoningObligations(
        [{ ...environmental, source_span: span }],
        span,
      ).unresolved.length,
      1,
    );
  }
  assertEquals(
    resolveReasoningObligations([environmental], "Нет подтверждения свойств.")
      .unresolved.length,
    1,
  );
  assertEquals(resolveReasoningObligations(null, "").unresolved.length, 1);
  assertEquals(
    resolveReasoningObligations(Array(13).fill(numeric), numeric.source_span)
      .unresolved.length,
    1,
  );
});

Deno.test("partial quotes cannot hide negation or use substrings as property evidence", () => {
  assertEquals(
    resolveReasoningObligations(
      [environmental],
      "Не " + environmental.source_span,
    ).unresolved.length,
    1,
  );
  const span = "Необходим световой поток 3500 лм.";
  assertEquals(
    resolveReasoningObligations([{
      ...numeric,
      key: "ток",
      value: 3500,
      unit: "лм",
      source_span: span,
    }], span).unresolved.length,
    1,
  );
  assertEquals(
    resolveReasoningObligations(
      [{ ...numeric, value: "75 Ом", unit: "" }],
      numeric.source_span,
    ).unresolved.length,
    1,
  );
});

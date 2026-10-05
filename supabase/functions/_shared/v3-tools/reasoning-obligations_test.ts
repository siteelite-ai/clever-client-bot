import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  repairObligationDeclaration,
  resolveReasoningObligations,
} from "./reasoning-obligations.ts";

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

Deno.test("format repair preserves all selected semantics and original reasoning", () => {
  const original = {
    reasoning: "Проверяю условия применения.",
    mandatory_properties: [{ ...numeric, source_span: "неполная цитата" }],
    required_facet_values: ["opaque-1"],
    measurement_scope: "per_product",
  };
  const corrected = {
    reasoning: original.reasoning + " " + numeric.source_span,
    mandatory_properties: [numeric],
    required_facet_values: [],
    measurement_scope: "not_applicable",
  };
  const accepted = repairObligationDeclaration(original, corrected);
  assertEquals(accepted?.required_facet_values, ["opaque-1"]);
  assertEquals(accepted?.measurement_scope, "per_product");
  for (const value of [50, "75"]) {
    assertEquals(
      repairObligationDeclaration(original, {
        ...corrected,
        mandatory_properties: [{ ...numeric, value }],
      }),
      null,
    );
  }
  assertEquals(
    repairObligationDeclaration(original, {
      ...corrected,
      mandatory_properties: [],
    }),
    null,
  );
  assertEquals(
    repairObligationDeclaration(original, {
      ...corrected,
      reasoning: numeric.source_span,
    }),
    null,
  );
  assertEquals(
    repairObligationDeclaration(original, {
      ...corrected,
      mandatory_properties: [{ ...numeric, op: "min" }],
    }),
    null,
  );
});

Deno.test("property quotes tolerate inflection and reordered explanation but preserve codes", () => {
  const span = "Для уличной прокладки обязательна светостабилизированная оболочка из полиэтилена (ПЭ) черного цвета.";
  const item = { ...environmental, key: "Оболочка", value: "ПЭ (полиэтилен)", source_span: span };
  assertEquals(resolveReasoningObligations([item], span).unresolved, []);
  for (const value of ["ПП (полиэтилен)", "ПЭ (полипропилен)", "ПЭ (полиэтилен) красный"]) {
    assertEquals(resolveReasoningObligations([{ ...item, value }], span).unresolved.length, 1);
  }
});

Deno.test("a unique live descriptive value grounds its catalog caption without literal caption prose", () => {
  const source = "Для аналогового сигнала необходим радиочастотный коаксиальный кабель.";
  const item = { key: "Назначение", value: "Кабели радиочастотные", op: "eq", unit: "", scope: "per_product", source_span: source };
  const facet = { key: "purpose", caption: "Назначение", values: [{ value: item.value }] };
  assertEquals(resolveReasoningObligations([item], source, [facet]).unresolved, []);
  assertEquals(resolveReasoningObligations([item], source).unresolved.length, 1);
  assertEquals(resolveReasoningObligations([{ ...item, key: "Изоляция" }], source, [facet]).unresolved.length, 1);
  assertEquals(resolveReasoningObligations([item], source, [facet, { ...facet, key: "other", caption: "Другое" }]).unresolved.length, 1);
  const secondSource = "Необходим корпус из алюминиевого сплава.";
  const second = { ...item, key: "Материал", value: "алюминиевый сплав", source_span: secondSource };
  assertEquals(resolveReasoningObligations([second], secondSource, [{ key: "material", caption: "Материал", values: [{ value: second.value }] }]).unresolved, []);
  assertEquals(resolveReasoningObligations([item], source.replace("радиочастотный", "силовой"), [facet]).unresolved.length, 1);
});

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

Deno.test("source attribution expands only a unique exact sentence prefix", () => {
  const source = "Для уличной прокладки обязательна светостабилизированная оболочка из полиэтилена (ПЭ) черного цвета, устойчивая к ультрафиолету и осадкам.";
  const item = { ...environmental, key: "Оболочка", value: "ПЭ (полиэтилен)", source_span: source.replace(", устойчивая к ультрафиолету и осадкам", "") };
  const result = resolveReasoningObligations([item], source);
  assertEquals(result.unresolved, []);
  assertEquals(result.obligations[0].sourceSpan, source);
  assertEquals(resolveReasoningObligations([{ ...item, source_span: item.source_span.replace("черного", "белого") }], source).unresolved.length, 1);
  assertEquals(resolveReasoningObligations([item], source + " " + source.replace("осадкам", "нагреву")).unresolved.length, 1);
});

Deno.test("expanded attribution preserves trailing conditions, negation and numeric bounds", () => {
  for (const tail of [", если прокладка снаружи.", ", но это не обязательное требование."]) {
    const source = environmental.source_span.replace(/\.$/u, tail);
    assertEquals(resolveReasoningObligations([environmental], source).unresolved.length, 1);
  }
  const source = "Необходим диаметр больше 12,5 мм, это обязательный минимум.";
  const item = { ...numeric, key: "диаметр", value: 12.5, op: "min", unit: "мм", source_span: "Необходим диаметр больше 12,5 мм." };
  const result = resolveReasoningObligations([item], source);
  assertEquals(result.unresolved, []);
  assertEquals(result.obligations[0].criterion.exclusive, true);
  assertEquals(result.obligations[0].sourceSpan, source);
});

Deno.test("instrumental case preserves a measured live caption and its unit", () => {
  const source = "Для освещения двора площадью 35м2 с учетом высоты установки 1,5м необходим прожектор со световым потоком не менее 3500 Лм.";
  const item = { ...numeric, key: "Световой поток, Лм", value: 3500, op: "min", unit: "Лм", source_span: source };
  const result = resolveReasoningObligations([item], source);
  assertEquals(result.unresolved, []);
  assertEquals(result.obligations[0].criterion.value, 3500);
  assertEquals(resolveReasoningObligations([{ ...item, key: "Световой поток, Вт" }], source).unresolved.length, 1);
});

Deno.test("short enum codes retain exact token and caption grounding", () => {
  const source = "Обязательна характеристика срабатывания типа C для стандартных бытовых нагрузок.";
  const item = { ...environmental, key: "Характеристика срабатывания", value: "C", source_span: source };
  assertEquals(resolveReasoningObligations([item], source).unresolved, []);
  assertEquals(resolveReasoningObligations([{ ...item, value: "D" }], source).unresolved.length, 1);
  assertEquals(resolveReasoningObligations([item], source.replace("типа C", "типа CCS")).unresolved.length, 1);
});

Deno.test("dimensionless product counts reuse live schema count grounding", () => {
  for (const [key, source] of [["Количество полюсов", "Для однофазной сети требуется 1 полюсной прибор."], ["Количество элементов", "Необходимо 1 элементное изделие."]]) {
    const item = { ...numeric, key, value: 1, unit: "", source_span: source };
    const facets = [{ key: "count", caption: key, values: [{ value: "1" }, { value: "2" }] }];
    const result = resolveReasoningObligations([item], source, facets);
    assertEquals(result.unresolved, []);
    assertEquals(result.obligations[0].criterion.value, 1);
    assertEquals(resolveReasoningObligations([{ ...item, value: 2 }], source, facets).unresolved.length, 1);
    assertEquals(resolveReasoningObligations([item], source, []).unresolved.length, 1);
  }
});

Deno.test("explicit customer facet proof does not depend on a necessity verb in model prose", () => {
  const source = "Для создания уютной атмосферы подобраны модели, где Цветовая температура, К составляет 3000.";
  const item = { ...numeric, key: "Цветовая температура, К", unit: "К", value: 3000, source_span: source };
  const facets = [{ key: "temperature", caption: item.key, unit: "К", values: [{ value: "3000" }, { value: "4000" }] }];
  const result = resolveReasoningObligations([item], source, facets, "Нужны лампы 3000 К.");
  assertEquals(result.unresolved, []);
  assertEquals(result.obligations[0].criterion.evidence, "user_explicit");
  for (const request of ["Нужны лампы.", "Нужны лампы 4000 К.", "Нужны лампы 3000 Вт."]) {
    assertEquals(resolveReasoningObligations([item], source, facets, request).unresolved.length, 1);
  }
  const codeSource = "Для совместимости выбраны лампы, у которых Тип цоколя E27.";
  const code = { ...environmental, key: "Тип цоколя", value: "E27", source_span: codeSource };
  const codeFacets = [{ key: "base", caption: code.key, values: [{ value: "E27" }, { value: "E14" }] }];
  assertEquals(resolveReasoningObligations([code], codeSource, codeFacets, "Нужны лампы с цоколем E27.").unresolved, []);
  assertEquals(resolveReasoningObligations([code], codeSource, codeFacets, "Нужны лампы с цоколем E14.").unresolved.length, 1);
});

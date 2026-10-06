import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  findOmittedReasoningObligations,
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

Deno.test("frozen customer requirements survive incomplete live facet metadata without re-inference", () => {
  const source = "Для защиты линии выбран автоматический выключатель с параметром Номинальный ток 25 А.";
  const item = { key: "Номинальный ток", value: 25, unit: "А", op: "eq", scope: "per_product", source_span: source };
  const confirmed = { key: item.key, value: "25", unit: "а", op: "eq" as const,
    level: "A" as const, evidence: "user_explicit" as const };
  const resolve = (criteria: Parameters<typeof resolveReasoningObligations>[4]) =>
    resolveReasoningObligations([item], source, [], "", criteria);
  assertEquals(resolve([confirmed]).unresolved, []);
  assertEquals(resolve([confirmed]).obligations[0].criterion.evidence, "user_explicit");
  for (const criteria of [[], [{ ...confirmed, value: "16" }],
    [{ ...confirmed, unit: "В" }], [{ ...confirmed, key: "Другой параметр" }],
    [{ ...confirmed, evidence: "derived_required" as const }],
    [{ ...confirmed, op: "min" as const }]]) {
    assertEquals(resolve(criteria).unresolved.length, 1);
  }
});
const environmental = {
  key: "оболочка",
  value: "УФ-стойкая",
  unit: "",
  op: "eq",
  scope: "per_product",
  source_span: "Обязательна УФ-стойкая оболочка.",
};

Deno.test("regular Russian noun cases preserve property identity across measured axes", () => {
  const cases = [
    { key: "Сечение кабеля", source: "Необходим медный кабель с сечением не менее 2.5 мм2.", value: 2.5, unit: "мм2" },
    { key: "Напряжение питания", source: "Необходим прибор с напряжением питания не менее 12 В.", value: 12, unit: "В" },
    { key: "Волновое сопротивление", source: "Необходим кабель с волновым сопротивлением не менее 75 Ом.", value: 75, unit: "Ом" },
  ];
  for (const item of cases) {
    const declaration = { key: item.key, value: item.value, unit: item.unit,
      op: "min", scope: "per_product", source_span: item.source };
    assertEquals(resolveReasoningObligations([declaration], item.source).unresolved, []);
    assertEquals(resolveReasoningObligations([{ ...declaration, key: "Длина кабеля" }], item.source).unresolved.length, 1);
    assertEquals(resolveReasoningObligations([{ ...declaration, value: 999 }], item.source).unresolved.length, 1);
  }
});

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

Deno.test("label-first count statements canonicalize counting units but never physical measurements", () => {
  const facets = [{ key: "count", caption: "Количество элементов", values: [{ value: "1" }, { value: "3" }] }];
  for (const [source, unit, value] of [["Необходимо Количество элементов 1 шт.", "шт", 1], ["Необходимо количество элементов составляет 3.", "", 3]] as const) {
    const item = { ...numeric, key: "Количество элементов", source_span: source, unit, value };
    const result = resolveReasoningObligations([item], source, facets);
    assertEquals(result.unresolved, []);
    assertEquals(result.obligations[0].criterion.unit, undefined);
    assertEquals(resolveReasoningObligations([{ ...item, unit: "А" }], source, facets).unresolved.length, 1);
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

Deno.test("explicit outdoor coax requirements cannot disappear into an empty declaration", () => {
  const reasoning = "Для аналоговой камеры необходим коаксиальный кабель с волновым сопротивлением 75 Ом. Для уличного применения оболочка кабеля должна быть устойчива к ультрафиолету.";
  assertEquals(findOmittedReasoningObligations([], reasoning), [
    { reason: "undeclared_measured_product_property", sourceSpan: "Для аналоговой камеры необходим коаксиальный кабель с волновым сопротивлением 75 Ом." },
    { reason: "undeclared_qualitative_product_property", sourceSpan: "Для уличного применения оболочка кабеля должна быть устойчива к ультрафиолету." },
  ]);
});

Deno.test("property coverage is per claim, not merely a nonempty mandatory list", () => {
  const measured = "Для аналоговой камеры необходим коаксиальный кабель с волновым сопротивлением 75 Ом.";
  const environmental = "Для уличного применения оболочка кабеля должна быть устойчива к ультрафиолету.";
  const measuredObligation = { key: "Волновое сопротивление", op: "eq", value: 75, unit: "Ом", scope: "per_product", source_span: measured };
  const environmentalObligation = { key: "Оболочка", op: "eq", value: "устойчива к ультрафиолету", unit: "", scope: "per_product", source_span: environmental };
  const reasoning = `${measured} ${environmental}`;
  assertEquals(findOmittedReasoningObligations([measuredObligation], reasoning), [
    { reason: "undeclared_qualitative_product_property", sourceSpan: environmental },
  ]);
  assertEquals(findOmittedReasoningObligations([environmentalObligation], reasoning), [
    { reason: "undeclared_measured_product_property", sourceSpan: measured },
  ]);
  assertEquals(findOmittedReasoningObligations([measuredObligation, environmentalObligation], reasoning), []);
  assertEquals(findOmittedReasoningObligations([{ ...measuredObligation, value: 50 }, environmentalObligation], reasoning), [
    { reason: "undeclared_measured_product_property", sourceSpan: measured },
  ]);
});

Deno.test("coverage guard is category-neutral for quantified product attributes", () => {
  const source = "Для станка требуется двигатель с номинальной мощностью не менее 5 кВт.";
  assertEquals(findOmittedReasoningObligations([], source), [
    { reason: "undeclared_measured_product_property", sourceSpan: source },
  ]);
  assertEquals(findOmittedReasoningObligations([{ key: "Номинальная мощность", op: "min", value: 5, unit: "кВт", scope: "per_product", source_span: source }], source), []);
});

Deno.test("a binding sheath requirement survives an optional parenthetical example", () => {
  const source = "Для уличной прокладки обязательна стойкая к ультрафиолету оболочка (обычно черного цвета из полиэтилена).";
  assertEquals(findOmittedReasoningObligations([], source), [
    { reason: "undeclared_qualitative_product_property", sourceSpan: source },
  ]);
  const declared = { key: "Оболочка", op: "eq", value: "стойкая к ультрафиолету", unit: "", scope: "per_product", source_span: source };
  assertEquals(findOmittedReasoningObligations([declared], source), []);
});

Deno.test("required material and environmental resistance remain two covered claims", () => {
  const source = "Для улицы требуется оболочка из полиэтилена, устойчивая к УФ.";
  const material = { key: "Оболочка", op: "eq", value: "полиэтилен", unit: "", scope: "per_product", source_span: source };
  const resistance = { key: "Оболочка", op: "eq", value: "устойчивая к УФ", unit: "", scope: "per_product", source_span: source };
  const missing = [{ reason: "undeclared_qualitative_product_property", sourceSpan: source }];
  assertEquals(findOmittedReasoningObligations([], source), missing);
  assertEquals(findOmittedReasoningObligations([material], source), missing);
  assertEquals(findOmittedReasoningObligations([resistance], source), missing);
  assertEquals(findOmittedReasoningObligations([material, resistance], source), []);
  assertEquals(findOmittedReasoningObligations([{ ...material, key: "Изоляция" }, resistance], source), missing);

  const otherCategory = "Для морской эксплуатации необходим корпус из алюминиевого сплава, стойкий к коррозии.";
  assertEquals(findOmittedReasoningObligations([], otherCategory), [
    { reason: "undeclared_qualitative_product_property", sourceSpan: otherCategory },
  ]);

  const modalForm = "Для уличной прокладки оболочка кабеля должна быть выполнена из полиэтилена, устойчивая к ультрафиолету.";
  const modalMaterial = { ...material, source_span: modalForm };
  const modalResistance = { ...resistance, value: "устойчивая к ультрафиолету", source_span: modalForm };
  assertEquals(findOmittedReasoningObligations([modalMaterial], modalForm), [
    { reason: "undeclared_qualitative_product_property", sourceSpan: modalForm },
  ]);
  assertEquals(findOmittedReasoningObligations([modalMaterial, modalResistance], modalForm), []);
});

Deno.test("material-resistance grammar does not promote options, examples or site quantities", () => {
  for (const source of [
    "Требуется один из светильников.",
    "Требуется два из светильников.",
    "Нужен любой из предложенных приборов.",
    "Требуется несколько из доступных вариантов.",
    "Для улицы можно использовать оболочку из полиэтилена, устойчивую к УФ.",
    "Можно, при необходимости требуется оболочка из полиэтилена, устойчивая к УФ.",
    "Для улицы требуется оболочка, например из полиэтилена, устойчивая к УФ.",
    "Если прокладка уличная, требуется оболочка из полиэтилена, устойчивая к УФ.",
    "Для всей системы суммарно требуется оболочка из полиэтилена, устойчивая к УФ.",
    "Для трассы нужно 30 м оболочки из полиэтилена, устойчивой к УФ.",
  ]) {
    assertEquals(findOmittedReasoningObligations([], source), [], source);
  }
});

Deno.test("a resistance declaration must include what the product resists", () => {
  const source = "Для улицы оболочка должна быть устойчива к ультрафиолету.";
  const base = { key: "Оболочка", op: "eq", unit: "", scope: "per_product", source_span: source };
  const missing = [{ reason: "undeclared_qualitative_product_property", sourceSpan: source }];
  assertEquals(findOmittedReasoningObligations([{ ...base, value: "устойчива" }], source), missing);
  assertEquals(findOmittedReasoningObligations([{ ...base, value: "ультрафиолету" }], source), missing);
  assertEquals(findOmittedReasoningObligations([{ ...base, value: "устойчива к ультрафиолету" }], source), []);
  const compoundSource = "Для улицы обязательна УФ-стойкая оболочка.";
  const compoundBase = { ...base, source_span: compoundSource };
  assertEquals(findOmittedReasoningObligations([{ ...compoundBase, value: "стойкая" }], compoundSource), [
    { reason: "undeclared_qualitative_product_property", sourceSpan: compoundSource },
  ]);
  assertEquals(findOmittedReasoningObligations([{ ...compoundBase, value: "УФ-стойкая" }], compoundSource), []);
});

Deno.test("coverage guard does not promote site inputs, totals, options or clarifications", () => {
  const nonObligations = [
    "Для двора площадью 500 м² требуется суммарный световой поток 10000 лм, распределённый между четырьмя изделиями.",
    "Для трассы длиной 30 м нужен кабель; можно взять бухту большей длины.",
    "Можно выбрать кабель с волновым сопротивлением 75 Ом или другой совместимый вариант.",
    "Если требуется уличная прокладка, оболочка должна быть устойчива к ультрафиолету.",
    "Чтобы подобрать товар, необходимо уточнить площадь двора 500 м².",
    "Не требуется кабель с волновым сопротивлением 75 Ом.",
    "Необходим кабель с маркировкой 3x1.5.",
  ];
  for (const reasoning of nonObligations) {
    assertEquals(findOmittedReasoningObligations([], reasoning), [], reasoning);
  }
  const prescriptive = "Необходим кабель с волновым сопротивлением 75 Ом.";
  assertEquals(findOmittedReasoningObligations([], prescriptive, { clarificationQuestion: "Какой тип камеры?" }), []);
});

Deno.test("explicit required presence grounds an affirmative boolean facet without literal да", () => {
  const source = "Обязательно наличие встроенного датчика движения — это функциональное требование к каждому светильнику.";
  const item = { key: "С датчиком движения", op: "eq", value: "да", unit: "", scope: "per_product", source_span: source };
  const resolved = resolveReasoningObligations([item], source);
  assertEquals(resolved.unresolved, []);
  assertEquals(resolved.obligations[0].criterion.value, "да");
  for (const invalid of [
    { ...item, key: "С датчиком температуры" },
    { ...item, value: "нет" },
    { ...item, value: "да", source_span: "Обязательно наличие встроенного датчика температуры." },
  ]) {
    assertEquals(resolveReasoningObligations([invalid], source).unresolved.length, 1);
  }
  for (const negative of [
    "Обязательно отсутствие встроенного датчика движения.",
    "Не обязательно наличие встроенного датчика движения.",
    "Можно предусмотреть наличие встроенного датчика движения.",
    "Если нужно, обязательно наличие встроенного датчика движения.",
  ]) {
    assertEquals(resolveReasoningObligations([{ ...item, source_span: negative }], negative).unresolved.length, 1);
  }
});

Deno.test("bare measured decimal strings compile as numbers only with the same visible unit and operator", () => {
  const source = "Обязательна цветовая температура 3000 К для получения тёплого света.";
  const item = { key: "Цветовая температура", op: "eq", value: "3000", unit: "К", scope: "per_product", source_span: source };
  const result = resolveReasoningObligations([item], source);
  assertEquals(result.unresolved, []);
  assertEquals(result.obligations[0].criterion.value, 3000);
  assertEquals(findOmittedReasoningObligations([item], source), []);
  for (const invalid of [
    { ...item, value: "3001" },
    { ...item, unit: "Вт" },
    { ...item, op: "min" },
    { ...item, key: "Номинальная мощность" },
    { ...item, value: "3000 К" },
    { ...item, value: "IP65" },
  ]) {
    assertEquals(resolveReasoningObligations([invalid], source).unresolved.length, 1);
  }
  const bounded = "Необходим ток не менее 25 А.";
  const boundItem = { ...item, key: "ток", value: "25", unit: "А", op: "min", source_span: bounded };
  assertEquals(resolveReasoningObligations([boundItem], bounded).obligations[0]?.criterion.op, "min");
  assertEquals(resolveReasoningObligations([{ ...boundItem, op: "eq" }], bounded).unresolved.length, 1);
  const ambiguous = "Необходим номинальный ток 25 А, пусковой ток 16 А.";
  assertEquals(resolveReasoningObligations([{ ...item, key: "Номинальный ток", value: "25", unit: "А", source_span: ambiguous }], ambiguous).unresolved.length, 1);
  // An ordered IP code has no declared numeric scale. Never turn min IP65
  // into an exact text value or a fabricated physical quantity.
  const ip = "Необходима степень защиты не ниже IP65.";
  assertEquals(resolveReasoningObligations([{ ...item, key: "Степень защиты", value: "IP65", unit: "", op: "min", source_span: ip }], ip).unresolved.length, 1);
});

Deno.test("one exact clause under a visible necessity heading inherits its unique full sentence", () => {
  const source = "Обязательны: количество полюсов — 1, номинальный ток — 25 А, характеристика срабатывания — C, модульное исполнение для установки на DIN-рейку в щитке.";
  const base = { op: "eq", scope: "per_product" };
  const items = [
    { ...base, key: "Количество полюсов", value: "1", unit: "", source_span: "Обязательны: количество полюсов — 1." },
    { ...base, key: "Номинальный ток", value: "25", unit: "А", source_span: "Обязательны: номинальный ток — 25 А." },
    { ...base, key: "Характеристика срабатывания", value: "C", unit: "", source_span: "Обязательны: характеристика срабатывания — C." },
  ];
  const result = resolveReasoningObligations(items, source);
  assertEquals(result.unresolved, []);
  assertEquals(result.obligations.map((obligation) => obligation.sourceSpan), [source, source, source]);
  assertEquals(result.obligations[1].criterion.value, 25);
  assertEquals(resolveReasoningObligations([{ ...items[1], value: "16" }], source).unresolved.length, 1);
  assertEquals(resolveReasoningObligations([{ ...items[1], unit: "Вт" }], source).unresolved.length, 1);
  assertEquals(resolveReasoningObligations([{ ...items[1], op: "min" }], source).unresolved.length, 1);
  assertEquals(resolveReasoningObligations([{ ...items[1], key: "Сечение кабеля" }], source).unresolved.length, 1);
  assertEquals(resolveReasoningObligations([{ ...items[1], source_span: "Обязательны: номинальная мощность — 25 А." }], source).unresolved.length, 1);
  assertEquals(resolveReasoningObligations([items[1]], `${source} ${source}`).unresolved.length, 1);
  const twoCurrents = "Обязательны: номинальный ток — 25 А, пусковой ток — 16 А.";
  assertEquals(resolveReasoningObligations([items[1]], twoCurrents).unresolved, []);
});

Deno.test("enumerated quote attribution fails closed on same-key conflict or sentence-wide drift", () => {
  const item = { key: "Номинальный ток", op: "eq", value: "25", unit: "А", scope: "per_product", source_span: "Обязательны: номинальный ток — 25 А." };
  for (const source of [
    "Обязательны: количество полюсов — 1, номинальный ток — 25 А, номинальный ток — 16 А.",
    "Обязательны: количество полюсов — 1, номинальный ток — 25 А, но это не обязательное требование.",
    "Обязательны: количество полюсов — 1, номинальный ток — 25 А, характеристика C желательна.",
    "Обязательны: количество полюсов — 1, номинальный ток — 25 А или 16 А.",
    "Желательны: количество полюсов — 1, номинальный ток — 25 А.",
  ]) {
    assertEquals(resolveReasoningObligations([item], source).unresolved.length, 1, source);
  }
});

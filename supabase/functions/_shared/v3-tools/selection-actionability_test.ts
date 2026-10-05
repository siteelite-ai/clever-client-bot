import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { compileMeasuredReasoningSearchContract } from "./criteria-reasoning.ts";
import { applyCriteriaGate } from "./criteria-gate.ts";
import {
  aggregateSelectionClarification,
  buildDerivedReasoningSearch,
  buildDerivedSelectionReasoningMessages,
  buildDerivedSelectionReasoningToolSchema,
  derivedCorrectionPreservesRequirements,
  derivedMeasurementMayConstrainIndividualProducts,
  hasActionableSelectionContract,
  hasCompetingMeasuredSelectionTiers,
  hasSelectionMeasurementContext,
  hasSelectionSuitabilityContext,
  measuredSelectionContractEvidence,
  reasoningComputesSystemTotalFromSpatialExtent,
  resolveDerivedSelectionReasoning,
  shouldContinueSelectionPastOptionalClarification,
  shouldFinalizeDerivedSelectionSearch,
  shouldProjectDerivedScalarMeasurement,
  shouldQueueDirectCustomerFacetSearch,
  shouldRequireDerivedSelectionReasoning,
  systemTotalReasoningDeclaresPerProductMeasurement,
  validatedPerProductMeasurementEvidence,
} from "./selection-actionability.ts";

Deno.test("an unresolved prerequisite is a clarification outcome, never a partial search contract", () => {
  const result = resolveDerivedSelectionReasoning({
    reasoning:
      "Исполнение зависит от условий подключения, которые пока не указаны.",
    clarification_question: "Какая схема подключения у оборудования?",
    measurement_scope: "per_product",
    retrieval_query: "изделие",
    required_facet_values: ["f0v0"],
    compatible_classifications: [],
    excluded_classifications: [],
  }, [{
    key: "count",
    caption: "Количество элементов",
    values: [{ value: "3" }, { value: "4" }],
  }], "Нужно изделие для оборудования");
  assertEquals(result?.clarification?.freeform, true);
  assertEquals(
    result?.clarification?.question,
    "Какая схема подключения у оборудования?",
  );
  assertEquals(result?.measurementEvidence, "");
  assertEquals(result?.requiredFacetValues, []);
  assertEquals(result?.retrievalQuery, null);
});

Deno.test("a sufficient selection with an empty clarification preserves the existing path", () => {
  const result = resolveDerivedSelectionReasoning({
    reasoning:
      "Нужен трехэлементный вариант для уже указанной схемы подключения.",
    clarification_question: "",
    measurement_scope: "not_applicable",
    required_facet_values: ["f0v0"],
    compatible_classifications: [],
    excluded_classifications: [],
  }, [{
    key: "count",
    caption: "Количество элементов",
    values: [{ value: "3" }, { value: "4" }],
  }], "Нужно трехэлементное изделие");
  assertEquals(result?.clarification, undefined);
  assertEquals(result?.requiredFacetValues, [{
    key: "Количество элементов",
    value: "3",
  }]);
});

Deno.test("numeric correction cannot erase validated qualitative or customer-owned requirements", () => {
  const prior = {
    requiredFacetValues: [{ key: "Защита", value: "IP65" }],
    customerGroundedCompatible: [{ key: "Исполнение", value: "A" }],
    customerGroundedExcluded: [{ key: "Материал", value: "B" }],
  };
  assertEquals(derivedCorrectionPreservesRequirements(prior, prior), true);
  assertEquals(
    derivedCorrectionPreservesRequirements(prior, {
      ...prior,
      requiredFacetValues: [],
    }),
    false,
  );
  assertEquals(
    derivedCorrectionPreservesRequirements(prior, {
      ...prior,
      customerGroundedCompatible: [],
    }),
    false,
  );
  assertEquals(
    derivedCorrectionPreservesRequirements(prior, {
      ...prior,
      customerGroundedExcluded: [],
    }),
    false,
  );
  assertEquals(
    derivedCorrectionPreservesRequirements(prior, {
      ...prior,
      requiredFacetValues: [...prior.requiredFacetValues, {
        key: "Порог",
        value: "20",
      }],
    }),
    true,
  );
});

Deno.test("aggregate-only selection clarifies configuration and preserves a single-item choice", () => {
  const question = aggregateSelectionClarification("system_total", "");
  assertEquals(question?.options.length, 2);
  assertEquals(aggregateSelectionClarification("per_product", ""), null);
  assertEquals(
    aggregateSelectionClarification(
      "system_total",
      "Каждое изделие должно иметь не менее 4000 лм.",
    ),
    null,
  );
  const args = {
    reasoning: "Для площади 120 м² расчёт: 120 м² × 25 лк = 3000 лм.",
    measurement_scope: "system_total",
  };
  assertEquals(
    resolveDerivedSelectionReasoning(
      args,
      [],
      "Площадь 120 м². Несколько вариантов.",
    )?.measurementScope,
    "system_total",
  );
  assertEquals(
    resolveDerivedSelectionReasoning(
      args,
      [],
      `Площадь 120 м²\nУточнение клиента: ${question!.options[0].value}`,
    )?.measurementScope,
    "per_product",
  );
  assertEquals(
    resolveDerivedSelectionReasoning(
      args,
      [],
      "Площадь 120 м²\nУточнение клиента: Не нужно одно изделие для всей задачи",
    )?.measurementScope,
    "system_total",
  );
});

Deno.test("per-item evidence is a visible bounded span, never the aggregate calculation", () => {
  const perItem =
    "Каждое изделие должно иметь световой поток не менее 4000 лм.";
  const reasoning = `Общий расчёт: 120 м² × 25 лк = 3000 лм. ${perItem}`;
  assertEquals(
    validatedPerProductMeasurementEvidence(reasoning, perItem),
    perItem,
  );
  assertEquals(
    validatedPerProductMeasurementEvidence(
      reasoning,
      "Каждое изделие должно иметь 9000 лм.",
    ),
    "",
  );
  assertEquals(
    validatedPerProductMeasurementEvidence(reasoning, reasoning),
    "",
  );
  assertEquals(
    validatedPerProductMeasurementEvidence(
      "Всего 5000 лм, распределить на каждый товар.",
      "Всего 5000 лм, распределить на каждый товар.",
    ),
    "",
  );
  assertEquals(
    validatedPerProductMeasurementEvidence(
      "Каждый вариант подходит.",
      "Каждый вариант подходит.",
    ),
    "",
  );
  assertEquals(
    derivedMeasurementMayConstrainIndividualProducts("system_total", perItem),
    true,
  );
  assertEquals(
    derivedMeasurementMayConstrainIndividualProducts("system_total", reasoning),
    false,
  );
  assertEquals(
    shouldProjectDerivedScalarMeasurement(
      "Площадь 120 м²",
      perItem,
      "system_total",
    ),
    true,
  );
});

Deno.test("a mixed declaration compiles only the separate per-product requirement", () => {
  const perItem =
    "Каждое изделие должно иметь световой поток не менее 4000 лм.";
  const reasoning =
    `Для площади 120 м² расчёт: 120 м² × 25 лк = 3000 лм. ${perItem}`;
  const args = {
    reasoning,
    measurement_scope: "per_product",
    per_product_measurement_evidence: perItem,
  };
  const declaration = resolveDerivedSelectionReasoning(
    args,
    [],
    "Площадь 120 м²",
  );
  assertEquals(declaration?.measurementScope, "system_total");
  assertEquals(declaration?.measurementEvidence, perItem);
  assertEquals(declaration?.text.includes(reasoning), true);
  const compiled = compileMeasuredReasoningSearchContract(
    [],
    declaration!.measurementEvidence,
    [],
    [{
      key: "flux",
      caption: "Световой поток",
      type: "checkbox",
      unit: "лм",
      values: [{ value: "3000" }, { value: "4000" }, { value: "5000" }],
    }],
  );
  const checked = applyCriteriaGate(
    [3000, 4000, 5000].map((value) => ({
      id: String(value),
      pagetitle: "Изделие",
      vendor: null,
      price: 100,
      stock: "unknown" as const,
      short_traits: [`Световой поток: ${value} лм`],
    })),
    compiled.mandatory_criteria,
  );
  assertEquals(checked.passed_ids, ["4000", "5000"]);
  assertEquals(
    resolveDerivedSelectionReasoning(
      { ...args, per_product_measurement_evidence: "" },
      [],
      "Площадь 120 м²",
    )?.measurementEvidence,
    "",
  );
});

Deno.test("visible product type survives simultaneous numeric facet projection", () => {
  const search = buildDerivedReasoningSearch({
    compoundQuery: null,
    retrievalQuery: "коаксиальный кабель",
    options: { diameter: { min: 0.5 } },
    categoryScope: { category: "Кабель и провод" },
    measurementScope: "per_product",
    scalarProjectionAllowed: true,
  });
  assertEquals(search, {
    mode: "by_query",
    query: "коаксиальный кабель",
    category: "Кабель и провод",
    options: { diameter: { min: 0.5 } },
    per_page: 50,
  });
});

Deno.test("exact compound search still precedes general retrieval wording", () => {
  const search = buildDerivedReasoningSearch({
    compoundQuery: "3*2,5",
    retrievalQuery: "силовой кабель",
    options: {},
    categoryScope: { category: "Кабель" },
    measurementScope: "per_product",
    scalarProjectionAllowed: true,
  });
  assertEquals(search?.query, "3*2,5");
  assertEquals(search?.mode, "by_query");
});

Deno.test("numeric-only search and unresolved reasoning keep their existing contracts", () => {
  const input = {
    compoundQuery: null,
    retrievalQuery: null,
    options: { power: "20" },
    categoryScope: { category: "Светильники" },
    measurementScope: "per_product" as const,
    scalarProjectionAllowed: true,
  };
  assertEquals(buildDerivedReasoningSearch(input), {
    mode: "by_filter",
    options: { power: "20" },
    per_page: 50,
  });
  assertEquals(buildDerivedReasoningSearch({ ...input, options: {} }), null);
});

Deno.test("a system total may separately declare one per-product range", () => {
  const reasoning =
    "Суммарно нужно не менее 5000 лм. Рекомендуется несколько изделий мощностью 20–50 Вт каждый.";
  assertEquals(
    systemTotalReasoningDeclaresPerProductMeasurement(reasoning),
    true,
  );
  assertEquals(
    shouldProjectDerivedScalarMeasurement(
      "Площадь 500 м²",
      reasoning,
      "system_total",
    ),
    true,
  );
  assertEquals(
    shouldProjectDerivedScalarMeasurement(
      "Площадь 500 м²",
      "Суммарно нужно не менее 5000 лм, распределить между несколькими изделиями.",
      "system_total",
    ),
    false,
  );
});

Deno.test("one sentence cannot leave minimum and recommended measured tiers unresolved", () => {
  assertEquals(
    hasCompetingMeasuredSelectionTiers(
      "Требуется сечение не менее 1,5 мм², однако для запаса рекомендуется 2,5 мм².",
    ),
    true,
  );
  assertEquals(
    hasCompetingMeasuredSelectionTiers(
      "Требуется сечение не менее 2,5 мм². Рекомендуется кабель с защитной оболочкой.",
    ),
    false,
  );
});

Deno.test("two independent measured axes make a selection actionable", () => {
  assertEquals(
    hasActionableSelectionContract("нужно 40 Вт и поток 4000 лм"),
    true,
  );
});

Deno.test("two-sided fit reasoning with one unit makes a selection actionable", () => {
  assertEquals(
    hasActionableSelectionContract(
      "объект 12 мм: изделие должно быть больше 12 мм до преобразования и меньше 12 мм после него",
    ),
    true,
  );
});

Deno.test("an isolated measurement may still require an objective clarification", () => {
  assertEquals(hasActionableSelectionContract("нужен размер 12 мм"), false);
});

Deno.test("an unprojected physical context requires reasoning before catalog search", () => {
  assertEquals(
    hasSelectionMeasurementContext("Нужно решение для комнаты 25 м²"),
    true,
  );
  assertEquals(
    hasSelectionMeasurementContext("Нужно 3 штуки через 2 дня"),
    false,
  );
  assertEquals(
    hasSelectionMeasurementContext("Нужно не дороже 4000 тенге"),
    false,
  );
  assertEquals(hasSelectionMeasurementContext("Бюджет 4000 тг"), false);
  assertEquals(
    hasSelectionMeasurementContext(
      "Найди однополюсный автомат C16 не дороже 1 000 тенге",
    ),
    false,
  );
  assertEquals(
    shouldRequireDerivedSelectionReasoning({
      intentMode: "select",
      phase: "search_after_discovery",
      catalogSearchAttempted: false,
      directMeasuredCriteriaCount: 0,
      userMessage:
        "Хочу заменить устройство для помещения 25 м². Что подойдет?",
      reasoningText: "",
    }),
    true,
  );
});

Deno.test("an unresolved application context requires suitability reasoning even when another measurement maps directly", () => {
  const message =
    "Нужен уличный удлинитель 30 м для сварочного аппарата. Подбери варианты";
  assertEquals(hasSelectionSuitabilityContext(message), true);
  assertEquals(
    hasSelectionSuitabilityContext("Покажи удлинитель длиной 30 м"),
    false,
  );
  assertEquals(
    shouldRequireDerivedSelectionReasoning({
      intentMode: "select",
      phase: "search_after_discovery",
      catalogSearchAttempted: false,
      directMeasuredCriteriaCount: 1,
      directApplicationCriteriaCount: 0,
      userMessage: message,
      reasoningText: "",
    }),
    true,
  );
});

Deno.test("an adjacent suitability modifier requires reasoning when no live facet proves it", () => {
  const message = "Подбери несколько недорогих офисных светильников";
  assertEquals(hasSelectionSuitabilityContext(message, "Светильники"), true);
  assertEquals(
    shouldRequireDerivedSelectionReasoning({
      intentMode: "select",
      phase: "search_after_discovery",
      catalogSearchAttempted: false,
      directMeasuredCriteriaCount: 0,
      directApplicationCriteriaCount: 0,
      productClass: "Светильники",
      userMessage: message,
      reasoningText: "",
    }),
    true,
  );
});

Deno.test("a live application facet or an existing suitability contract avoids a redundant reasoning detour", () => {
  const message = "Подберите светильник для офиса";
  const base = {
    intentMode: "select" as const,
    phase: "search_after_discovery",
    catalogSearchAttempted: false,
    directMeasuredCriteriaCount: 0,
    userMessage: message,
  };
  assertEquals(
    shouldRequireDerivedSelectionReasoning({
      ...base,
      directApplicationCriteriaCount: 1,
      reasoningText: "",
    }),
    false,
  );
  assertEquals(
    shouldRequireDerivedSelectionReasoning({
      ...base,
      directApplicationCriteriaCount: 0,
      reasoningText: "Требуется мощность не менее 40 Вт и ток не менее 10 А",
    }),
    false,
  );
});

Deno.test("direct live projection or prior derivation does not add a reasoning detour", () => {
  const base = {
    intentMode: "select" as const,
    phase: "search_after_discovery",
    catalogSearchAttempted: false,
    directMeasuredCriteriaCount: 1,
    userMessage: "Нужно устройство 16 А",
    reasoningText: "",
  };
  assertEquals(shouldRequireDerivedSelectionReasoning(base), false);
  assertEquals(
    shouldRequireDerivedSelectionReasoning({
      ...base,
      directMeasuredCriteriaCount: 0,
      reasoningText: "Нужно не менее 40 Вт и поток от 4000 лм",
    }),
    false,
  );
  assertEquals(
    shouldRequireDerivedSelectionReasoning({
      ...base,
      intentMode: "inquire",
      directMeasuredCriteriaCount: 0,
    }),
    false,
  );
});

Deno.test("visible derived reasoning cannot be replaced by hidden later tool prose", () => {
  assertEquals(
    measuredSelectionContractEvidence(
      "Публичный расчёт: 5000–7500 лм",
      "Публичный расчёт: 5000–7500 лм\nСкрытая поздняя версия: 3750–5000 лм",
    ),
    "Публичный расчёт: 5000–7500 лм",
  );
  assertEquals(
    measuredSelectionContractEvidence("", "Первичное рассуждение 40 Вт"),
    "Первичное рассуждение 40 Вт",
  );
});

Deno.test("a proven server-issued structured search routes directly to deterministic finalization", () => {
  const base = {
    expectedToolCallId: "derived-1",
    actualToolCallId: "derived-1",
    toolName: "search_catalog",
    searchOk: true,
    candidateCount: 7,
    provenCriteriaCount: 3,
  };
  assertEquals(shouldFinalizeDerivedSelectionSearch(base), true);
  assertEquals(
    shouldFinalizeDerivedSelectionSearch({
      ...base,
      actualToolCallId: "model-search",
    }),
    false,
  );
  assertEquals(
    shouldFinalizeDerivedSelectionSearch({ ...base, candidateCount: 0 }),
    false,
  );
  assertEquals(
    shouldFinalizeDerivedSelectionSearch({ ...base, provenCriteriaCount: 0 }),
    false,
  );
  assertEquals(
    shouldFinalizeDerivedSelectionSearch({
      ...base,
      provenCriteriaCount: 0,
      pairedCompatibilityRequired: true,
    }),
    true,
  );
  assertEquals(
    shouldFinalizeDerivedSelectionSearch({
      ...base,
      provenCriteriaCount: 0,
      guidedByVisibleReasoning: true,
    }),
    true,
  );
  assertEquals(
    shouldFinalizeDerivedSelectionSearch({ ...base, searchOk: false }),
    false,
  );
});

Deno.test("a complete customer-owned live facet contract skips a redundant model decision", () => {
  const base = {
    intentMode: "select" as const,
    hasSelectionTarget: true,
    replacementIntent: false,
    namedSeriesRequiresGrounding: false,
    broadAssortmentRequest: false,
    derivedReasoningRequired: false,
    exactCompoundEvidenceRequired: false,
    projectedOptionCount: 3,
    mandatoryUserCriteriaCount: 3,
    unmatchedUserCriteriaCount: 0,
    unresolvedLexicalQualifier: false,
  };
  assertEquals(shouldQueueDirectCustomerFacetSearch(base), true);
  assertEquals(
    shouldQueueDirectCustomerFacetSearch({ ...base, replacementIntent: true }),
    false,
  );
  assertEquals(
    shouldQueueDirectCustomerFacetSearch({
      ...base,
      derivedReasoningRequired: true,
    }),
    false,
  );
  assertEquals(
    shouldQueueDirectCustomerFacetSearch({
      ...base,
      unmatchedUserCriteriaCount: 1,
    }),
    false,
  );
  assertEquals(
    shouldQueueDirectCustomerFacetSearch({
      ...base,
      broadAssortmentRequest: true,
    }),
    false,
  );
  assertEquals(
    shouldQueueDirectCustomerFacetSearch({
      ...base,
      unresolvedLexicalQualifier: true,
    }),
    false,
  );
});

Deno.test("two-sided fit reasoning cannot be projected as one scalar product measurement", () => {
  assertEquals(
    shouldProjectDerivedScalarMeasurement(
      "Нужно изделие для объекта 10 мм",
      "До установки внутренний размер должен быть больше 10 мм, а после преобразования — меньше 10 мм.",
    ),
    false,
  );
  assertEquals(
    shouldProjectDerivedScalarMeasurement(
      "Нужно изделие для помещения 25 м²",
      "Расчётный показатель товара должен быть от 3750 до 5000 лм.",
    ),
    true,
  );
});

Deno.test("a declared system total cannot become a scalar product filter", () => {
  assertEquals(
    shouldProjectDerivedScalarMeasurement(
      "Нужно решение для комнаты 25 м²",
      "Расчёт даёт световой поток не менее 3750 лм.",
      "system_total",
    ),
    false,
  );
  assertEquals(
    shouldProjectDerivedScalarMeasurement(
      "Нужно изделие",
      "Каждое изделие должно иметь параметр не менее 3750 лм.",
      "per_product",
    ),
    true,
  );
  assertEquals(
    derivedMeasurementMayConstrainIndividualProducts("system_total"),
    false,
  );
  assertEquals(
    derivedMeasurementMayConstrainIndividualProducts("per_product"),
    true,
  );
});

Deno.test("an ungrounded execution variant is not offered as an application classification", () => {
  const facets = [{
    caption: "Модель или исполнение",
    type: "string",
    values: [{ value: "Первый вариант" }, { value: "Второй вариант" }],
  }];
  const schema = buildDerivedSelectionReasoningToolSchema(facets);
  const properties = schema.function.parameters.properties as Record<
    string,
    { items?: { maxLength?: number } }
  >;
  assertEquals(properties.compatible_classifications.items?.maxLength, 0);
  assertEquals(
    resolveDerivedSelectionReasoning({
      reasoning: "Расчёт даёт обязательный диапазон от 10 до 20 единиц.",
      compatible_classifications: ["f0v0"],
      excluded_classifications: [],
    }, facets)?.compatible,
    [],
  );
});

Deno.test("derived reasoning prompt is compact and treats the live schema as untrusted data", () => {
  const messages = buildDerivedSelectionReasoningMessages(
    "Что подойдет для 25 м²?",
    "Ветка <script>alert(1)</script>",
    [
      {
        caption: "Параметр",
        type: "number",
        unit: "лм",
        values: [{ value: "<hidden-option>" }],
      },
      {
        caption: "Вид исполнения",
        type: "string",
        unit: null,
        values: [{ value: "<option>" }],
      },
    ],
  );
  assertEquals(messages.length, 2);
  assertEquals(messages[0].content.includes("недоверенные данные"), true);
  assertEquals(
    messages[0].content.includes(
      "Класс товара, прямо названный клиентом, неизменяем",
    ),
    true,
  );
  assertEquals(
    messages[0].content.includes(
      "качественные требования совместимости или безопасности",
    ),
    true,
  );
  assertEquals(
    messages[0].content.includes("живых категориальных значений"),
    true,
  );
  assertEquals(
    messages[0].content.includes("строгий порог доказательства"),
    true,
  );
  assertEquals(
    messages[0].content.includes("неопределёнными, а не несовместимыми"),
    true,
  );
  assertEquals(
    messages[0].content.includes("Никогда не выдумывай жёсткий максимум"),
    true,
  );
  assertEquals(
    messages[0].content.includes(
      "промежуточный расчёт — например, ток из мощности — не завершает подбор",
    ),
    true,
  );
  assertEquals(messages[0].content.includes("required_facet_values"), true);
  assertEquals(messages[0].content.includes("clarification_question"), true);
  assertEquals(
    messages[0].content.includes("не задавай уточняющий вопрос"),
    false,
  );
  assertEquals(messages[1].content.includes("<script>"), false);
  assertEquals(messages[1].content.includes("\\u003cscript>"), true);
  assertEquals(messages[1].content.includes("\\u003coption>"), true);
  assertEquals(messages[1].content.includes("hidden-option"), false);
});

Deno.test("derived reasoning exposes bounded technical values but not identity or boolean metadata", () => {
  const schema = buildDerivedSelectionReasoningToolSchema([
    {
      key: "element_count",
      caption: "Количество элементов",
      values: [{ value: "2" }, { value: "3" }, { value: "4" }],
    },
    {
      key: "vendor",
      caption: "Бренд",
      values: [{ value: "ACME" }, { value: "OTHER" }],
    },
    {
      key: "popular",
      caption: "Популярный",
      values: [{ value: "0" }, { value: "1" }],
    },
  ]);
  const properties = (schema.function.parameters.properties ?? {}) as Record<
    string,
    {
      items?: { enum?: string[]; maxLength?: number };
    }
  >;
  assertEquals(properties.required_facet_values.items?.enum, [
    "f0v0",
    "f0v1",
    "f0v2",
  ]);
  assertEquals(
    (schema.function.parameters.required as string[]).includes(
      "required_facet_values",
    ),
    true,
  );
});

Deno.test("a decimal live scalar cannot become customer-owned from one matching integer", () => {
  const facets = [{
    key: "weight",
    caption: "Вес",
    values: [{ value: "3.4" }, { value: "4.5" }],
  }];
  const declaration = resolveDerivedSelectionReasoning(
    {
      reasoning: "Для нагрузки 3 кВт рекомендую исполнение 3×4 или 3×2,5.",
      compatible_classifications: [],
      excluded_classifications: [],
      required_facet_values: ["f0v0"],
    },
    facets,
    "Нужен кабель для кондиционера мощностью 3 кВт",
  );
  assertEquals(declaration?.requiredFacetValues, []);
  const schema = buildDerivedSelectionReasoningToolSchema(
    facets,
    "Нагрузка 3 кВт",
  );
  const properties = schema.function.parameters.properties as Record<
    string,
    { items?: { enum?: string[] } }
  >;
  assertEquals(
    properties.required_facet_values.items?.enum?.includes("f0v0") ?? false,
    false,
  );
});

Deno.test("numeric inequality labels require the matching physical unit, not matching digits", () => {
  const facets = [{
    key: "rated_voltage",
    caption: "Номинальное напряжение, кВ",
    unit: null,
    values: [{ value: "≤ 10" }, { value: "≥ 20" }, { value: "10–20" }],
  }];
  const schema = buildDerivedSelectionReasoningToolSchema(
    facets,
    "Линия длиной 10 метров",
  );
  const properties = schema.function.parameters.properties as Record<
    string,
    { items?: { enum?: string[] } }
  >;
  assertEquals(properties.required_facet_values.items?.enum ?? [], []);
  const declaration = resolveDerivedSelectionReasoning(
    {
      reasoning:
        "Для линии длиной 10 метров требуется кабель номинальным напряжением ≤ 10 кВ.",
      required_facet_values: ["f0v0"],
      compatible_classifications: [],
      excluded_classifications: [],
    },
    facets,
    "Линия длиной 10 метров",
  );
  assertEquals(declaration?.requiredFacetValues, []);
});

Deno.test("customer-scoped reasoning schema omits unrelated exact technical values", () => {
  const schema = buildDerivedSelectionReasoningToolSchema([
    {
      key: "size",
      caption: "Размер",
      values: [{ value: "0,75" }, { value: "1,5" }, { value: "3000" }],
    },
    {
      key: "socket",
      caption: "Исполнение",
      values: [{ value: "E14" }, { value: "E27" }],
    },
  ], "Нужно исполнение E27 со значением 3000 K");
  const properties = (schema.function.parameters.properties ?? {}) as Record<
    string,
    {
      items?: { enum?: string[]; maxLength?: number };
    }
  >;
  assertEquals(properties.required_facet_values.items?.enum, [
    "f0v2",
    "f1v0",
    "f1v1",
  ]);
  assertEquals(
    (schema.function.parameters.required as string[]).includes(
      "measurement_scope",
    ),
    true,
  );
});

Deno.test("a currency ceiling cannot expose the same bare technical scalar", () => {
  const schema = buildDerivedSelectionReasoningToolSchema([{
    key: "insulation_voltage",
    caption: "Номинальное напряжение изоляции, В",
    type: "checkbox",
    unit: null,
    values: [{ value: "500" }, { value: "1000" }],
  }], "Найди аппарат до 1000 тенге");
  const properties = (schema.function.parameters.properties ?? {}) as Record<
    string,
    { items?: { enum?: string[]; maxLength?: number } }
  >;
  assertEquals(properties.required_facet_values.items?.enum, undefined);
  assertEquals(properties.required_facet_values.items?.maxLength, 0);
});

Deno.test("a spatial value cannot own an equal scalar from another unit axis", () => {
  const schema = buildDerivedSelectionReasoningToolSchema([
    {
      key: "length",
      caption: "Длина, мм",
      values: [{ value: "25" }, { value: "35" }, { value: "50" }],
    },
    {
      key: "temperature",
      caption: "Диапазон рабочих температур",
      values: [
        { value: "от -35 до +40 °С" },
        { value: "от -20 до +30 °С" },
      ],
    },
  ], "Площадь 35 м², высота установки 1,5 м");
  const properties = (schema.function.parameters.properties ?? {}) as Record<
    string,
    { items?: { enum?: string[]; maxLength?: number } }
  >;
  assertEquals(properties.required_facet_values.items?.enum, undefined);
  assertEquals(properties.required_facet_values.items?.maxLength, 0);
});

Deno.test("a model-derived exact value requires visible facet context", () => {
  const facets = [{
    key: "body_colour",
    caption: "Цвет корпуса",
    values: [{ value: "белый" }, { value: "черный" }],
  }];
  const unrelated = resolveDerivedSelectionReasoning(
    {
      reasoning: "Для задачи подходит холодный белый свет.",
      measurement_scope: "not_applicable",
      compatible_classifications: [],
      excluded_classifications: [],
      required_facet_values: ["f0v0"],
      explicit_customer_classifications: [],
    },
    facets,
    "Нужен вариант для улицы",
  );
  assertEquals(unrelated?.requiredFacetValues, []);

  const grounded = resolveDerivedSelectionReasoning(
    {
      reasoning: "Цвет корпуса должен быть белый.",
      measurement_scope: "not_applicable",
      compatible_classifications: [],
      excluded_classifications: [],
      required_facet_values: ["f0v0"],
      explicit_customer_classifications: [],
    },
    facets,
    "Нужен вариант для улицы",
  );
  assertEquals(grounded?.requiredFacetValues, [{
    key: "Цвет корпуса",
    value: "белый",
  }]);
});

Deno.test("a visible same-facet alternative cannot become one mandatory exact value", () => {
  const facets = [{
    key: "shell",
    caption: "Оболочка",
    values: [{ value: "ПВХ" }, { value: "полиэтилен" }],
  }];
  const alternative = resolveDerivedSelectionReasoning(
    {
      reasoning:
        "Для среды нужна стойкая оболочка: подходят ПВХ или полиэтилен.",
      measurement_scope: "not_applicable",
      compatible_classifications: [],
      excluded_classifications: [],
      required_facet_values: ["f0v1"],
      explicit_customer_classifications: [],
    },
    facets,
    "Нужен вариант для наружной установки",
  );
  assertEquals(alternative?.requiredFacetValues, []);
  assertEquals(alternative?.text.includes("Обязательные параметры"), false);

  const unique = resolveDerivedSelectionReasoning(
    {
      reasoning: "Для среды обязательна оболочка из полиэтилена.",
      measurement_scope: "not_applicable",
      compatible_classifications: [],
      excluded_classifications: [],
      required_facet_values: ["f0v1"],
      explicit_customer_classifications: [],
    },
    facets,
    "Нужен вариант для наружной установки",
  );
  assertEquals(unique?.requiredFacetValues, [{
    key: "Оболочка",
    value: "полиэтилен",
  }]);
});

Deno.test("a structured ID cannot collapse a derived numeric range to one exact value", () => {
  const facets = [{
    key: "section",
    caption: "Сечение кабеля, мм2",
    unit: "мм²",
    values: [{ value: "0.5" }, { value: "0.75" }, { value: "1" }],
  }];
  const derived = resolveDerivedSelectionReasoning(
    {
      reasoning: "Для задачи подходит сечение кабеля от 0,5 до 1 мм².",
      measurement_scope: "per_product",
      compatible_classifications: [],
      excluded_classifications: [],
      required_facet_values: ["f0v0"],
      explicit_customer_classifications: [],
    },
    facets,
    "Длина линии 30 метров",
  );
  assertEquals(derived?.requiredFacetValues, []);

  const customerExact = resolveDerivedSelectionReasoning(
    {
      reasoning: "Требуется сечение кабеля 0,5 мм².",
      measurement_scope: "per_product",
      compatible_classifications: [],
      excluded_classifications: [],
      required_facet_values: ["f0v0"],
      explicit_customer_classifications: [],
    },
    facets,
    "Нужно сечение кабеля 0,5 мм²",
  );
  assertEquals(customerExact?.requiredFacetValues, [{
    key: "Сечение кабеля, мм2",
    value: "0.5",
  }]);
});

Deno.test("opaque live-schema IDs are removed from customer-visible reasoning", () => {
  const resolved = resolveDerivedSelectionReasoning(
    {
      reasoning:
        "Нужны количество полюсов = 1 (f5v2), номинальный ток = 16 А f9v2.",
      measurement_scope: "per_product",
      compatible_classifications: [],
      excluded_classifications: [],
      required_facet_values: [],
      explicit_customer_classifications: [],
    },
    [],
    "Нужен автомат 1 полюс, 16 А",
  );
  assertEquals(resolved?.text.includes("f5v2"), false);
  assertEquals(resolved?.text.includes("f9v2"), false);
  assertEquals(resolved?.text.includes("количество полюсов = 1"), true);
});

Deno.test("system-total reasoning is visibly marked and cannot masquerade as one-product evidence", () => {
  const resolved = resolveDerivedSelectionReasoning(
    {
      reasoning:
        "Для объекта расчёт даёт 75000 лм при принятой норме освещённости.",
      measurement_scope: "system_total",
      compatible_classifications: [],
      excluded_classifications: [],
      required_facet_values: [],
      explicit_customer_classifications: [],
    },
    [],
    "Нужно несколько изделий для объекта 500 м²",
  );

  assertEquals(resolved?.measurementScope, "system_total");
  assertEquals(
    resolved?.text.includes("суммарная потребность всей системы"),
    true,
  );
  // Aggregate prose remains visible but is not numeric card evidence.
  assertEquals(resolved?.measurementEvidence, "");
});

Deno.test("system total drops a derived per-card measurement", () => {
  const facets = [
    {
      key: "flux",
      caption: "Световой поток",
      type: "checkbox",
      unit: null,
      values: [{ value: "5250 Лм" }, { value: "7000 Лм" }],
    },
    {
      key: "protection",
      caption: "Степень защиты IP",
      type: "checkbox",
      unit: null,
      values: [{ value: "IP44" }, { value: "IP65" }],
    },
  ];
  const resolved = resolveDerivedSelectionReasoning(
    {
      reasoning:
        "Для объекта нужен суммарный световой поток 7000 лм, а каждое изделие должно иметь степень защиты IP65.",
      measurement_scope: "system_total",
      compatible_classifications: [],
      excluded_classifications: [],
      required_facet_values: ["f0v1", "f1v1"],
      explicit_customer_classifications: [],
    },
    facets,
    "Нужно несколько изделий для объекта площадью 35 м²",
  );

  assertEquals(resolved?.measurementScope, "system_total");
  assertEquals(
    resolved?.requiredFacetValues.some(({ key }) => key === "Световой поток"),
    false,
  );
  assertEquals(
    resolved?.requiredFacetValues.some(({ key, value }) =>
      key === "Степень защиты IP" && value === "IP65"
    ),
    true,
  );
  const perProduct = resolveDerivedSelectionReasoning(
    {
      reasoning:
        "Для объекта нужен световой поток каждого изделия 7000 лм, а каждое изделие должно иметь степень защиты IP65.",
      measurement_scope: "per_product",
      compatible_classifications: [],
      excluded_classifications: [],
      required_facet_values: ["f0v1", "f1v1"],
      explicit_customer_classifications: [],
    },
    facets,
    "Нужно несколько изделий для объекта площадью 35 м²",
  );
  assertEquals(
    perProduct?.requiredFacetValues.some(({ key, value }) =>
      key === "Световой поток" && value === "7000 Лм"
    ),
    true,
  );
});

Deno.test("a spatial calculation cannot masquerade as one-product evidence", () => {
  const customer =
    "Нужен светодиодный светильник для гостиной площадью 25 кв. м";
  const reasoning =
    "Световой поток = 25 м² × 150 лк = 3750 лм. Нужен поток не менее 3750 лм.";
  assertEquals(
    reasoningComputesSystemTotalFromSpatialExtent(customer, reasoning),
    true,
  );
  assertEquals(
    reasoningComputesSystemTotalFromSpatialExtent(
      "Нужен кабель длиной 25 м",
      "25 м × 2 = 50 м кабеля.",
    ),
    false,
  );

  const resolved = resolveDerivedSelectionReasoning(
    {
      reasoning,
      measurement_scope: "per_product",
      compatible_classifications: [],
      excluded_classifications: [],
      required_facet_values: [],
      explicit_customer_classifications: [],
    },
    [],
    customer,
  );
  assertEquals(resolved?.measurementScope, "system_total");
  assertEquals(
    resolved?.text.includes("суммарная потребность всей системы"),
    true,
  );
});

Deno.test("a retrieval query is accepted only when it is already visible in reasoning", () => {
  const visible = resolveDerivedSelectionReasoning({
    reasoning:
      "Для указанного применения нужен экранированный сигнальный кабель с подходящим диапазоном температур.",
    measurement_scope: "not_applicable",
    retrieval_query: "экранированный сигнальный кабель",
    compatible_classifications: [],
    excluded_classifications: [],
    required_facet_values: [],
    explicit_customer_classifications: [],
  }, []);
  assertEquals(visible?.retrievalQuery, "экранированный сигнальный кабель");

  const hidden = resolveDerivedSelectionReasoning({
    reasoning: "Для указанного применения нужен подходящий вариант.",
    measurement_scope: "not_applicable",
    retrieval_query: "скрытый соседний класс",
    compatible_classifications: [],
    excluded_classifications: [],
    required_facet_values: [],
    explicit_customer_classifications: [],
  }, []);
  assertEquals(hidden?.retrievalQuery, null);
});

Deno.test("an exact technical ID becomes required only when visible reasoning states it", () => {
  const facets = [{
    key: "element_count",
    caption: "Количество элементов",
    values: [{ value: "2" }, { value: "3" }, { value: "4" }],
  }];
  const resolved = resolveDerivedSelectionReasoning(
    {
      reasoning: "Для заявленного применения необходим трехэлементный вариант.",
      compatible_classifications: [],
      excluded_classifications: [],
      required_facet_values: [],
    },
    facets,
    "Оборудование мощностью 3 кВт",
  );
  assertEquals(resolved?.requiredFacetValues, [{
    key: "Количество элементов",
    value: "3",
  }]);
  assertEquals(
    resolved?.text.includes(
      "Обязательные параметры: «Количество элементов: 3»",
    ),
    true,
  );

  const hidden = resolveDerivedSelectionReasoning(
    {
      reasoning:
        "Для заявленного применения нужен подходящий вариант без дополнительных условий.",
      compatible_classifications: [],
      excluded_classifications: [],
      required_facet_values: ["f0v1"],
    },
    facets,
    "Оборудование мощностью 3 кВт",
  );
  assertEquals(hidden?.requiredFacetValues, []);
  assertEquals(hidden?.text.includes("Обязательные параметры"), false);
});

Deno.test("a separated inflected count in visible reasoning becomes one exact requirement", () => {
  const resolved = resolveDerivedSelectionReasoning(
    {
      reasoning:
        "Для подключения необходим силовой вариант с тремя жилами: фаза, ноль и защитное заземление.",
      compatible_classifications: [],
      excluded_classifications: [],
      required_facet_values: [],
    },
    [{
      key: "core_count",
      caption: "Количество жил",
      values: [{ value: "2" }, { value: "3" }, { value: "4" }],
    }],
    "Оборудование мощностью 3 кВт",
  );
  assertEquals(resolved?.requiredFacetValues, [{
    key: "Количество жил",
    value: "3",
  }]);
  assertEquals(
    resolved?.text.includes("Обязательные параметры: «Количество жил: 3»"),
    true,
  );
});

Deno.test("a derived compound count does not depend on a coincident customer scalar", () => {
  const facets = [{
    key: "core_count",
    caption: "Количество жил",
    values: [{ value: "2" }, { value: "3" }, { value: "4" }],
  }];
  const schema = buildDerivedSelectionReasoningToolSchema(
    facets,
    "Подберите подходящий вариант для нового подключения",
  );
  const properties = (schema.function.parameters.properties ?? {}) as Record<
    string,
    { items?: { enum?: string[] } }
  >;
  assertEquals(properties.required_facet_values.items?.enum, [
    "f0v0",
    "f0v1",
    "f0v2",
  ]);

  const resolved = resolveDerivedSelectionReasoning(
    {
      reasoning:
        "Для стационарного подключения необходим трёхжильный вариант: фаза, ноль и защитное заземление.",
      measurement_scope: "per_product",
      compatible_classifications: [],
      excluded_classifications: [],
      required_facet_values: [],
      explicit_customer_classifications: [],
    },
    facets,
    "Подберите подходящий вариант для нового подключения",
  );
  assertEquals(resolved?.requiredFacetValues, [{
    key: "Количество жил",
    value: "3",
  }]);
  assertEquals(
    resolved?.text.includes("Обязательные параметры: «Количество жил: 3»"),
    true,
  );
});

Deno.test("a visible three-core conclusion survives beside an unrelated 3 kW load", () => {
  const facets = [{
    key: "kolichestvo_ghil__taram_sany",
    caption: "Количество жил",
    values: ["4", "3", "1", "5", "2", "8", "14", "7", "10", "6", "40"]
      .map((value) => ({ value })),
  }, {
    key: "sechenie_kabelya__mm2__kabely_қimasy__mm2",
    caption: "Сечение кабеля, мм2",
    unit: "мм²",
    values: ["1.5", "2.5", "4"].map((value) => ({ value })),
  }];
  const resolved = resolveDerivedSelectionReasoning(
    {
      reasoning:
        "Для кондиционера мощностью 3 кВт при однофазном питании 220 В расчётный ток составляет около 14,4 А. Для стационарной прокладки подходит трёхжильный кабель (фаза, ноль, заземление) сечением не менее 2,5 мм².",
      measurement_scope: "per_product",
      compatible_classifications: [],
      excluded_classifications: [],
      required_facet_values: ["f1v1"],
      explicit_customer_classifications: [],
    },
    facets,
    "Мне нужен кабель для подключения кондиционера мощностью 3 кВт. Что посоветуете?",
  );
  assertEquals(resolved?.requiredFacetValues, [{
    key: "Количество жил",
    value: "3",
  }, {
    key: "Сечение кабеля, мм2",
    value: "2.5",
  }]);
});

Deno.test("visible reasoning compiles several exact values from a live-like schema", () => {
  const facets = [
    {
      key: "kolichestvo_ghil__taram_sany",
      caption: "Количество жил",
      values: ["7", "1", "4", "5", "3", "2", "40", "14", "10", "8"].map((
        value,
      ) => ({ value })),
    },
    {
      key: "material_provodnika",
      caption: "Материал проводника",
      values: [{ value: "алюминий" }, { value: "медь" }],
    },
    {
      key: "sechenie",
      caption: "Сечение изделия, мм2",
      values: ["1.5", "2.5", "4"].map((value) => ({ value })),
    },
  ];
  const resolved = resolveDerivedSelectionReasoning(
    {
      reasoning:
        "Для нагрузки необходимо сечение не менее 2,5 мм². Количество жил: 3. Материал проводника — медь.",
      compatible_classifications: [],
      excluded_classifications: [],
      required_facet_values: ["f1v1"],
    },
    facets,
    "Оборудование мощностью 3 кВт",
  );
  assertEquals(resolved?.requiredFacetValues, [
    { key: "Количество жил", value: "3" },
    { key: "Материал проводника", value: "медь" },
  ]);
});

Deno.test("derived reasoning uses validated live classification IDs and makes the contract visible", () => {
  const liveFacets = [{
    caption: "Вид исполнения",
    type: "string",
    values: [{ value: "Первый класс" }, { value: "Второй класс" }],
  }];
  const schema = buildDerivedSelectionReasoningToolSchema(liveFacets);
  const properties = (schema.function.parameters.properties ?? {}) as Record<
    string,
    {
      items?: { enum?: string[] };
    }
  >;
  assertEquals(properties.compatible_classifications.items?.enum, [
    "f0v0",
    "f0v1",
  ]);

  const resolved = resolveDerivedSelectionReasoning({
    reasoning:
      "Расчёт даёт требуемый диапазон от 10 до 20 единиц. Можно взять Второй класс как альтернативу.",
    compatible_classifications: ["f0v0", "f0v1", "invented"],
    excluded_classifications: ["f0v1", "invented"],
  }, liveFacets);
  assertEquals(resolved?.compatible, [{
    key: "Вид исполнения",
    value: "Первый класс",
  }]);
  assertEquals(resolved?.excluded, [{
    key: "Вид исполнения",
    value: "Второй класс",
  }]);
  assertEquals(resolved?.customerGroundedCompatible, []);
  assertEquals(resolved?.customerGroundedExcluded, []);
  assertEquals(resolved?.text.includes("Как рабочую гипотезу"), true);
  assertEquals(
    resolved?.text.includes("не становится обязательным фильтром"),
    true,
  );
  assertEquals(resolved?.text.includes("Исключаю несовместимые классы"), false);
  assertEquals(resolved?.text.includes("как альтернативу"), false);
  assertEquals(resolved?.text.includes("invented"), false);
});

Deno.test("a literal customer modifier may map to one exact live classification without a title-language lock", () => {
  const liveFacets = [{
    key: "technology",
    caption: "Тип технологии",
    type: "string",
    values: [{ value: "LX" }, { value: "Галогенная" }],
  }];
  const resolved = resolveDerivedSelectionReasoning(
    {
      reasoning: "Для расчётной нагрузки нужен подходящий вариант.",
      compatible_classifications: ["f0v0"],
      excluded_classifications: [],
      required_facet_values: [],
      explicit_customer_classifications: [{
        customer_phrase: "люминесцентный",
        classification_id: "f0v0",
      }],
    },
    liveFacets,
    "Нужен люминесцентный прибор для помещения",
    "прибор",
  );

  assertEquals(resolved?.customerGroundedCompatible, [{
    key: "Тип технологии",
    value: "LX",
  }]);
  assertEquals(resolved?.explicitCustomerMappings, [{
    phrase: "люминесцентный",
    key: "Тип технологии",
    value: "LX",
  }]);
  assertEquals(
    resolved?.text.includes(
      "люминесцентный» соответствует «Тип технологии: LX",
    ),
    true,
  );
});

Deno.test("an umbrella customer phrase cannot own a narrower compound live subtype", () => {
  const liveFacets = [{
    key: "kind",
    caption: "Вид исполнения",
    type: "string",
    values: [
      { value: "бытовые светильники накладные" },
      { value: "офисные светильники" },
      { value: "уличные светильники" },
    ],
  }];
  const resolved = resolveDerivedSelectionReasoning(
    {
      reasoning:
        "Для дома рабочей гипотезой считаю бытовые светильники накладные.",
      compatible_classifications: ["f0v0"],
      excluded_classifications: [],
      required_facet_values: [],
      explicit_customer_classifications: [{
        customer_phrase: "бытовых светильников",
        classification_id: "f0v0",
      }],
    },
    liveFacets,
    "Подбери несколько бытовых светильников",
    "светильники",
  );

  assertEquals(resolved?.explicitCustomerMappings, []);
  assertEquals(resolved?.customerGroundedCompatible, []);
  assertEquals(resolved?.compatible, [{
    key: "Вид исполнения",
    value: "бытовые светильники накладные",
  }]);
  assertEquals(
    resolved?.text.includes("не становится обязательным фильтром"),
    true,
  );
});

Deno.test("a customer may own a complete compound live subtype", () => {
  const liveFacets = [{
    key: "kind",
    caption: "Вид исполнения",
    type: "string",
    values: [
      { value: "бытовые светильники накладные" },
      { value: "офисные светильники" },
      { value: "уличные светильники" },
    ],
  }];
  const resolved = resolveDerivedSelectionReasoning(
    {
      reasoning: "Нужен именно бытовой накладной светильник.",
      compatible_classifications: ["f0v0"],
      excluded_classifications: [],
      required_facet_values: [],
      explicit_customer_classifications: [{
        customer_phrase: "бытовой накладной светильник",
        classification_id: "f0v0",
      }],
    },
    liveFacets,
    "Подбери бытовой накладной светильник",
    "светильник",
  );

  assertEquals(resolved?.customerGroundedCompatible, [{
    key: "Вид исполнения",
    value: "бытовые светильники накладные",
  }]);
});

Deno.test("a semantic mapping is rejected unless its phrase is literal customer evidence", () => {
  const facets = [{
    caption: "Вид исполнения",
    type: "string",
    values: [{ value: "Первый класс" }, { value: "Второй класс" }],
  }];
  const resolved = resolveDerivedSelectionReasoning(
    {
      reasoning: "Для применения нужен подходящий вариант.",
      compatible_classifications: ["f0v0"],
      excluded_classifications: [],
      required_facet_values: [],
      explicit_customer_classifications: [{
        customer_phrase: "несуществующее свойство",
        classification_id: "f0v0",
      }],
    },
    facets,
    "Нужен прибор для помещения",
    "прибор",
  );
  assertEquals(resolved?.explicitCustomerMappings, []);
  assertEquals(resolved?.customerGroundedCompatible, []);
});

Deno.test("an inflected product noun cannot be remapped to an opaque live value", () => {
  const facets = [{
    caption: "Тип режима",
    type: "string",
    values: [{ value: "AC" }, { value: "DC" }],
  }];
  const resolved = resolveDerivedSelectionReasoning(
    {
      reasoning: "Для задачи нужен подходящий автоматический выключатель.",
      compatible_classifications: ["f0v0"],
      excluded_classifications: [],
      required_facet_values: [],
      explicit_customer_classifications: [{
        customer_phrase: "автомат",
        classification_id: "f0v0",
      }],
    },
    facets,
    "Нужен автомат с заданными параметрами",
    "Автоматические выключатели",
  );
  assertEquals(resolved?.explicitCustomerMappings, []);
  assertEquals(resolved?.customerGroundedCompatible, []);
  assertEquals(resolved?.compatible, [{ key: "Тип режима", value: "AC" }]);
});

Deno.test("an explicit phrase already bound to one live axis cannot be remapped through a shared code", () => {
  const facets = [
    {
      key: "curve",
      caption: "Характеристика срабатывания",
      type: "string",
      values: [{ value: "B" }, { value: "C" }, { value: "D" }],
    },
    {
      key: "voltage_type",
      caption: "Тип напряжения",
      type: "string",
      values: [{ value: "переменный (АС)" }, { value: "постоянный (DC)" }],
    },
  ];
  const resolved = resolveDerivedSelectionReasoning(
    {
      reasoning: "Для линии нужен подходящий вариант.",
      compatible_classifications: ["f1v0"],
      excluded_classifications: [],
      required_facet_values: [],
      explicit_customer_classifications: [{
        customer_phrase: "характеристика C",
        classification_id: "f1v0",
      }],
    },
    facets,
    "Нужен автомат, характеристика C",
    "автомат",
  );
  assertEquals(resolved?.explicitCustomerMappings, []);
  assertEquals(resolved?.customerGroundedCompatible, []);
});

Deno.test("classification schema excludes metadata whose word only starts with a class token", () => {
  const schema = buildDerivedSelectionReasoningToolSchema([
    {
      caption: "Видеофайлы",
      type: "string",
      values: [{ value: "Демонстрационный ролик" }],
    },
    {
      caption: "Вид изделия",
      type: "string",
      values: [{ value: "Первый класс" }],
    },
  ]);
  const properties = (schema.function.parameters.properties ?? {}) as Record<
    string,
    {
      items?: { enum?: string[] };
    }
  >;
  assertEquals(properties.compatible_classifications.items?.enum, ["f1v0"]);
});

Deno.test("a uniquely customer-grounded live class overrides a broader model choice", () => {
  const liveFacets = [{
    caption: "Класс применения",
    type: "string",
    values: [
      { value: "бытовые изделия накладные" },
      { value: "подвесные изделия; бра; ночники" },
      { value: "офисно-административное применение" },
    ],
  }];
  const resolved = resolveDerivedSelectionReasoning(
    {
      reasoning: "Для помещения нужен расчётный диапазон 3000–4000 единиц.",
      compatible_classifications: ["f0v0"],
      excluded_classifications: [],
    },
    liveFacets,
    "Хочу заменить подвесное изделие на энергоэффективное для комнаты",
  );

  assertEquals(resolved?.compatible, [{
    key: "Класс применения",
    value: "подвесные изделия; бра; ночники",
  }]);
  assertEquals(resolved?.customerGroundedCompatible, [{
    key: "Класс применения",
    value: "подвесные изделия; бра; ночники",
  }]);
  assertEquals(
    resolved?.text.includes("подвесные изделия; бра; ночники"),
    true,
  );
  assertEquals(resolved?.text.includes("бытовые изделия накладные"), false);
});

Deno.test("one shared application noun cannot own a narrower compound classification family", () => {
  const facets = [{
    caption: "Назначение",
    values: [
      { value: "Кабели силовые стационарные" },
      { value: "Провод самонесущий для воздушных линий электропередач" },
      { value: "Провод неизолированный для воздушных линий электропередач" },
      { value: "Кабели сигнальные" },
    ],
  }];
  const declaration = {
    reasoning:
      "Для стационарной прокладки требуется подходящий силовой кабель.",
    compatible_classifications: ["f0v0"],
    excluded_classifications: [],
  };
  const unrelated = resolveDerivedSelectionReasoning(
    declaration,
    facets,
    "Линия 10 метров, стационарная прокладка",
    "кабель и провод",
  );
  assertEquals(
    unrelated?.customerGroundedCompatible.some(({ value }) =>
      value.includes("воздушных")
    ),
    false,
  );
  assertEquals(
    unrelated?.compatible.some(({ value }) => value.includes("воздушных")),
    false,
  );
  const explicit = resolveDerivedSelectionReasoning(
    { ...declaration, compatible_classifications: [] },
    facets,
    "Нужен провод для воздушных линий электропередач",
    "провод",
  );
  assertEquals(explicit?.customerGroundedCompatible.length, 2);
});

Deno.test("a customer-grounded class family preserves all matching live variants", () => {
  const liveFacets = [{
    caption: "Класс применения",
    type: "string",
    values: [
      { value: "бытовые изделия накладные" },
      { value: "бытовые изделия подвесные" },
      { value: "промышленные изделия" },
      { value: "офисные изделия" },
    ],
  }];
  const resolved = resolveDerivedSelectionReasoning(
    {
      reasoning: "Подбираю подходящий вариант по явно указанному применению.",
      compatible_classifications: ["f0v2"],
      excluded_classifications: [],
    },
    liveFacets,
    "Нужны бытовые изделия",
  );

  assertEquals(resolved?.compatible, [
    { key: "Класс применения", value: "бытовые изделия накладные" },
    { key: "Класс применения", value: "бытовые изделия подвесные" },
  ]);
  assertEquals(resolved?.customerGroundedCompatible, resolved?.compatible);
  assertEquals(resolved?.familyCompatibleFacetKeys, ["класс применения"]);
  assertEquals(resolved?.text.includes("в первую очередь проверяю"), true);
  assertEquals(
    resolved?.text.includes("исключаю только при доказанной несовместимости"),
    true,
  );
  assertEquals(
    resolved?.measurementEvidence,
    "Подбираю подходящий вариант по явно указанному применению.",
  );
  assertEquals(
    resolved?.measurementEvidence.includes("бытовые изделия"),
    false,
  );
});

Deno.test("a model may refine a customer-owned family only to one member of that family", () => {
  const liveFacets = [{
    caption: "Класс применения",
    type: "string",
    values: [
      { value: "бытовые изделия накладные" },
      { value: "бытовые изделия подвесные" },
      { value: "промышленные изделия" },
    ],
  }];
  const refined = resolveDerivedSelectionReasoning(
    {
      reasoning:
        "Для указанного монтажа подходит подвесное исполнение бытового изделия.",
      compatible_classifications: ["f0v1"],
      excluded_classifications: [],
    },
    liveFacets,
    "Нужны бытовые изделия",
  );
  assertEquals(refined?.compatible, [{
    key: "Класс применения",
    value: "бытовые изделия подвесные",
  }]);
  assertEquals(refined?.customerGroundedCompatible, []);
  assertEquals(refined?.familyCompatibleFacetKeys, []);

  const rejectedSibling = resolveDerivedSelectionReasoning(
    {
      reasoning: "Для указанного монтажа подходит промышленное исполнение.",
      compatible_classifications: ["f0v2"],
      excluded_classifications: [],
    },
    liveFacets,
    "Нужны бытовые изделия",
  );
  assertEquals(rejectedSibling?.compatible, [
    { key: "Класс применения", value: "бытовые изделия накладные" },
    { key: "Класс применения", value: "бытовые изделия подвесные" },
  ]);
});

Deno.test("the established product head cannot ground a narrower classification family", () => {
  const resolved = resolveDerivedSelectionReasoning(
    {
      reasoning: "Подбираю исполнение по назначению и измеряемой нагрузке.",
      compatible_classifications: ["f0v0"],
      excluded_classifications: [],
    },
    [{
      caption: "Класс применения",
      type: "string",
      values: [
        { value: "изделия для стационарной установки" },
        { value: "изделия для мобильной установки" },
        { value: "монтажные аксессуары" },
      ],
    }],
    "Нужно изделие для оборудования мощностью 3 кВт",
    "Изделие и аксессуары",
  );

  assertEquals(resolved?.compatible, [{
    key: "Класс применения",
    value: "изделия для стационарной установки",
  }]);
  assertEquals(resolved?.customerGroundedCompatible, []);
  assertEquals(resolved?.text.includes("Как рабочую гипотезу"), true);
  assertEquals(resolved?.text.includes("в первую очередь проверяю"), false);
});

Deno.test("a unique customer-grounded class remains an exact classification obligation", () => {
  const resolved = resolveDerivedSelectionReasoning({
    reasoning: "Подбираю исполнение по прямо указанному месту применения.",
    compatible_classifications: ["f0v0"],
    excluded_classifications: ["f0v1"],
  }, [{
    caption: "Класс применения",
    type: "string",
    values: [{ value: "внутреннее исполнение" }, {
      value: "наружное исполнение",
    }],
  }], "Нужно внутреннее исполнение");

  assertEquals(resolved?.familyCompatibleFacetKeys, []);
  assertEquals(resolved?.compatible, [{
    key: "Класс применения",
    value: "внутреннее исполнение",
  }]);
});

Deno.test("an opaque live abbreviation cannot become a hard model-only exclusion", () => {
  const resolved = resolveDerivedSelectionReasoning({
    reasoning:
      "Подбираю решение по заявленному назначению и обязательным параметрам.",
    compatible_classifications: [],
    excluded_classifications: ["f0v0", "f0v1"],
  }, [{
    caption: "Класс применения",
    type: "string",
    values: [
      { value: "изделия для ЖКХ" },
      { value: "промышленные изделия" },
      { value: "бытовые изделия" },
    ],
  }]);

  assertEquals(resolved?.excluded, [{
    key: "Класс применения",
    value: "промышленные изделия",
  }]);
  assertEquals(resolved?.customerGroundedExcluded, []);
  assertEquals(resolved?.text.includes("ЖКХ"), false);
  assertEquals(resolved?.text.includes("промышленные изделия"), false);
});

Deno.test("a negated class term cannot become customer-grounded evidence", () => {
  const liveFacets = [{
    caption: "Класс применения",
    type: "string",
    values: [
      { value: "подвесные изделия" },
      { value: "накладные изделия" },
    ],
  }];
  const resolved = resolveDerivedSelectionReasoning(
    {
      reasoning: "Выбираю подходящий вариант по указанному способу установки.",
      compatible_classifications: ["f0v1"],
      excluded_classifications: [],
    },
    liveFacets,
    "Нужно не подвесное, а накладное изделие",
  );

  assertEquals(resolved?.compatible, [{
    key: "Класс применения",
    value: "накладные изделия",
  }]);
  assertEquals(resolved?.customerGroundedExcluded, [{
    key: "Класс применения",
    value: "подвесные изделия",
  }]);
  assertEquals(
    resolved?.text.includes("По вашему условию исключаю: «подвесные изделия»"),
    true,
  );
});

Deno.test("visible prose cannot contradict the customer-grounded live class", () => {
  const liveFacets = [{
    caption: "Класс применения",
    type: "string",
    values: [
      { value: "подвесные изделия; бра; ночники" },
      { value: "трековые изделия" },
      { value: "бытовые изделия накладные" },
    ],
  }];
  const resolved = resolveDerivedSelectionReasoning(
    {
      reasoning:
        "Расчёт даёт диапазон 3000–4000 единиц. Подойдут накладные или трековые системы, но не подвесные.",
      compatible_classifications: ["f0v2"],
      excluded_classifications: [],
    },
    liveFacets,
    "Заменить подвесное изделие на энергоэффективное",
  );

  assertEquals(resolved?.compatible, [{
    key: "Класс применения",
    value: "подвесные изделия; бра; ночники",
  }]);
  assertEquals(resolved?.text.includes("3000–4000"), true);
  assertEquals(resolved?.text.includes("трековые"), false);
  assertEquals(resolved?.text.includes("накладные"), false);
  assertEquals(resolved?.text.includes("не подвесные"), false);
});

Deno.test("actionability policy contains no product vocabulary", () => {
  const source = Deno.readTextFileSync(
    new URL("./selection-actionability.ts", import.meta.url),
  ).toLocaleLowerCase("ru-RU");
  for (
    const forbidden of ["термоус", "люстр", "ламп", "кабель", "korn", "corn"]
  ) {
    assertEquals(source.includes(forbidden), false);
  }
});

Deno.test("optional preference after discovery cannot block a selection", () => {
  assertEquals(
    shouldContinueSelectionPastOptionalClarification({
      intentMode: "select",
      hasDiscovery: true,
      userMessage: "Нужно решение для комнаты 25 м². Что подойдет?",
      question: "Какой тип исполнения рассматриваете?",
      facetKey: "vid_ispolneniya__s",
      options: [{ value: "Первый" }, { value: "Второй" }],
    }),
    true,
  );
});

Deno.test("an unrequested facet cannot block a plain availability browse", () => {
  assertEquals(
    shouldContinueSelectionPastOptionalClarification({
      intentMode: "select",
      hasDiscovery: true,
      userMessage: "А у вас есть такие изделия?",
      question: "Какой цоколь вам нужен?",
      facetKey: "tip_cokolya__s",
      options: [{ value: "E27" }, { value: "E40" }],
    }),
    true,
  );
  assertEquals(
    shouldContinueSelectionPastOptionalClarification({
      intentMode: "select",
      hasDiscovery: true,
      userMessage: "Есть ли изделие для объекта диаметром 10 мм?",
      question: "Какой диаметр изделия нужен?",
      facetKey: "diametr__mm",
      options: [{ value: "10" }, { value: "12" }],
    }),
    false,
  );
});

Deno.test("objective clarification remains allowed", () => {
  assertEquals(
    shouldContinueSelectionPastOptionalClarification({
      intentMode: "select",
      hasDiscovery: true,
      userMessage: "Нужно решение для оборудования",
      question: "Какую мощность нагрузки рассматриваете?",
      facetKey: "moshchnost__v",
      options: [{ value: "1" }, { value: "2" }],
    }),
    false,
  );
});

Deno.test("customer-owned alternative remains a valid clarification", () => {
  assertEquals(
    shouldContinueSelectionPastOptionalClarification({
      intentMode: "select",
      hasDiscovery: true,
      userMessage: "Не знаю, выбрать белый или черный",
      question: "Какой цвет предпочитаете?",
      facetKey: "cvet__s",
      options: [{ value: "Белый" }, { value: "Черный" }],
    }),
    false,
  );
});

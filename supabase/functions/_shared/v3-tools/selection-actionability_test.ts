import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  applyCriteriaGate,
  type Criterion,
  extendSelectionCriteriaPlan,
  overlayMandatoryFacetOptions,
  projectAdvisoryCriteriaFacetOptions,
  projectCriteriaFacetOptions,
  relaxModelDerivedSelectionCriteriaPlan,
  resolveTerminalSelectionCriteria,
} from "./criteria-gate.ts";
import type { ProductRef } from "./types.ts";
import {
  buildDerivedSelectionReasoningMessages,
  buildDerivedSelectionReasoningToolSchema,
  compileCustomerClassificationCriteria,
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
} from "./selection-actionability.ts";

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

Deno.test("a live before/after pair requires visible derivation even when its object scalar projects directly", () => {
  for (const value of [12, 10]) {
    assertEquals(
      shouldRequireDerivedSelectionReasoning({
        intentMode: "select",
        phase: "search_after_discovery",
        catalogSearchAttempted: false,
        directMeasuredCriteriaCount: 1,
        pairedCompatibilityUnproven: true,
        userMessage: `подбери изделие для объекта диаметром ${value} мм`,
        reasoningText:
          `Размер до установки не менее ${value} мм и после изменения не более ${value} мм.`,
      }),
      true,
    );
  }
  assertEquals(
    shouldRequireDerivedSelectionReasoning({
      intentMode: "select",
      phase: "search_after_discovery",
      catalogSearchAttempted: false,
      directMeasuredCriteriaCount: 1,
      pairedCompatibilityUnproven: false,
      userMessage: "Нужно изделие диаметром 12 мм",
      reasoningText: "",
    }),
    false,
  );
});

Deno.test("derived reasoning instructions distinguish paired strict fit from an exact object-size facet", () => {
  const system = buildDerivedSelectionReasoningMessages(
    "подбери изделие для объекта диаметром 12 мм",
    "Изделия",
    [],
  )[0].content;
  assertEquals(system.includes("строго больше"), true);
  assertEquals(system.includes("строго меньше"), true);
  assertEquals(system.includes("точное значение фасета"), true);
});

Deno.test("derived declaration cannot turn a paired object reference into an exact live value", () => {
  const facets = [{
    key: "diameter_before",
    caption: "Внутренний диаметр до изменения, мм",
    unit: "мм",
    values: [{ value: "12" }, { value: "16" }],
  }, {
    key: "diameter_after",
    caption: "Внутренний диаметр после изменения, мм",
    unit: "мм",
    values: [{ value: "6" }, { value: "8" }],
  }];
  const declaration = resolveDerivedSelectionReasoning(
    {
      reasoning:
        "Для объекта диаметром 12 мм внутренний диаметр до установки должен быть строго больше 12 мм, после изменения строго меньше 12 мм.",
      required_facet_values: ["f0v0"],
      compatible_classifications: [],
      excluded_classifications: [],
    },
    facets,
    "объект диаметром 12 мм",
    "Изделия",
    {
      value: 12,
      unit: "мм",
      facetKeys: ["diameter_before", "diameter_after"],
    },
  );
  assertEquals(declaration?.requiredFacetValues, []);
  assertEquals(declaration?.text.includes("Обязательные параметры"), false);
});

Deno.test("unitful live values cannot copy either 12 or 10 mm object reference", () => {
  for (const value of [12, 10]) {
    const facets = [{
      key: "before_size",
      caption: "Размер до изменения, мм",
      unit: "мм",
      values: [{ value: `${value} мм` }],
    }, {
      key: "after_size",
      caption: "Размер после изменения, мм",
      unit: "мм",
      values: [{ value: `${value} мм` }],
    }];
    const declaration = resolveDerivedSelectionReasoning(
      {
        reasoning:
          `Для объекта размером ${value} мм размер изделия до изменения строго больше ${value} мм, а размер после изменения строго меньше ${value} мм.`,
        required_facet_values: ["f0v0", "f1v0"],
        compatible_classifications: [],
        excluded_classifications: [],
      },
      facets,
      `объект размером ${value} мм`,
      "Изделия",
      { value, unit: "мм", facetKeys: ["before_size", "after_size"] },
    );
    assertEquals(declaration?.requiredFacetValues, []);
    assertEquals(declaration?.text.includes("Обязательные параметры"), false);
  }
});

Deno.test("paired declaration rejects an affirmed incompatible live range and never requires a negated one", () => {
  const facets = [{
    key: "before_size",
    caption: "Размер до изменения, мм",
    unit: "мм",
    values: [{ value: "14" }],
  }, {
    key: "after_size",
    caption: "Размер после изменения, мм",
    unit: "мм",
    values: [{ value: "7" }],
  }, {
    key: "supported_object_size",
    caption: "Диапазон размеров объекта, мм",
    unit: "мм",
    values: [{ value: "12.8-24" }, { value: "6.8-12" }],
  }];
  const paired = {
    value: 12,
    unit: "мм",
    facetKeys: ["before_size", "after_size"],
  };
  const strict =
    "Для объекта размером 12 мм размер изделия до изменения строго больше 12 мм. Размер после изменения строго меньше 12 мм.";
  const incompatible = resolveDerivedSelectionReasoning(
    {
      reasoning: `${strict} Диапазон размеров объекта 12.8-24 мм подходит.`,
      required_facet_values: ["f2v0"],
      compatible_classifications: [],
      excluded_classifications: [],
    },
    facets,
    "объект размером 12 мм",
    "Изделия",
    paired,
  );
  assertEquals(incompatible, null);

  const negated = resolveDerivedSelectionReasoning(
    {
      reasoning:
        `${strict} Диапазон размеров объекта 12.8-24 мм не подходит. Подходит диапазон 6.8-12 мм.`,
      required_facet_values: ["f2v0"],
      compatible_classifications: [],
      excluded_classifications: [],
    },
    facets,
    "объект размером 12 мм",
    "Изделия",
    paired,
  );
  assertEquals(
    negated?.requiredFacetValues.some(({ value }) => value === "12.8-24"),
    false,
  );
  assertEquals(
    negated?.text.includes(
      "Обязательные параметры: «Диапазон размеров объекта, мм: 12.8-24»",
    ),
    false,
  );

  const mixed = resolveDerivedSelectionReasoning(
    {
      reasoning:
        `${strict} Диапазон размеров объекта 12.8-24 мм подходит, а 6.8-12 мм не подходит.`,
      required_facet_values: ["f2v0"],
      compatible_classifications: [],
      excluded_classifications: [],
    },
    facets,
    "объект размером 12 мм",
    "Изделия",
    paired,
  );
  assertEquals(mixed, null);

  const adjacentWithoutPunctuation = resolveDerivedSelectionReasoning(
    {
      reasoning:
        `${strict} Диапазон 12.8-24 мм подходит и диапазон 6.8-12 мм не подходит.`,
      required_facet_values: ["f2v0"],
      compatible_classifications: [],
      excluded_classifications: [],
    },
    facets,
    "объект размером 12 мм",
    "Изделия",
    paired,
  );
  assertEquals(adjacentWithoutPunctuation, null);

  const abbreviated = resolveDerivedSelectionReasoning(
    {
      reasoning: `${strict} Диапазон 12.8-24 мм подходит.`,
      required_facet_values: [],
      compatible_classifications: [],
      excluded_classifications: [],
    },
    facets,
    "объект размером 12 мм",
    "Изделия",
    paired,
  );
  assertEquals(abbreviated, null);
});

Deno.test("live-like paired diameter declaration never requires a range excluding 12 or 10 mm", () => {
  const facets = [{
    key: "diameter_before",
    caption: "Внутренний диаметр до усадки, мм",
    unit: "мм",
    values: [{ value: "14" }, { value: "16" }],
  }, {
    key: "diameter_after",
    caption: "Внутренний диаметр после усадки, мм",
    unit: "мм",
    values: [{ value: "7" }, { value: "8" }],
  }, {
    key: "wire_diameter_range",
    caption: "Диапазон диаметров проводов",
    unit: "мм",
    values: [{ value: "12.8-24" }, { value: "6.8-12" }],
  }];
  for (const value of [12, 10]) {
    const declaration = resolveDerivedSelectionReasoning(
      {
        reasoning:
          `Для кабеля диаметром ${value} мм внутренний диаметр трубки до усадки должен быть строго больше ${value} мм. ` +
          `Внутренний диаметр после усадки должен быть строго меньше ${value} мм. ` +
          `Диапазон диаметров проводов 12.8–24 мм не подходит. Подходит диапазон 6.8–12 мм.`,
        required_facet_values: ["f2v0"],
        compatible_classifications: [],
        excluded_classifications: [],
      },
      facets,
      `кабель диаметром ${value} мм`,
      "Трубки",
      {
        value,
        unit: "мм",
        facetKeys: ["diameter_before", "diameter_after"],
      },
    );
    assertEquals(declaration?.requiredFacetValues, []);
    assertEquals(declaration?.text.includes("Обязательные параметры"), false);
  }
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
      "Промежуточный расчёт — например, ток из мощности — не завершает подбор",
    ),
    true,
  );
  assertEquals(messages[0].content.includes("required_facet_values"), true);
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
  assertEquals(
    resolved?.measurementEvidence.includes(
      "распределить между несколькими товарами",
    ),
    true,
  );
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

Deno.test("a visible minimum capacity outranks an exact model ID copied from the application's size", () => {
  const facets = [{
    key: "area",
    caption: "Максимальная площадь освещения, м²",
    type: "number",
    unit: "м²",
    values: [{ value: "25" }, { value: "30" }, { value: "35" }],
  }];
  const resolved = resolveDerivedSelectionReasoning(
    {
      reasoning:
        "Максимальная площадь освещения должна быть не менее 30 м², чтобы прибор покрывал помещение.",
      measurement_scope: "per_product",
      compatible_classifications: [],
      excluded_classifications: [],
      required_facet_values: ["f0v1"],
      explicit_customer_classifications: [],
    },
    facets,
    "Нужен прибор для комнаты площадью 30 м²",
  );
  assertEquals(resolved?.requiredFacetValues, []);
  assertEquals(resolved?.text.includes("Обязательные параметры"), false);

  const explicitlyExact = resolveDerivedSelectionReasoning(
    {
      reasoning: "Максимальная площадь освещения изделия ровно 30 м².",
      measurement_scope: "per_product",
      compatible_classifications: [],
      excluded_classifications: [],
      required_facet_values: ["f0v1"],
      explicit_customer_classifications: [],
    },
    facets,
    "Нужна максимальная площадь освещения товара ровно 30 м²",
  );
  assertEquals(explicitlyExact?.requiredFacetValues, [{
    key: "Максимальная площадь освещения, м²",
    value: "30",
  }]);
});

Deno.test("a spatial calculation cannot masquerade as one-product evidence", () => {
  const customer =
    "Нужен светодиодный светильник для гостиной площадью 25 кв. м";
  const reasoning =
    "Световой поток = 25 м² × 150 лк = 3750 лм. Нужен поток не менее 3750 лм.";
  assertEquals(
    reasoningComputesSystemTotalFromSpatialExtent(customer, reasoning),
    false,
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
  assertEquals(resolved?.measurementScope, "per_product");
  assertEquals(
    resolved?.text.includes("суммарная потребность всей системы"),
    false,
  );
});

Deno.test("one-to-one replacement keeps calculated demand per target while a multi-item system remains aggregate", () => {
  const reasoning = "Нужно не менее 4000 лм: 25 м² × 160 лк = 4000 лм.";
  assertEquals(
    reasoningComputesSystemTotalFromSpatialExtent(
      "Хочу заменить люстру на светодиодный светильник в гостиной 25 м²",
      reasoning,
    ),
    false,
  );
  assertEquals(
    reasoningComputesSystemTotalFromSpatialExtent(
      "Нужно несколько светильников для гостиной 25 м²",
      reasoning,
    ),
    true,
  );
  assertEquals(
    reasoningComputesSystemTotalFromSpatialExtent(
      "Нужно заменить одно изделие на три изделия для комнаты 25 м²",
      reasoning,
    ),
    true,
  );
  const single = resolveDerivedSelectionReasoning(
    {
      reasoning,
      measurement_scope: "system_total",
      compatible_classifications: [],
      excluded_classifications: [],
    },
    [],
    "Хочу заменить люстру на светодиодный светильник в гостиной 25 м²",
  );
  assertEquals(single?.measurementScope, "per_product");
  const noMeasurement = resolveDerivedSelectionReasoning(
    {
      reasoning: "Нужна совместимая замена с подходящими условиями монтажа.",
      measurement_scope: "not_applicable",
      compatible_classifications: [],
      excluded_classifications: [],
    },
    [],
    "Хочу заменить старое изделие на новое",
  );
  assertEquals(noMeasurement?.measurementScope, "not_applicable");
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

Deno.test("a replacement source class cannot become the customer-owned target class", () => {
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
    value: "бытовые изделия накладные",
  }]);
  assertEquals(resolved?.customerGroundedCompatible, []);
  assertEquals(
    resolved?.text.includes("подвесные изделия; бра; ночники"),
    false,
  );
  assertEquals(resolved?.text.includes("бытовые изделия накладные"), true);
});

Deno.test("a transformation target can still own a composite live class when it is explicitly requested", () => {
  const facets = [{
    caption: "Вид изделия",
    type: "string",
    values: [
      { value: "настольные изделия; бра; ночники" },
      { value: "потолочные изделия" },
    ],
  }];
  const sourceOnly = resolveDerivedSelectionReasoning(
    {
      reasoning: "Ищу функциональную замену по назначению помещения.",
      compatible_classifications: ["f0v0"],
      excluded_classifications: [],
    },
    facets,
    "Хочу заменить бра на светодиодное изделие в комнате",
  );
  assertEquals(sourceOnly?.customerGroundedCompatible, []);
  const targetOwned = resolveDerivedSelectionReasoning(
    {
      reasoning: "Ищу функциональную замену по назначению помещения.",
      compatible_classifications: ["f0v0"],
      excluded_classifications: [],
    },
    facets,
    "Хочу заменить люстру на бра в комнате",
  );
  assertEquals(targetOwned?.customerGroundedCompatible, [{
    key: "Вид изделия",
    value: "настольные изделия; бра; ночники",
  }]);
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
  assertEquals(resolved?.text.includes("обязательному классу"), true);
  assertEquals(
    resolved?.text.includes("значения вне этого класса исключаю"),
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
  assertEquals(refined?.compatible, [
    { key: "Класс применения", value: "бытовые изделия накладные" },
    { key: "Класс применения", value: "бытовые изделия подвесные" },
  ]);
  assertEquals(refined?.customerGroundedCompatible, refined?.compatible);
  assertEquals(refined?.familyCompatibleFacetKeys, ["класс применения"]);
  assertEquals(
    refined?.text.includes("как предпочтение, не исключая другие"),
    true,
  );

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

Deno.test("customer household light class remains mandatory OR despite a model subtype", () => {
  const liveFacets = [{
    key: "luminaire_use",
    caption: "Вид светильника",
    type: "string",
    values: [
      { value: "Бытовые светильники накладные" },
      { value: "Бытовые светильники подвесные" },
      { value: "Светильники для ЖКХ" },
      { value: "Промышленные светильники" },
    ],
  }];
  const resolved = resolveDerivedSelectionReasoning(
    {
      reasoning:
        "Для бытового помещения сначала проверю накладной светильник с датчиком движения.",
      compatible_classifications: ["f0v0"],
      excluded_classifications: [],
    },
    liveFacets,
    "Нужен бытовой светильник с датчиком движения",
    "Светильники",
  );
  const family = [
    { key: "Вид светильника", value: "Бытовые светильники накладные" },
    { key: "Вид светильника", value: "Бытовые светильники подвесные" },
  ];
  assertEquals(resolved?.customerGroundedCompatible, family);
  assertEquals(resolved?.compatible, family);
  assertEquals(resolved?.familyCompatibleFacetKeys, ["вид светильника"]);
});

Deno.test("customer class OR survives search, sparse recovery and final cards", () => {
  const facets = [{
    key: "luminaire_use",
    caption: "Вид светильника",
    type: "string",
    unit: null,
    values: [
      { value: "Бытовые светильники накладные" },
      { value: "Бытовые светильники подвесные" },
      { value: "Светильники для ЖКХ" },
    ],
  }];
  const declaration = resolveDerivedSelectionReasoning(
    {
      reasoning:
        "Для дома сначала проверю накладные модели; датчик движения обязателен.",
      compatible_classifications: ["f0v0"],
      excluded_classifications: [],
    },
    facets,
    "Нужен бытовой светильник с датчиком движения",
    "Светильники",
  );
  if (!declaration) throw new Error("expected a grounded live declaration");
  const customerClass = compileCustomerClassificationCriteria(declaration);
  const motion: Criterion = {
    key: "С датчиком движения",
    op: "eq",
    value: "да",
    level: "A",
    evidence: "user_explicit",
  };
  const mandatory = [...customerClass, motion];
  const projected = projectCriteriaFacetOptions(mandatory, facets);
  assertEquals(projected.options, {
    luminaire_use: [
      "Бытовые светильники накладные",
      "Бытовые светильники подвесные",
    ],
  });
  const subtypeAdvice: Criterion = {
    key: "Вид светильника",
    op: "eq",
    value: "Бытовые светильники накладные",
    level: "B",
    evidence: "model_assumption",
  };
  const advised = projectAdvisoryCriteriaFacetOptions([subtypeAdvice], facets);
  assertEquals(
    overlayMandatoryFacetOptions(projected.options, advised.options),
    projected.options,
  );

  const modelDetail: Criterion = {
    key: "Монтаж",
    op: "eq",
    value: "накладной",
    level: "A",
    evidence: "derived_required",
  };
  const plan = extendSelectionCriteriaPlan(
    null,
    [...mandatory, modelDetail],
    "reasoning_projection",
  );
  const recovered = relaxModelDerivedSelectionCriteriaPlan(
    plan,
    [modelDetail],
    customerClass,
  );
  assertEquals(recovered.relaxed, [modelDetail]);
  assertEquals(recovered.plan?.mandatory_criteria, mandatory);
  const terminal = resolveTerminalSelectionCriteria(
    [],
    [],
    [...(recovered.plan?.mandatory_criteria ?? [])],
  );
  const candidate = (
    id: string,
    use: string,
    response: string,
    indexedSensor = true,
  ): ProductRef => ({
    id,
    pagetitle: indexedSensor
      ? `Светильник ${id}`
      : `Светильник ${id} с микроволновым сенсором`,
    vendor: null,
    price: 3000,
    stock: "in_stock",
    short_traits: [
      `Вид светильника: ${use}`,
      ...(indexedSensor ? ["С датчиком движения: да"] : []),
    ],
    description_excerpt: response,
  });
  const products = [
    candidate(
      "gauss-hall",
      "Бытовые светильники накладные",
      "Микроволновый датчик реагирует на движение.",
      false,
    ),
    candidate(
      "household-pendant",
      "Бытовые светильники подвесные",
      "Сенсор реагирует на движение.",
    ),
    candidate(
      "iek-acoustic",
      "Бытовые светильники накладные",
      "Оптико-акустический датчик реагирует на звук.",
    ),
    candidate(
      "plato-jkh",
      "Светильники для ЖКХ",
      "Датчик реагирует на движение.",
    ),
  ];
  assertEquals(applyCriteriaGate(products, terminal).passed_ids, [
    "gauss-hall",
    "household-pendant",
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

Deno.test("visible prose cannot resurrect a discarded source class or unrelated sibling", () => {
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
    value: "бытовые изделия накладные",
  }]);
  assertEquals(resolved?.customerGroundedCompatible, []);
  assertEquals(resolved?.text.includes("3000–4000"), true);
  assertEquals(resolved?.text.includes("трековые"), false);
  assertEquals(resolved?.text.includes("Как рабочую гипотезу"), true);
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

import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  buildDerivedSelectionReasoningMessages,
  buildDerivedSelectionReasoningToolSchema,
  hasActionableSelectionContract,
  hasSelectionMeasurementContext,
  measuredSelectionContractEvidence,
  resolveDerivedSelectionReasoning,
  shouldContinueSelectionPastOptionalClarification,
  shouldFinalizeDerivedSelectionSearch,
  shouldProjectDerivedScalarMeasurement,
  shouldQueueDirectCustomerFacetSearch,
  shouldRequireDerivedSelectionReasoning,
} from "./selection-actionability.ts";

Deno.test("two independent measured axes make a selection actionable", () => {
  assertEquals(hasActionableSelectionContract("нужно 40 Вт и поток 4000 лм"), true);
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
  assertEquals(hasSelectionMeasurementContext("Нужно решение для комнаты 25 м²"), true);
  assertEquals(hasSelectionMeasurementContext("Нужно 3 штуки через 2 дня"), false);
  assertEquals(shouldRequireDerivedSelectionReasoning({
    intentMode: "select",
    phase: "search_after_discovery",
    catalogSearchAttempted: false,
    directMeasuredCriteriaCount: 0,
    userMessage: "Хочу заменить устройство для помещения 25 м². Что подойдет?",
    reasoningText: "",
  }), true);
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
  assertEquals(shouldRequireDerivedSelectionReasoning({
    ...base,
    directMeasuredCriteriaCount: 0,
    reasoningText: "Нужно не менее 40 Вт и поток от 4000 лм",
  }), false);
  assertEquals(shouldRequireDerivedSelectionReasoning({
    ...base,
    intentMode: "inquire",
    directMeasuredCriteriaCount: 0,
  }), false);
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
  assertEquals(shouldFinalizeDerivedSelectionSearch({ ...base, actualToolCallId: "model-search" }), false);
  assertEquals(shouldFinalizeDerivedSelectionSearch({ ...base, candidateCount: 0 }), false);
  assertEquals(shouldFinalizeDerivedSelectionSearch({ ...base, provenCriteriaCount: 0 }), false);
  assertEquals(shouldFinalizeDerivedSelectionSearch({
    ...base,
    provenCriteriaCount: 0,
    pairedCompatibilityRequired: true,
  }), true);
  assertEquals(shouldFinalizeDerivedSelectionSearch({ ...base, searchOk: false }), false);
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
  };
  assertEquals(shouldQueueDirectCustomerFacetSearch(base), true);
  assertEquals(shouldQueueDirectCustomerFacetSearch({ ...base, replacementIntent: true }), false);
  assertEquals(shouldQueueDirectCustomerFacetSearch({ ...base, derivedReasoningRequired: true }), false);
  assertEquals(shouldQueueDirectCustomerFacetSearch({ ...base, unmatchedUserCriteriaCount: 1 }), false);
  assertEquals(shouldQueueDirectCustomerFacetSearch({ ...base, broadAssortmentRequest: true }), false);
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

Deno.test("an ungrounded execution variant is not offered as an application classification", () => {
  const facets = [{
    caption: "Модель или исполнение",
    type: "string",
    values: [{ value: "Первый вариант" }, { value: "Второй вариант" }],
  }];
  const schema = buildDerivedSelectionReasoningToolSchema(facets);
  const properties = schema.function.parameters.properties as Record<string, { items?: { maxLength?: number } }>;
  assertEquals(properties.compatible_classifications.items?.maxLength, 0);
  assertEquals(resolveDerivedSelectionReasoning({
    reasoning: "Расчёт даёт обязательный диапазон от 10 до 20 единиц.",
    compatible_classifications: ["f0v0"],
    excluded_classifications: [],
  }, facets)?.compatible, []);
});

Deno.test("derived reasoning prompt is compact and treats the live schema as untrusted data", () => {
  const messages = buildDerivedSelectionReasoningMessages(
    "Что подойдет для 25 м²?",
    "Ветка <script>alert(1)</script>",
    [
      { caption: "Параметр", type: "number", unit: "лм", values: [{ value: "<hidden-option>" }] },
      { caption: "Вид исполнения", type: "string", unit: null, values: [{ value: "<option>" }] },
    ],
  );
  assertEquals(messages.length, 2);
  assertEquals(messages[0].content.includes("недоверенные данные"), true);
  assertEquals(messages[0].content.includes("Класс товара, прямо названный клиентом, неизменяем"), true);
  assertEquals(messages[0].content.includes("качественные требования совместимости или безопасности"), true);
  assertEquals(messages[0].content.includes("живых категориальных значений"), true);
  assertEquals(messages[1].content.includes("<script>"), false);
  assertEquals(messages[1].content.includes("\\u003cscript>"), true);
  assertEquals(messages[1].content.includes("\\u003coption>"), true);
  assertEquals(messages[1].content.includes("hidden-option"), false);
});

Deno.test("derived reasoning uses validated live classification IDs and makes the contract visible", () => {
  const liveFacets = [{
    caption: "Вид исполнения",
    type: "string",
    values: [{ value: "Первый класс" }, { value: "Второй класс" }],
  }];
  const schema = buildDerivedSelectionReasoningToolSchema(liveFacets);
  const properties = (schema.function.parameters.properties ?? {}) as Record<string, {
    items?: { enum?: string[] };
  }>;
  assertEquals(properties.compatible_classifications.items?.enum, ["f0v0", "f0v1"]);

  const resolved = resolveDerivedSelectionReasoning({
    reasoning: "Расчёт даёт требуемый диапазон от 10 до 20 единиц. Можно взять Второй класс как альтернативу.",
    compatible_classifications: ["f0v0", "f0v1", "invented"],
    excluded_classifications: ["f0v1", "invented"],
  }, liveFacets);
  assertEquals(resolved?.compatible, [{ key: "Вид исполнения", value: "Первый класс" }]);
  assertEquals(resolved?.excluded, [{ key: "Вид исполнения", value: "Второй класс" }]);
  assertEquals(resolved?.text.includes("По классу «Вид исполнения» выбираю «Первый класс»"), true);
  assertEquals(resolved?.text.includes("Исключаю несовместимые классы: «Второй класс»"), true);
  assertEquals(resolved?.text.includes("как альтернативу"), false);
  assertEquals(resolved?.text.includes("invented"), false);
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
  const resolved = resolveDerivedSelectionReasoning({
    reasoning: "Для помещения нужен расчётный диапазон 3000–4000 единиц.",
    compatible_classifications: ["f0v0"],
    excluded_classifications: [],
  }, liveFacets, "Хочу заменить подвесное изделие на энергоэффективное для комнаты");

  assertEquals(resolved?.compatible, [{
    key: "Класс применения",
    value: "подвесные изделия; бра; ночники",
  }]);
  assertEquals(resolved?.text.includes("подвесные изделия; бра; ночники"), true);
  assertEquals(resolved?.text.includes("бытовые изделия накладные"), false);
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
  const resolved = resolveDerivedSelectionReasoning({
    reasoning: "Выбираю подходящий вариант по указанному способу установки.",
    compatible_classifications: ["f0v1"],
    excluded_classifications: [],
  }, liveFacets, "Нужно не подвесное, а накладное изделие");

  assertEquals(resolved?.compatible, [{ key: "Класс применения", value: "накладные изделия" }]);
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
  const resolved = resolveDerivedSelectionReasoning({
    reasoning: "Расчёт даёт диапазон 3000–4000 единиц. Подойдут накладные или трековые системы, но не подвесные.",
    compatible_classifications: ["f0v2"],
    excluded_classifications: [],
  }, liveFacets, "Заменить подвесное изделие на энергоэффективное");

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
  const source = Deno.readTextFileSync(new URL("./selection-actionability.ts", import.meta.url)).toLocaleLowerCase("ru-RU");
  for (const forbidden of ["термоус", "люстр", "ламп", "кабель", "korn", "corn"]) {
    assertEquals(source.includes(forbidden), false);
  }
});

Deno.test("optional preference after discovery cannot block a selection", () => {
  assertEquals(shouldContinueSelectionPastOptionalClarification({
    intentMode: "select",
    hasDiscovery: true,
    userMessage: "Нужно решение для комнаты 25 м². Что подойдет?",
    question: "Какой тип исполнения рассматриваете?",
    facetKey: "vid_ispolneniya__s",
    options: [{ value: "Первый" }, { value: "Второй" }],
  }), true);
});

Deno.test("objective clarification remains allowed", () => {
  assertEquals(shouldContinueSelectionPastOptionalClarification({
    intentMode: "select",
    hasDiscovery: true,
    userMessage: "Нужно решение для оборудования",
    question: "Какую мощность нагрузки рассматриваете?",
    facetKey: "moshchnost__v",
    options: [{ value: "1" }, { value: "2" }],
  }), false);
});

Deno.test("customer-owned alternative remains a valid clarification", () => {
  assertEquals(shouldContinueSelectionPastOptionalClarification({
    intentMode: "select",
    hasDiscovery: true,
    userMessage: "Не знаю, выбрать белый или черный",
    question: "Какой цвет предпочитаете?",
    facetKey: "cvet__s",
    options: [{ value: "Белый" }, { value: "Черный" }],
  }), false);
});

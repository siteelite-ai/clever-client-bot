import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  applyCriteriaGate,
  type Criterion,
  extendSelectionCriteriaPlan,
  mergeMandatorySelectionCriteria,
  overlayMandatoryFacetOptions,
  projectAdvisoryCriteriaFacetOptions,
  projectCriteriaFacetOptions,
  relaxModelDerivedSelectionCriteriaPlan,
  resolveTerminalSelectionCriteria,
} from "./criteria-gate.ts";
import type { ProductRef } from "./types.ts";
import { alignCriteriaImportanceWithReasoning } from "./criteria-reasoning.ts";
import {
  buildDerivedSelectionPublicExplanation,
  buildDerivedSelectionReasoningMessages,
  buildDerivedSelectionReasoningToolSchema,
  compileApplicationSuitabilityAlternatives,
  compileCustomerClassificationCriteria,
  derivedReasoningPublicEgress,
  derivedMeasurementMayConstrainIndividualProducts,
  hasActionableSelectionContract,
  hasCompetingMeasuredSelectionTiers,
  hasSelectionMeasurementContext,
  hasSelectionSuitabilityContext,
  hasUnresolvedEnvironmentalProtectionObligation,
  measuredSelectionContractEvidence,
  preferCustomerGroundedLiveClassification,
  reasoningComputesSystemTotalFromSpatialExtent,
  demoteUnsupportedSystemTotalClaims,
  reconcileDerivedRequiredFacetSummary,
  resolveDerivedSelectionReasoning,
  suppressDerivedReasoningEcho,
  shouldContinueSelectionPastOptionalClarification,
  shouldFinalizeDerivedSelectionSearch,
  shouldProjectDerivedScalarMeasurement,
  shouldQueueDirectCustomerFacetSearch,
  shouldRequireDerivedSelectionReasoning,
  systemTotalReasoningDeclaresPerProductMeasurement,
} from "./selection-actionability.ts";

Deno.test("derived selection keeps malformed model planning private while explaining frozen criteria", () => {
  const rawPlan =
    "Клиент запросил двойные черные розетки Gallant. д. ). Сначала проверю фасеты, затем каталог.";
  const declaration = resolveDerivedSelectionReasoning({
    reasoning: rawPlan,
    compatible_classifications: [],
    excluded_classifications: [],
    required_facet_values: [],
  }, [], "Нужны двойные черные розетки Gallant", "Розетки");
  assertEquals(declaration?.reasoningEvidence.includes("Клиент запросил"), true);
  assertEquals(declaration?.text, declaration?.reasoningEvidence);
  const publicExplanation = buildDerivedSelectionPublicExplanation({
    productClass: "Розетки",
    frozenCriteria: [
      {
        key: "Бренд",
        op: "eq",
        value: "Gallant",
        level: "A",
        evidence: "user_explicit",
      },
      {
        key: "Количество разъёмов",
        op: "eq",
        value: "2",
        level: "A",
        evidence: "user_explicit",
      },
      {
        key: "Цвет",
        op: "eq",
        value: "чёрный",
        level: "B",
        evidence: "model_assumption",
      },
      {
        key: "Модельная гипотеза без источника",
        op: "eq",
        value: "не проверено",
        level: "A",
      },
    ],
  });
  assertEquals(publicExplanation.includes("Клиент запросил"), false);
  assertEquals(publicExplanation.includes("д. )."), false);
  assertEquals(publicExplanation.includes("Бренд: Gallant"), true);
  assertEquals(publicExplanation.includes("Количество разъёмов: 2"), true);
  assertEquals(publicExplanation.includes("Цвет: чёрный"), false);
  assertEquals(publicExplanation.includes("Модельная гипотеза"), false);
  assertEquals(/(?:наш[её]л|подтвержден[а-я]*\s+товар)/iu.test(publicExplanation), false);
});

Deno.test("public explanation renders same-facet exact alternatives as one OR clause", () => {
  const publicExplanation = buildDerivedSelectionPublicExplanation({
    productClass: "Прожекторы",
    frozenCriteria: [
      {
        key: "Степень защиты",
        op: "eq",
        value: "IP44",
        level: "A",
        evidence: "derived_required",
      },
      {
        key: "Бренд",
        op: "eq",
        value: "IEK",
        level: "A",
        evidence: "user_explicit",
      },
      {
        key: "степень защиты",
        op: "eq",
        value: "IP54",
        level: "A",
        evidence: "derived_required",
      },
      {
        key: "Степень защиты",
        op: "eq",
        value: "IP65",
        level: "A",
        evidence: "derived_required",
      },
      {
        key: "Степень защиты",
        op: "eq",
        value: "IP65",
        level: "A",
        evidence: "derived_required",
      },
      {
        key: "Датчик движения",
        op: "eq",
        value: "Да",
        level: "A",
        evidence: "model_assumption",
      },
    ],
  });
  assertEquals(
    publicExplanation.includes(
      "«Степень защиты: одно из значений IP44, IP54 или IP65»",
    ),
    true,
  );
  assertEquals(publicExplanation.includes("«Бренд: IEK»"), true);
  assertEquals(publicExplanation.includes("; «Степень защиты:"), false);
  assertEquals(publicExplanation.includes("Датчик движения"), false);
  assertEquals((publicExplanation.match(/Степень защиты:/gu) ?? []).length, 1);
});

Deno.test("public explanation preserves singleton wording and six-clause cap", () => {
  const singleton = buildDerivedSelectionPublicExplanation({
    frozenCriteria: [
      {
        key: "Степень защиты",
        op: "eq",
        value: "IP65",
        level: "A",
        evidence: "user_explicit",
      },
    ],
  });
  assertEquals(singleton.includes("«Степень защиты: IP65»"), true);
  assertEquals(singleton.includes("одно из значений"), false);

  const capped = buildDerivedSelectionPublicExplanation({
    frozenCriteria: [
      {
        key: "Степень защиты",
        op: "eq",
        value: "IP44",
        level: "A",
        evidence: "derived_required",
      },
      {
        key: "Степень защиты",
        op: "eq",
        value: "IP65",
        level: "A",
        evidence: "derived_required",
      },
      ...Array.from({ length: 6 }, (_, index) => ({
        key: `Параметр ${index + 1}`,
        op: "eq" as const,
        value: `Значение ${index + 1}`,
        level: "A" as const,
        evidence: "user_explicit" as const,
      })),
    ],
  });
  assertEquals(capped.includes("одно из значений IP44 или IP65"), true);
  assertEquals(capped.includes("Параметр 5: Значение 5"), true);
  assertEquals(capped.includes("Параметр 6: Значение 6"), false);
  assertEquals(capped.includes("и ещё 1"), true);
});

Deno.test("later model text cannot replay a derived scratchpad but ordinary text survives", () => {
  const privateReasoning =
    "Клиент запросил подбор двойных розеток Gallant. Сначала проверю фасеты, затем поиск по каталогу.";
  assertEquals(
    suppressDerivedReasoningEcho(
      `Проверка завершена. ${privateReasoning} Уточните цвет.`,
      privateReasoning,
    ),
    { text: "Проверка завершена. Уточните цвет.", suppressed: true },
  );
  assertEquals(
    suppressDerivedReasoningEcho(
      "Клиенту можно предложить уточнить цвет корпуса.",
      privateReasoning,
    ),
    {
      text: "Клиенту можно предложить уточнить цвет корпуса.",
      suppressed: false,
    },
  );
});

Deno.test("echo guard preserves repeated engineering fit while removing only private planning", () => {
  const fit =
    "Для кабеля диаметром 10 мм внутренний диаметр трубки до усадки должен быть строго больше 10 мм, а после усадки — меньше 10 мм.";
  const privateReasoning =
    `Клиент запросил подбор, сначала проверю фасеты. ${fit}`;
  assertEquals(
    suppressDerivedReasoningEcho(fit, privateReasoning),
    { text: fit, suppressed: false },
  );
  assertEquals(
    suppressDerivedReasoningEcho(privateReasoning, privateReasoning),
    { text: fit, suppressed: true },
  );
});

Deno.test("echo guard keeps engineering evidence in the same sentence as a private plan", () => {
  const oneSentence =
    "Клиент запросил подбор, сначала проверю фасеты, для кабеля диаметром 10 мм внутренний диаметр трубки до усадки должен быть строго больше 10 мм, а после усадки меньше 10 мм.";
  const result = suppressDerivedReasoningEcho(oneSentence, oneSentence);
  assertEquals(result.suppressed, true);
  assertEquals(/Клиент запросил|сначала проверю фасеты/iu.test(result.text), false);
  assertEquals(result.text.includes("диаметром 10 мм"), true);
  assertEquals(result.text.includes("строго больше 10 мм"), true);
  assertEquals(result.text.includes("после усадки меньше 10 мм"), true);
  const numericClause =
    "Клиент запросил подбор, внутренний диаметр до усадки > 10 мм, после усадки < 10 мм.";
  const numericResult = suppressDerivedReasoningEcho(
    numericClause,
    numericClause,
  );
  assertEquals(numericResult.text.includes("диаметр до усадки > 10 мм"), true);
  assertEquals(numericResult.text.includes("после усадки < 10 мм"), true);
  assertEquals(numericResult.text.includes("Клиент запросил"), false);
  const nounTail =
    "Клиент запросил подбор ТТУ для кабеля 10 мм, поэтому внутренний диаметр до усадки должен быть больше 10 мм.";
  const nounTailResult = suppressDerivedReasoningEcho(nounTail, nounTail);
  assertEquals(nounTailResult.suppressed, true);
  assertEquals(
    nounTailResult.text,
    "Поэтому внутренний диаметр до усадки должен быть больше 10 мм.",
  );
  const noBoundary =
    "Клиент запросил подбор ТТУ для кабеля 10 мм внутренний диаметр должен быть больше 10 мм.";
  const noBoundaryResult = suppressDerivedReasoningEcho(
    noBoundary,
    noBoundary,
  );
  assertEquals(noBoundaryResult.text.includes("должен быть больше 10 мм"), true);
  assertEquals(noBoundaryResult.text.includes("Клиент запросил"), false);
});

Deno.test("private-plan-only final gets a neutral fallback without cards, not after cards", () => {
  const draft = "Клиент запросил подбор, сначала проверю фасеты.";
  const empty = derivedReasoningPublicEgress({
    candidate: draft,
    privateReasoning: draft,
    isFinalTurn: true,
    catalogLookupCompleted: true,
    productsRendered: 0,
  });
  assertEquals(empty.suppressed, true);
  assertEquals(empty.text.includes("Не смог подтвердить"), true);
  assertEquals(empty.text.includes("Клиент запросил"), false);
  assertEquals(derivedReasoningPublicEgress({
    candidate: draft,
    privateReasoning: draft,
    isFinalTurn: true,
    catalogLookupCompleted: true,
    productsRendered: 2,
  }), { text: "", suppressed: true });
});

Deno.test("derived public explanation preserves strict paired bounds without model scratchpad", () => {
  const publicExplanation = buildDerivedSelectionPublicExplanation({
    productClass: "Изоляционные изделия",
    frozenCriteria: [
      {
        key: "Диаметр до изменения",
        op: "min",
        value: 10,
        unit: "мм",
        exclusive: true,
        level: "A",
        evidence: "derived_required",
      },
      {
        key: "Диаметр после изменения",
        op: "max",
        value: 10,
        unit: "мм",
        exclusive: true,
        level: "A",
        evidence: "derived_required",
      },
    ],
    pairedFit: {
      value: 10,
      unit: "мм",
      beforeCaption: "Внутренний диаметр до усадки, мм",
      afterCaption: "Внутренний диаметр после усадки, мм",
    },
  });
  assertEquals(publicExplanation.includes("Внутренний диаметр до усадки, мм > 10 мм"), true);
  assertEquals(publicExplanation.includes("Внутренний диаметр после усадки, мм < 10 мм"), true);
  assertEquals(publicExplanation.includes("≥ 10 мм"), false);
  assertEquals(publicExplanation.includes("≤ 10 мм"), false);
});

Deno.test("public paired explanation states the verified cable sleeve clearance instead of only > D", () => {
  const text = buildDerivedSelectionPublicExplanation({
    productClass: "Трубки термоусаживаемые",
    frozenCriteria: [],
    pairedFit: {
      value: 12,
      unit: "мм",
      beforeCaption: "Внутренний диаметр до усадки, мм",
      afterCaption: "Внутренний диаметр после усадки, мм",
      clearance: { before_facet_key: "before", minimum_before_ratio: { numerator: 6, denominator: 5 } },
    },
  });
  assertEquals(text.includes("≥ 1,2 × 12 мм (запас 20%)"), true);
  assertEquals(text.includes("< 12 мм"), true);
  assertEquals(text.includes("> 12 мм"), false);
});

Deno.test("derived pre-search explanation with no frozen criteria never promises a match", () => {
  const publicExplanation = buildDerivedSelectionPublicExplanation({
    productClass: "Розетки",
    frozenCriteria: [],
    measurementScope: "system_total",
  });
  assertEquals(publicExplanation.includes("Сверяю заявленные условия"), true);
  assertEquals(publicExplanation.includes("Суммарную потребность"), true);
  assertEquals(/(?:найден|подходят|прошли проверку)/iu.test(publicExplanation), false);
});

Deno.test("unspecified mixed-facet values in model reasoning never become mandatory", () => {
  const schemas = [
    [
      {
        key: "length",
        caption: "Длина кабеля, м",
        values: ["нет", "1", "3"].map((value) => ({ value })),
      },
      {
        key: "outlets",
        caption: "Количество розеток",
        values: ["нет", "2", "4"].map((value) => ({ value })),
      },
    ],
    [
      {
        key: "mount",
        caption: "Способ монтажа",
        values: ["нет", "накладной", "встраиваемый"].map((value) => ({
          value,
        })),
      },
      {
        key: "body",
        caption: "Материал корпуса",
        values: ["не указано", "металл", "пластик"].map((value) => ({ value })),
      },
    ],
  ];
  const customers = [
    "Предложи несколько вариантов на выбор",
    "Покажи ассортимент и варианты",
  ];
  for (const [index, facets] of schemas.entries()) {
    const customer = customers[index];
    const reasoning = facets.map((facet) =>
      `${facet.caption}: ${facet.values[0].value}`
    )
      .join("; ") + ". Предложу несколько вариантов на выбор.";
    const schema = buildDerivedSelectionReasoningToolSchema(facets, customer);
    const properties = schema.function.parameters.properties as Record<
      string,
      { items?: { enum?: string[] } }
    >;
    assertEquals(
      properties.required_facet_values.items?.enum?.includes("f0v0") ?? false,
      false,
    );
    assertEquals(
      properties.required_facet_values.items?.enum?.includes("f1v0") ?? false,
      false,
    );
    const result = resolveDerivedSelectionReasoning(
      {
        reasoning,
        measurement_scope: "not_applicable",
        compatible_classifications: [],
        excluded_classifications: [],
        required_facet_values: ["f0v0", "f1v0"],
        explicit_customer_classifications: [],
      },
      facets,
      customer,
    );
    assertEquals(result?.requiredFacetValues, []);
    assertEquals(result?.text.includes("Обязательные параметры"), false);
  }
});

Deno.test("a customer-owned absence survives mixed live facet reasoning", () => {
  const facets = [{
    key: "grounding",
    caption: "Наличие заземления",
    values: [{ value: "да" }, { value: "нет" }, { value: "не указано" }],
  }];
  const customer = "Нужен вариант без заземления";
  const schema = buildDerivedSelectionReasoningToolSchema(facets, customer);
  const properties = schema.function.parameters.properties as Record<
    string,
    { items?: { enum?: string[] } }
  >;
  assertEquals(
    properties.required_facet_values.items?.enum?.includes("f0v1"),
    true,
  );
  assertEquals(
    properties.required_facet_values.items?.enum?.includes("f0v2"),
    false,
  );
  const result = resolveDerivedSelectionReasoning(
    {
      reasoning:
        "Для вашего условия наличие заземления: нет; такой вариант подходит без заземления.",
      measurement_scope: "not_applicable",
      compatible_classifications: [],
      excluded_classifications: [],
      required_facet_values: ["f0v1"],
      explicit_customer_classifications: [],
    },
    facets,
    customer,
  );
  assertEquals(result?.requiredFacetValues, [{
    key: "Наличие заземления",
    value: "нет",
  }]);
});

Deno.test("replacement reasoning shows only executable exact requirements after advice is demoted", () => {
  const facets = [
    {
      key: "poles",
      caption: "Количество полюсов",
      values: ["1", "2", "3"].map((value) => ({ value })),
    },
    {
      key: "voltage",
      caption: "Номинальное напряжение",
      values: ["230-400", "220-240"].map((value) => ({ value })),
    },
    {
      key: "trip",
      caption: "Характеристика срабатывания",
      values: ["B", "C"].map((value) => ({ value })),
    },
    {
      key: "current",
      caption: "Номинальный ток",
      values: ["16", "25"].map((value) => ({ value })),
    },
  ];
  const declaration = resolveDerivedSelectionReasoning(
    {
      reasoning:
        "Характеристика срабатывания: C и номинальный ток: 16 указаны в маркировке C16. Количество полюсов: 1 — лишь типовой вариант, можно выбрать 2. Номинальное напряжение: 230-400 — тоже пример; его нужно сверить с конкретной схемой.",
      compatible_classifications: [],
      excluded_classifications: [],
      required_facet_values: ["f0v0", "f1v0", "f2v1", "f3v0"],
    },
    facets,
    "Есть ли аналог автомату Schneider Electric Acti9 C16?",
  );
  if (!declaration) throw new Error("expected a valid live-facet declaration");
  for (
    const key of [
      "Количество полюсов",
      "Номинальное напряжение",
      "Характеристика срабатывания",
      "Номинальный ток",
    ]
  ) {
    assertEquals(
      declaration.requiredFacetValues.some((choice) => choice.key === key),
      true,
      key,
    );
  }
  const proposed = declaration.requiredFacetValues.map(({ key, value }) => ({
    key,
    op: "eq" as const,
    value,
    level: "A" as const,
  }));
  const customerBacked: Criterion[] = [
    {
      key: "Характеристика срабатывания",
      op: "eq",
      value: "C",
      level: "A",
      evidence: "user_explicit",
    },
    {
      key: "Номинальный ток",
      op: "eq",
      value: "16",
      level: "A",
      evidence: "user_explicit",
    },
  ];
  const importance = alignCriteriaImportanceWithReasoning(
    proposed,
    declaration.measurementEvidence,
    customerBacked,
  );
  assertEquals(importance.demoted.includes("Количество полюсов"), true);
  assertEquals(importance.demoted.includes("Номинальное напряжение"), true);
  const frozen = mergeMandatorySelectionCriteria([
    ...customerBacked,
    ...importance.criteria.map((criterion) => ({
      ...criterion,
      evidence: criterion.level === "A"
        ? "derived_required" as const
        : "model_assumption" as const,
    })),
  ]);
  assertEquals(frozen.map((criterion) => criterion.key).sort(), [
    "Номинальный ток",
    "Характеристика срабатывания",
  ]);
  const visible = reconcileDerivedRequiredFacetSummary(declaration, frozen);
  assertEquals(
    visible.text.includes(
      "Обязательные параметры: «Характеристика срабатывания: C»",
    ),
    true,
  );
  assertEquals(visible.text.includes("«Номинальный ток: 16»"), true);
  assertEquals(visible.text.includes("«Количество полюсов: 1»"), false);
  assertEquals(
    visible.text.includes("«Номинальное напряжение: 230-400»"),
    false,
  );
  assertEquals(
    visible.text.includes("Количество полюсов: 1 — лишь типовой вариант"),
    true,
  );
});

Deno.test("explicit replacement pole remains mandatory while unconfirmed voltage does not", () => {
  const declaration = {
    text:
      "Количество полюсов: 1 указано покупателем. Номинальное напряжение: 230-400 — типовой ориентир. Обязательные параметры: «Количество полюсов: 1»; «Номинальное напряжение: 230-400»; «Номинальный ток: 16».",
    requiredFacetValues: [
      { key: "Количество полюсов", value: "1" },
      { key: "Номинальное напряжение", value: "230-400" },
      { key: "Номинальный ток", value: "16" },
    ],
  };
  const frozen = mergeMandatorySelectionCriteria([
    {
      key: "Количество полюсов",
      op: "eq",
      value: "1",
      level: "A",
      evidence: "user_explicit",
    },
    {
      key: "Номинальное напряжение",
      op: "eq",
      value: "230-400",
      level: "B",
      evidence: "model_assumption",
    },
    {
      key: "Номинальный ток",
      op: "eq",
      value: "16",
      level: "A",
      evidence: "user_explicit",
    },
  ]);
  const visible = reconcileDerivedRequiredFacetSummary(declaration, frozen);
  assertEquals(visible.text.includes("«Количество полюсов: 1»"), true);
  assertEquals(visible.text.includes("«Номинальный ток: 16»"), true);
  assertEquals(
    visible.text.includes("«Номинальное напряжение: 230-400»"),
    false,
  );
  assertEquals(visible.text.includes("230-400 — типовой ориентир"), true);
});

Deno.test("required-summary reconciliation is facet-agnostic and preserves free explanations", () => {
  const declaration = {
    text:
      "Для жилой комнаты можно взять тёплый свет; материал корпуса пока неизвестен. Обязательные параметры: «Цветовая температура: 3000 K»; «Цвет корпуса: белый».\nСледующий шаг — поиск по каталогу.",
    requiredFacetValues: [
      { key: "Цветовая температура", value: "3000 K" },
      { key: "Цвет корпуса", value: "белый" },
    ],
  };
  const visible = reconcileDerivedRequiredFacetSummary(declaration, [
    {
      key: "Цветовая температура",
      op: "eq",
      value: "3000 K",
      level: "A",
      evidence: "derived_required",
    },
    {
      key: "Цвет корпуса",
      op: "eq",
      value: "белый",
      level: "B",
      evidence: "model_assumption",
    },
  ]);
  assertEquals(visible.text.includes("«Цветовая температура: 3000 K»"), true);
  assertEquals(visible.text.includes("«Цвет корпуса: белый»"), false);
  assertEquals(visible.text.includes("\nСледующий шаг"), true);
  assertEquals(visible.text.includes("материал корпуса пока неизвестен"), true);
});

Deno.test("exact customer class outranks mixed-use description across product families", () => {
  const cases = [
    {
      key: "Вид светильника",
      exact: "Бытовые светильники накладные",
      mixed: "Светильники для ЖКХ",
      title: "Светильник с датчиком движения",
    },
    {
      key: "Класс применения",
      exact: "Бытовые источники питания",
      mixed: "Для офисной техники",
      title: "Источник питания",
    },
  ];
  for (const item of cases) {
    const exact: Criterion = {
      key: item.key,
      op: "eq",
      value: item.exact,
      level: "A",
      evidence: "user_explicit",
    };
    const application: Criterion = {
      key: item.key,
      op: "eq",
      value: "бытовой",
      level: "A",
      evidence: "user_explicit",
      proof_scope: "application_suitability",
    };
    const product = (
      id: string,
      classification: string,
      description: string,
    ): ProductRef => ({
      id,
      pagetitle: `${item.title} ${id}`,
      vendor: null,
      price: 3000,
      stock: "in_stock",
      short_traits: [`${item.key}: ${classification}`],
      description_excerpt: description,
    });
    const candidates = [
      product("mixed", item.mixed, "Для общественного и бытового применения."),
      product("exact", item.exact, "Для бытового применения."),
      {
        ...product("title-only", item.mixed, "Для бытового применения."),
        pagetitle: `${item.exact} title-only`,
        short_traits: [],
      },
      {
        ...product("contradictory", item.mixed, "Для бытового применения."),
        pagetitle: `${item.exact} contradictory`,
      },
    ];
    assertEquals(
      applyCriteriaGate(candidates, [exact, application]).passed_ids,
      ["mixed", "exact", "title-only", "contradictory"],
    );
    const ranked = preferCustomerGroundedLiveClassification(
      candidates,
      [exact],
      [application],
    );
    assertEquals(ranked.products.map(({ id }) => id), ["exact"]);
    assertEquals(ranked.tier, "exact_live_class");
    assertEquals(ranked.excludedCount, 0);
  }
});

Deno.test("a prose-only application alternative is labelled when exact class is empty", () => {
  const exact: Criterion = {
    key: "Класс применения",
    op: "eq",
    value: "Бытовые приборы",
    level: "A",
    evidence: "user_explicit",
  };
  const application: Criterion = {
    key: "Класс применения",
    op: "eq",
    value: "бытовой",
    level: "A",
    evidence: "user_explicit",
    proof_scope: "application_suitability",
  };
  const mixed: ProductRef = {
    id: "mixed",
    pagetitle: "Бытовые приборы — универсальный",
    vendor: null,
    price: 3000,
    stock: "in_stock",
    short_traits: ["Класс применения: Для учреждений"],
    description_excerpt: "Для общественного и бытового применения.",
  };
  assertEquals(
    applyCriteriaGate([mixed], [exact, application]).passed_ids,
    ["mixed"],
  );
  const ranked = preferCustomerGroundedLiveClassification(
    [mixed],
    [exact],
    [application],
  );
  assertEquals(ranked.products.map(({ id }) => id), ["mixed"]);
  assertEquals(ranked.tier, "application_text_fallback");
});

Deno.test("explicit class exclusion vetoes prose fallback before preference", () => {
  const exact: Criterion = {
    key: "Класс применения",
    op: "eq",
    value: "Бытовые приборы",
    level: "A",
    evidence: "user_explicit",
  };
  const application: Criterion = {
    key: "Класс применения",
    op: "eq",
    value: "бытовой",
    level: "A",
    evidence: "user_explicit",
    proof_scope: "application_suitability",
  };
  const explicitExclusion: Criterion = {
    key: "Класс применения",
    op: "eq",
    value: "Для учреждений",
    level: "A",
    evidence: "user_explicit",
  };
  const mixed: ProductRef = {
    id: "mixed",
    pagetitle: "Прибор универсальный",
    vendor: null,
    price: 3000,
    stock: "in_stock",
    short_traits: ["Класс применения: Для учреждений"],
    description_excerpt: "Для общественного и бытового применения.",
  };
  const ranked = preferCustomerGroundedLiveClassification(
    [mixed],
    [exact],
    [application],
    [explicitExclusion],
  );
  assertEquals(ranked.products, []);
  assertEquals(ranked.tier, "no_eligible_products");
  assertEquals(ranked.excludedCount, 1);
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
  assertEquals(system.includes("неполная выборка кандидатов"), true);
});

Deno.test("derived prompt adds 20% only for live heat-shrink cable fit", () => {
  const facets = [
    { key: "before", caption: "Внутренний диаметр до усадки, мм", unit: "мм", values: [] },
    { key: "after", caption: "Внутренний диаметр после усадки, мм", unit: "мм", values: [] },
  ];
  const reference = { value: 12, unit: "мм", facetKeys: ["before", "after"] };
  const strict = buildDerivedSelectionReasoningMessages(
    "подбери трубку для кабеля диаметром 12 мм",
    "Трубки термоусаживаемые",
    facets,
    reference,
  )[0].content;
  assertEquals(strict.includes("не менее 120% диаметра кабеля"), true);
  assertEquals(strict.includes("минимум 14,4 мм до усадки"), true);
  assertEquals(strict.includes("Размер изделия до установки должен быть строго больше размера объекта"), false);
  assertEquals(strict.includes("два строгих неравенства"), false);
  const unrelated = buildDerivedSelectionReasoningMessages(
    "подбери изделие для кабеля диаметром 12 мм",
    "Изделия",
    facets,
    reference,
  )[0].content;
  assertEquals(unrelated.includes("не менее 120% диаметра кабеля"), false);
  assertEquals(unrelated.includes("Размер изделия до установки должен быть строго больше размера объекта"), true);
});

Deno.test("paired object size is not offered as an exact pre-search enum, while unrelated exact facets remain", () => {
  const facets = [{
    key: "size_before",
    caption: "Диаметр до изменения, мм",
    unit: "мм",
    values: [{ value: "10" }, { value: "12" }],
  }, {
    key: "size_after",
    caption: "Диаметр после изменения, мм",
    unit: "мм",
    values: [{ value: "10" }, { value: "8" }],
  }, {
    key: "nominal_voltage",
    caption: "Номинальное напряжение, В",
    unit: "В",
    values: [{ value: "220" }, { value: "110" }],
  }];
  const reference = {
    value: 10,
    unit: "мм",
    facetKeys: ["size_before", "size_after"],
  };
  const customer = "Нужен товар для кабеля диаметром 10 мм, напряжение 220 В";
  const messages = buildDerivedSelectionReasoningMessages(
    customer,
    "Товары",
    facets,
    reference,
  );
  const schema = JSON.parse(messages[1].content.split("(JSON):\n")[1]);
  assertEquals(schema.facets[0].values, []);
  assertEquals(schema.facets[1].values, []);
  assertEquals(schema.facets[2].values, [{ id: "f2v0", value: "220" }]);
  const tool = buildDerivedSelectionReasoningToolSchema(
    facets,
    customer,
    reference,
  );
  const properties = tool.function.parameters.properties as Record<
    string,
    { items: { enum?: string[] } }
  >;
  assertEquals(
    properties.required_facet_values.items.enum?.includes("f0v0"),
    false,
  );
  assertEquals(
    properties.required_facet_values.items.enum?.includes("f1v0"),
    false,
  );
  assertEquals(
    properties.required_facet_values.items.enum?.includes("f2v0"),
    true,
  );
  // Without verified paired context, direct exact product requests retain
  // their normal evidence path.
  const direct = buildDerivedSelectionReasoningMessages(
    "Нужен товар с диаметром до изменения 10 мм",
    "Товары",
    facets,
  );
  const directSchema = JSON.parse(direct[1].content.split("(JSON):\n")[1]);
  assertEquals(
    directSchema.facets[0].values.some(({ value }: { value: string }) =>
      value === "10"
    ),
    true,
  );
});

Deno.test("paired pre-search reasoning keeps strict bounds but drops speculative schema and shortage claims", () => {
  const facets = [{
    key: "before",
    caption: "Внутренний диаметр до изменения, мм",
    unit: "мм",
    values: [{ value: "10" }, { value: "12" }],
  }, {
    key: "after",
    caption: "Внутренний диаметр после изменения, мм",
    unit: "мм",
    values: [{ value: "10" }, { value: "8" }],
  }];
  const declaration = resolveDerivedSelectionReasoning(
    {
      reasoning:
        "Клиент указал диаметр объекта 10 мм. До изменения внутренний диаметр изделия должен быть строго больше 10 мм, а после изменения строго меньше 10 мм. В схеме есть значение диаметра до изменения = 10 мм. Для объекта 10 мм требуется диаметр до изменения не менее 12–15 мм. Данных для точного выбора типоразмера недостаточно; необходимо проверить значения товаров.",
      required_facet_values: ["f0v0", "f1v0"],
      compatible_classifications: [],
      excluded_classifications: [],
    },
    facets,
    "объект диаметром 10 мм",
    "Изделия",
    {
      value: 10,
      unit: "мм",
      facetKeys: ["before", "after"],
    },
  );
  assertEquals(declaration?.text.includes("строго больше 10 мм"), true);
  assertEquals(declaration?.text.includes("строго меньше 10 мм"), true);
  assertEquals(declaration?.text.includes("В схеме"), false);
  assertEquals(declaration?.text.includes("12–15"), false);
  assertEquals(declaration?.text.includes("Данных для точного выбора"), false);
  assertEquals(declaration?.requiredFacetValues, []);
  const inlineSchemaClaim = resolveDerivedSelectionReasoning(
    {
      reasoning:
        "Для кабеля 10 мм внутренний диаметр до усадки строго больше 10 мм, после усадки строго меньше 10 мм, в схеме есть значение 10 мм.",
      required_facet_values: [],
    },
    facets,
    "кабель диаметром 10 мм",
    "Изделия",
    {
      value: 10,
      unit: "мм",
      facetKeys: ["before", "after"],
    },
  );
  assertEquals(inlineSchemaClaim?.text.includes("строго больше 10 мм"), true);
  assertEquals(inlineSchemaClaim?.text.includes("строго меньше 10 мм"), true);
  assertEquals(
    inlineSchemaClaim?.text.includes("в схеме есть значение"),
    false,
  );
  for (
    const trailingClaim of [
      ", но в схеме есть значение 10 мм",
      " и в схеме есть значение 10 мм",
      ", но данных для точного выбора типоразмера недостаточно",
    ]
  ) {
    const result = resolveDerivedSelectionReasoning(
      {
        reasoning:
          `Для кабеля 10 мм внутренний диаметр до усадки строго больше 10 мм, после усадки строго меньше 10 мм${trailingClaim}.`,
        required_facet_values: [],
      },
      facets,
      "кабель диаметром 10 мм",
      "Изделия",
      {
        value: 10,
        unit: "мм",
        facetKeys: ["before", "after"],
      },
    );
    assertEquals(result?.text.includes("строго больше 10 мм"), true);
    assertEquals(result?.text.includes("строго меньше 10 мм"), true);
    assertEquals(result?.text.includes("в схеме есть значение"), false);
    assertEquals(result?.text.includes("данных для точного выбора"), false);
  }
});

Deno.test("paired fit does not authorize a model-only hard size on the same live facet", () => {
  const facets = [{
    key: "before",
    caption: "Внутренний диаметр до изменения, мм",
    unit: "мм",
    values: [{ value: "10" }, { value: "14" }],
  }, {
    key: "after",
    caption: "Внутренний диаметр после изменения, мм",
    unit: "мм",
    values: [{ value: "8" }, { value: "10" }],
  }];
  const declaration = resolveDerivedSelectionReasoning(
    {
      reasoning:
        "Для объекта 10 мм внутренний диаметр до изменения строго больше 10 мм, а после изменения строго меньше 10 мм. Внутренний диаметр до изменения должен быть строго больше 14 мм.",
      required_facet_values: [],
    },
    facets,
    "объект диаметром 10 мм",
    "Изделия",
    { value: 10, unit: "мм", facetKeys: ["before", "after"] },
  );
  assertEquals(declaration?.text.includes("строго больше 10 мм"), true);
  assertEquals(declaration?.text.includes("строго меньше 10 мм"), true);
  assertEquals(declaration?.text.includes("строго больше 14 мм"), false);
});

Deno.test("paired uncertainty guard preserves customer-data gaps and decimal bounds; empty schema is safe", () => {
  const facets = [{
    key: "before",
    caption: "Диаметр до изменения, мм",
    unit: "мм",
    values: [{ value: "10.5" }, { value: "12" }],
  }, {
    key: "after",
    caption: "Диаметр после изменения, мм",
    unit: "мм",
    values: [{ value: "10.5" }, { value: "8" }],
  }];
  const reasoning =
    "Для объекта диаметром 10.5 мм диаметр до изменения должен быть строго больше 10.5 мм, после изменения строго меньше 10.5 мм. Данных клиента недостаточно для точного выбора безопасного температурного режима.";
  const declaration = resolveDerivedSelectionReasoning(
    {
      reasoning,
      required_facet_values: [],
    },
    facets,
    "объект диаметром 10.5 мм",
    "Изделия",
    {
      value: 10.5,
      unit: "мм",
      facetKeys: ["before", "after"],
    },
  );
  assertEquals(declaration?.text.includes("строго больше 10.5 мм"), true);
  assertEquals(declaration?.text.includes("строго меньше 10.5 мм"), true);
  assertEquals(declaration?.text.includes("Данных клиента недостаточно"), true);
  const messages = buildDerivedSelectionReasoningMessages(
    "объект 10 мм",
    "",
    [],
    { value: 10, unit: "мм", facetKeys: ["before", "after"] },
  );
  assertEquals(messages.length, 2);
  assertEquals(
    JSON.parse(messages[1].content.split("(JSON):\n")[1]).facets,
    [],
  );
});

Deno.test("optional same-unit tier after a semicolon cannot erase either strict paired bound", () => {
  const facets = [{
    key: "before",
    caption: "Внутренний диаметр до изменения, мм",
    unit: "мм",
    values: [{ value: "10" }, { value: "12" }],
  }, {
    key: "after",
    caption: "Внутренний диаметр после изменения, мм",
    unit: "мм",
    values: [{ value: "10" }, { value: "8" }],
  }];
  const declaration = resolveDerivedSelectionReasoning(
    {
      reasoning:
        "Для кабеля 10 мм внутренний диаметр до усадки строго больше 10 мм; после усадки строго меньше 10 мм, оптимально 12 мм.",
      required_facet_values: [],
    },
    facets,
    "кабель диаметром 10 мм",
    "Изделие",
    {
      value: 10,
      unit: "мм",
      facetKeys: ["before", "after"],
    },
  );
  assertEquals(declaration?.text.includes("строго больше 10 мм"), true);
  assertEquals(declaration?.text.includes("строго меньше 10 мм"), true);
  assertEquals(declaration?.text.includes("оптимально 12 мм"), false);
  const intertwined = resolveDerivedSelectionReasoning(
    {
      reasoning:
        "До изменения диаметр строго больше 10 мм, оптимально 12 мм, после изменения строго меньше 10 мм.",
      required_facet_values: [],
    },
    facets,
    "кабель диаметром 10 мм",
    "Изделие",
    {
      value: 10,
      unit: "мм",
      facetKeys: ["before", "after"],
    },
  );
  assertEquals(intertwined?.text.includes("строго больше 10 мм"), true);
  assertEquals(intertwined?.text.includes("строго меньше 10 мм"), true);
});

Deno.test("a missing customer material remains a safety caveat, not a catalog shortage", () => {
  const facets = [{
    key: "before",
    caption: "Внутренний диаметр до изменения, мм",
    unit: "мм",
    values: [{ value: "10" }, { value: "12" }],
  }, {
    key: "after",
    caption: "Внутренний диаметр после изменения, мм",
    unit: "мм",
    values: [{ value: "10" }, { value: "8" }],
  }];
  const declaration = resolveDerivedSelectionReasoning(
    {
      reasoning:
        "Внутренний диаметр до изменения строго больше 10 мм, после изменения строго меньше 10 мм. Данных о материале изоляции кабеля недостаточно для точного выбора безопасной температуры изменения.",
      required_facet_values: [],
    },
    facets,
    "кабель диаметром 10 мм",
    "Изделие",
    {
      value: 10,
      unit: "мм",
      facetKeys: ["before", "after"],
    },
  );
  assertEquals(declaration?.text.includes("строго больше 10 мм"), true);
  assertEquals(declaration?.text.includes("строго меньше 10 мм"), true);
  assertEquals(declaration?.text.includes("Данных о материале изоляции"), true);
});

Deno.test("paired exact-equality cleanup normalizes decimal spellings", () => {
  const facets = [{
    key: "before",
    caption: "Диаметр до изменения, мм",
    unit: "мм",
    values: [{ value: "10,5" }, { value: "12" }],
  }, {
    key: "after",
    caption: "Диаметр после изменения, мм",
    unit: "мм",
    values: [{ value: "10,5" }, { value: "8" }],
  }];
  for (const assertion of ["равен 10,50 мм", "= 10,50 мм"]) {
    const declaration = resolveDerivedSelectionReasoning(
      {
        reasoning:
          `Для объекта 10,5 мм диаметр до изменения строго больше 10,5 мм, после изменения строго меньше 10,5 мм. Диаметр до изменения ${assertion}.`,
        required_facet_values: [],
      },
      facets,
      "объект диаметром 10,5 мм",
      "Изделие",
      {
        value: 10.5,
        unit: "мм",
        facetKeys: ["before", "after"],
      },
    );
    assertEquals(declaration?.text.includes("строго больше 10,5 мм"), true);
    assertEquals(declaration?.text.includes("строго меньше 10,5 мм"), true);
    assertEquals(declaration?.text.includes(assertion), false);
  }
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

Deno.test("unitless related catalog ranges never become verified paired-fit claims", () => {
  const facets = [{
    key: "diameter_before",
    caption: "Внутренний диаметр до усадки, мм",
    unit: "мм",
    values: [{ value: "14" }],
  }, {
    key: "diameter_after",
    caption: "Внутренний диаметр после усадки, мм",
    unit: "мм",
    values: [{ value: "7" }],
  }, {
    key: "wire_diameter_range",
    caption: "Диапазон диаметров проводов",
    unit: null,
    values: [{ value: "12.8-24" }, { value: "6.8-12" }],
  }];
  const paired = {
    value: 12,
    unit: "мм",
    facetKeys: ["diameter_before", "diameter_after"],
  };
  const strict =
    "Для кабеля 12 мм внутренний диаметр трубки до усадки строго больше 12 мм, а после усадки строго меньше 12 мм.";
  const result = resolveDerivedSelectionReasoning(
    {
      reasoning:
        `${strict} Диапазон диаметров проводов 12. 8–24 мм указывает на совместимость.`,
      required_facet_values: ["f2v0"],
      compatible_classifications: ["f2v0"],
      excluded_classifications: [],
    },
    facets,
    "Нужна термоусадочная трубка для кабеля диаметром 12 мм",
    "Трубки термоусаживаемые",
    paired,
  );
  assertEquals(result?.requiredFacetValues, []);
  assertEquals(result?.customerGroundedCompatible, []);
  assertEquals(result?.text.includes("24 мм"), false);
  assertEquals(result?.text.includes("12.8-24"), false);
  assertEquals(result?.text.includes("Обязательные параметры"), false);
  assertEquals(result?.text.includes("строго больше 12 мм"), true);
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
    messages[0].content.includes(
      "число или коэффициент, который ты выбрал сам и которого клиент не задавал",
    ),
    true,
  );
  assertEquals(
    messages[0].content.includes(
      "не называй её результат обязательным минимумом товара",
    ),
    true,
  );
  assertEquals(
    messages[0].content.includes(
      "назови именно его и оставь расчёт условным",
    ),
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

Deno.test("a customer light qualifier cannot become a mandatory housing colour", () => {
  const facets = [{
    key: "body_colour",
    caption: "Цвет корпуса",
    values: [{ value: "белый" }, { value: "черный" }],
  }, {
    key: "emitted_colour",
    caption: "Цвет свечения",
    values: [{ value: "холодный белый" }, { value: "зеленый" }],
  }, {
    key: "protection",
    caption: "Степень защиты",
    values: [{ value: "IP54" }, { value: "IP65" }],
  }];
  const customer = "Нужен прожектор IP65, белый свет 4000 K";
  const schema = buildDerivedSelectionReasoningToolSchema(facets, customer);
  const properties = (schema.function.parameters.properties ?? {}) as Record<
    string,
    { items?: { enum?: string[] } }
  >;
  assertEquals(
    properties.required_facet_values.items?.enum?.includes("f2v1"),
    true,
  );

  for (
    const reasoning of [
      "Для улицы нужен белый свет 4000 K и степень защиты IP65.",
      "Цвет корпуса должен быть белый, степень защиты IP65.",
    ]
  ) {
    const resolved = resolveDerivedSelectionReasoning(
      {
        reasoning,
        required_facet_values: ["f0v0", "f2v1"],
        compatible_classifications: [],
        excluded_classifications: [],
      },
      facets,
      customer,
      "Прожекторы",
    );
    assertEquals(
      resolved?.requiredFacetValues.some(({ key }) => key === "Цвет корпуса"),
      false,
    );
  }

  const explicitBody = resolveDerivedSelectionReasoning(
    {
      reasoning: "Цвет корпуса должен быть белый, степень защиты IP65.",
      required_facet_values: ["f0v0", "f2v1"],
      compatible_classifications: [],
      excluded_classifications: [],
    },
    facets,
    "Нужен прожектор IP65, белый корпус",
    "Прожекторы",
  );
  assertEquals(
    explicitBody?.requiredFacetValues.some(({ key, value }) =>
      key === "Цвет корпуса" && value === "белый"
    ),
    true,
  );

  const emitted = resolveDerivedSelectionReasoning(
    {
      reasoning:
        "Цвет свечения должен быть холодный белый, степень защиты IP65.",
      required_facet_values: ["f1v0", "f2v1"],
      compatible_classifications: [],
      excluded_classifications: [],
    },
    facets,
    customer,
    "Прожекторы",
  );
  assertEquals(
    emitted?.requiredFacetValues.some(({ key, value }) =>
      key === "Цвет свечения" && value === "холодный белый"
    ),
    true,
  );
});

Deno.test("customer range endpoints cannot own an exact live temperature", () => {
  const facets = [{
    key: "colour_temperature",
    caption: "Цветовая температура, K",
    unit: "K",
    values: [{ value: "4000" }, { value: "6500" }],
  }];
  const options = (customer: string) => {
    const schema = buildDerivedSelectionReasoningToolSchema(facets, customer);
    const properties = (schema.function.parameters.properties ?? {}) as Record<
      string,
      { items?: { enum?: string[] } }
    >;
    return properties.required_facet_values.items?.enum ?? [];
  };
  assertEquals(options("Нужен белый свет 4000–6500 K"), []);
  assertEquals(options("Нужен белый свет от 4000 до 6500 К"), []);
  assertEquals(options("Нужна цветовая температура ровно 6500 K"), ["f0v1"]);
});

Deno.test("an aggregate estimate with illustrative per-item tiers stays a system total", () => {
  const mixed =
    "Нужен суммарный поток не менее 6000 лм (например, 2–3 изделия по 2000–3000 лм каждое).";
  assertEquals(systemTotalReasoningDeclaresPerProductMeasurement(mixed), false);
  assertEquals(
    shouldProjectDerivedScalarMeasurement("Двор 120 м²", mixed, "system_total"),
    false,
  );
  assertEquals(
    systemTotalReasoningDeclaresPerProductMeasurement(
      `${mixed} Мощность каждого отдельного изделия должна быть 20–50 Вт.`,
    ),
    true,
  );
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

Deno.test("system total and model-only per-card targets do not become exact product obligations", () => {
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
    false,
  );
  assertEquals(perProduct?.measurementEvidence.includes("7000 лм"), false);
  assertEquals(perProduct?.text.includes("IP65"), true);
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

Deno.test("an exact model ID copied from a room size is not a customer-owned product capacity", () => {
  const facets = [{
    key: "max_area",
    caption: "Максимальная площадь освещения, м2",
    type: "checkbox",
    unit: null,
    values: [{ value: "25" }, { value: "30" }, { value: "35" }],
  }];
  const reasoning =
    "Максимальная площадь освещения у люстры — значение 30 м², прямое соответствие комнате.";
  const declared = {
    reasoning,
    measurement_scope: "per_product",
    compatible_classifications: [],
    excluded_classifications: [],
    required_facet_values: ["f0v1"],
    explicit_customer_classifications: [],
  };
  const resolved = resolveDerivedSelectionReasoning(
    declared,
    facets,
    "хочу поменять дома люстру в зале 30 квадратов. Что предложишь из современного?",
  );
  assertEquals(resolved?.requiredFacetValues, []);
  assertEquals(resolved?.text.includes("Обязательные параметры"), false);

  const exact = resolveDerivedSelectionReasoning(
    declared,
    facets,
    "Нужна максимальная площадь освещения товара ровно 30 м²",
  );
  assertEquals(exact?.requiredFacetValues, [{
    key: "Максимальная площадь освещения, м2",
    value: "30",
  }]);
  const explicitlyDirectional = resolveDerivedSelectionReasoning(
    declared,
    facets,
    "Нужна люстра для гостиной площадью не менее 30 м²",
  );
  assertEquals(explicitlyDirectional?.requiredFacetValues, []);
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

Deno.test("one-to-one replacement cannot promote a model-only lighting norm to a hard card target", () => {
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
  // With no customer-authored 160 лк or 4000 лм, the only declaration is an
  // unsupported hard scalar. Retry instead of displaying it as a requirement.
  assertEquals(single, null);
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

Deno.test("open alternatives preserve a spatial calculation as a system total without prescribing item count", () => {
  const reasoning =
    "Для всей зоны 120 м² × 150 лк = 18000 лм суммарного потока; поток можно распределить между приборами.";
  const request =
    "Нужен прибор для зоны 120 м². Предложи варианты для установки на участке.";
  assertEquals(
    reasoningComputesSystemTotalFromSpatialExtent(request, reasoning),
    true,
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
    request,
  );
  assertEquals(resolved?.measurementScope, "system_total");
  assertEquals(
    resolved?.text.includes("суммарная потребность всей системы"),
    true,
  );
  assertEquals(
    reasoningComputesSystemTotalFromSpatialExtent(
      "Для зоны 120 м² покажи несколько подходящих вариантов",
      reasoning,
    ),
    true,
  );
});

Deno.test("a bare model-only aggregate is removed from visible reasoning without losing qualitative protection", () => {
  const customer =
    "Нужен прибор для двора площадью 120 м² с высоты 4 м. Предложи варианты.";
  const raw =
    "Для двора 120 м² с высоты 4 м нужен суммарный поток не менее 24 000 лм. Для открытой среды степень защиты IP65 обязательна.";
  const facets = [{
    key: "flux",
    caption: "Световой поток, лм",
    unit: "лм",
    values: [{ value: "1800" }, { value: "24000" }],
  }, {
    key: "protection",
    caption: "Степень защиты IP",
    values: [{ value: "IP65" }, { value: "IP44" }],
  }];
  const safe = demoteUnsupportedSystemTotalClaims(raw, customer, facets);
  assertEquals(safe.includes("24 000 лм"), false);
  assertEquals(safe.includes("IP65"), true);
  const resolved = resolveDerivedSelectionReasoning(
    {
      reasoning: raw,
      measurement_scope: "system_total",
      compatible_classifications: [],
      excluded_classifications: [],
      required_facet_values: ["f1v0"],
      explicit_customer_classifications: [],
    },
    facets,
    customer,
  );
  assertEquals(resolved?.text.includes("24 000 лм"), false);
  assertEquals(resolved?.measurementEvidence.includes("24 000 лм"), false);
  assertEquals(resolved?.text.includes("IP65"), true);
  assertEquals(resolved?.requiredFacetValues, [{
    key: "Степень защиты IP",
    value: "IP65",
  }]);
  const sameSentence = demoteUnsupportedSystemTotalClaims(
    "Для двора нужен суммарный поток не менее 24 000 лм и степень защиты IP65.",
    customer,
    facets,
  );
  assertEquals(sameSentence.includes("24 000 лм"), false);
  assertEquals(sameSentence.includes("Степень защиты IP65"), true);
  const commaClause = demoteUnsupportedSystemTotalClaims(
    "Для двора нужен суммарный поток не менее 24 000 лм, при этом обязательна защита IP65.",
    customer,
    facets,
  );
  assertEquals(commaClause.includes("24 000 лм"), false);
  assertEquals(commaClause.includes("защита IP65"), true);
  const modelCount = demoteUnsupportedSystemTotalClaims(
    "Нужно не менее 3 светильников и степень защиты IP65.",
    customer,
    facets,
  );
  assertEquals(modelCount.includes("3 светильников"), true);
  assertEquals(modelCount.includes("числовой ориентир пока не подтверждён"), false);
  const comparative = demoteUnsupportedSystemTotalClaims(
    "Для всей системы нужно не менее чем 24 000 лм.",
    customer,
    facets,
  );
  assertEquals(comparative.includes("24 000 лм"), false);
});

Deno.test("aggregate provenance guard keeps exact customer totals and valid visible arithmetic", () => {
  const throughput = [{
    key: "throughput",
    caption: "Выходная производительность, кг",
    unit: "кг",
    values: [{ value: "1800" }, { value: "24000" }],
  }];
  const flux = [{
    key: "flux",
    caption: "Световой поток, лм",
    unit: "лм",
    values: [{ value: "1800" }, { value: "24000" }],
  }];
  const customerOwned = demoteUnsupportedSystemTotalClaims(
    "Выходная производительность всей системы должна быть не менее 24 000 кг.",
    "Нужна суммарная выходная производительность не менее 24 000 кг.",
    throughput,
  );
  assertEquals(customerOwned.includes("24 000 кг"), true);
  const derived = demoteUnsupportedSystemTotalClaims(
    "Световой поток нужен не менее 1800 лм: 120 м² × 15 лк = 1800 лм.",
    "Участок 120 м². Нужна освещённость не менее 15 лк. Предложи варианты.",
    flux,
  );
  assertEquals(derived.includes("1800 лм"), true);
  const invalid = demoteUnsupportedSystemTotalClaims(
    "Световой поток нужен не менее 24 000 лм: 120 м² × 15 лк = 24 000 лм.",
    "Участок 120 м². Нужна освещённость не менее 15 лк. Предложи варианты.",
    flux,
  );
  assertEquals(invalid.includes("24 000 лм"), false);
});

Deno.test("ASCII square metres cannot ground a model-only linear total", () => {
  const customer = "Нужна суммарная площадь не менее 120 м2.";
  const reasoning = "Для всей системы нужна суммарная длина не менее 120 м.";
  const facets = [{
    key: "length",
    caption: "Длина, м",
    unit: "м",
    values: [{ value: "120" }],
  }];
  const safe = demoteUnsupportedSystemTotalClaims(reasoning, customer, facets);
  assertEquals(safe.includes("120 м."), false);
  assertEquals(safe.includes("числовой ориентир пока не подтверждён"), true);
  const resolved = resolveDerivedSelectionReasoning({
    reasoning,
    measurement_scope: "per_product",
    compatible_classifications: [],
    excluded_classifications: [],
    required_facet_values: [],
    explicit_customer_classifications: [],
  }, facets, customer);
  assertEquals(resolved?.measurementScope, "system_total");
  assertEquals(resolved?.text.includes("120 м."), false);
});

Deno.test("square-metre abbreviation cannot ground a model-only voltage total", () => {
  const customer = "Нужна суммарная площадь не менее 120 кв. м.";
  const reasoning = "Для всей системы нужно суммарное напряжение не менее 120 кВ.";
  const facets = [{
    key: "voltage",
    caption: "Напряжение, кВ",
    unit: "кВ",
    values: [{ value: "120" }],
  }];
  const safe = demoteUnsupportedSystemTotalClaims(reasoning, customer, facets);
  assertEquals(safe.includes("120 кВ"), false);
  assertEquals(safe.includes("числовой ориентир пока не подтверждён"), true);
});

Deno.test("square-metre spellings keep a genuinely customer-owned aggregate", () => {
  const facets = [{
    key: "area",
    caption: "Площадь, м²",
    unit: "м²",
    values: [{ value: "120" }],
  }];
  for (const spelling of ["120 м2", "120 кв. м", "120 м²"]) {
    const customer = `Нужна суммарная площадь не менее ${spelling}.`;
    const reasoning = `Для всей системы нужна суммарная площадь не менее ${spelling}.`;
    const safe = demoteUnsupportedSystemTotalClaims(reasoning, customer, facets);
    assertEquals(safe.includes(spelling), true);
    assertEquals(safe.includes("числовой ориентир пока не подтверждён"), false);
    const resolved = resolveDerivedSelectionReasoning({
      reasoning,
      measurement_scope: "per_product",
      compatible_classifications: [],
      excluded_classifications: [],
      required_facet_values: [],
      explicit_customer_classifications: [],
    }, facets, customer);
    assertEquals(resolved?.measurementScope, "system_total");
  }
});

Deno.test("ASCII exponent in a live facet caption still protects an unsupported total", () => {
  const safe = demoteUnsupportedSystemTotalClaims(
    "Для всей системы нужна суммарная площадь не менее 120 м2.",
    "Предложи несколько вариантов для объекта.",
    [{
      key: "area",
      caption: "Площадь, м2",
      values: [{ value: "120" }],
    }],
  );
  assertEquals(safe.includes("120 м2"), false);
  assertEquals(safe.includes("числовой ориентир пока не подтверждён"), true);
});

Deno.test("unsupported model-only card threshold is absent from visible reasoning while IP remains", () => {
  const facets = [{
    key: "flux",
    caption: "Световой поток, лм",
    type: "number",
    unit: "лм",
    values: [{ value: "1800" }, { value: "5000" }],
  }, {
    key: "protection",
    caption: "Степень защиты IP",
    values: [{ value: "IP44" }, { value: "IP65" }],
  }];
  const customer = "Нужен светильник для гостиной 25 м².";
  const resolved = resolveDerivedSelectionReasoning({
    reasoning:
      "Для гостиной 25 м² нужен световой поток не менее 4000 лм из расчёта 160 лк и степень защиты IP44 обязательна.",
    measurement_scope: "per_product",
    compatible_classifications: [],
    excluded_classifications: [],
    required_facet_values: ["f1v0"],
    explicit_customer_classifications: [],
  }, facets, customer);
  assertEquals(resolved?.text.includes("4000 лм"), false);
  assertEquals(resolved?.measurementEvidence.includes("4000 лм"), false);
  assertEquals(resolved?.text.includes("IP44"), true);
  const ipFirst = resolveDerivedSelectionReasoning({
    reasoning:
      "Для гостиной нужен IP44 и световой поток не менее 4000 лм.",
    measurement_scope: "per_product",
    compatible_classifications: [],
    excluded_classifications: [],
    required_facet_values: ["f1v0"],
    explicit_customer_classifications: [],
  }, facets, customer);
  assertEquals(ipFirst?.text.includes("4000 лм"), false);
  assertEquals(ipFirst?.text.includes("IP44"), true);
  const inseparable = resolveDerivedSelectionReasoning({
    reasoning:
      "Нужен световой поток не менее 4000 лм с защитой IP44.",
    measurement_scope: "per_product",
    compatible_classifications: [],
    excluded_classifications: [],
    required_facet_values: ["f1v0"],
    explicit_customer_classifications: [],
  }, facets, customer);
  assertEquals(inseparable, null);
});

Deno.test("a customer-owned destination survives a separable model-only numeric premise", () => {
  const facets = [{
    key: "destination",
    caption: "Назначение",
    values: [{ value: "Для гостиной" }, { value: "Для офиса" }],
  }, {
    key: "area",
    caption: "Максимальная площадь освещения, м²",
    type: "number",
    unit: "м²",
    values: [{ value: "30" }, { value: "12" }],
  }, {
    key: "flux",
    caption: "Световой поток, лм",
    type: "number",
    unit: "лм",
    values: [{ value: "1800" }, { value: "6000" }],
  }];
  const customer = "Нужен светильник для гостиной площадью 30 м². Покажите варианты.";
  const args = {
    reasoning:
      "Для гостиной площадью 30 м² при норме 150–200 лк требуется поток 4500–6000 лм.",
    measurement_scope: "per_product",
    compatible_classifications: ["f0v0"],
    excluded_classifications: [],
    required_facet_values: ["f0v0", "f1v0"],
    explicit_customer_classifications: [],
  };
  const safe = resolveDerivedSelectionReasoning(args, facets, customer);
  assertEquals(safe !== null, true);
  assertEquals(safe?.text.includes("гостиной площадью 30 м²"), true);
  assertEquals(safe?.text.includes("150–200 лк"), false);
  assertEquals(safe?.text.includes("4500–6000 лм"), false);
  assertEquals(safe?.measurementEvidence.includes("30 м²"), true);

  const customerLumens = resolveDerivedSelectionReasoning({
    ...args,
    reasoning:
      "Для гостиной площадью 30 м² при норме 150–200 лк требуется поток 4500–6000 лм и не менее 5000 лм по запросу клиента.",
  }, facets, `${customer} Поток не менее 5000 лм.`);
  assertEquals(customerLumens, null);

  const customerProtection = resolveDerivedSelectionReasoning({
    ...args,
    reasoning:
      "Для гостиной площадью 30 м² при норме 150–200 лк требуется поток 4500–6000 лм и защита IP65 обязательна.",
  }, [...facets, {
    key: "protection",
    caption: "Степень защиты IP",
    values: [{ value: "IP65" }],
  }], `${customer} Нужна защита IP65.`);
  assertEquals(customerProtection?.text.includes("IP65"), true);
  assertEquals(customerProtection?.text.includes("4500–6000 лм"), false);

  const inseparableProtection = resolveDerivedSelectionReasoning({
    ...args,
    reasoning:
      "Для гостиной площадью 30 м² при норме 150–200 лк требуется поток 4500–6000 лм с защитой IP65.",
  }, [...facets, {
    key: "protection",
    caption: "Степень защиты IP",
    values: [{ value: "IP65" }],
  }], `${customer} Нужна защита IP65.`);
  assertEquals(inseparableProtection, null);

  const inventedArea = resolveDerivedSelectionReasoning(args, facets, "Нужен светильник для гостиной. Покажите варианты.");
  assertEquals(inventedArea === null || !inventedArea.text.includes("30 м²"), true);

  const perItemPremise = resolveDerivedSelectionReasoning({
    ...args,
    reasoning:
      "Для гостиной площадью 30 м² при условии, что каждый светильник имеет не менее 5500 лм, требуется подбор. Живая схема содержит характеристику „Максимальная площадь освещения, м2“ со значением 30, что соответствует помещению. Проверяю другие варианты по этим двум проверяемым характеристикам.",
    compatible_classifications: [],
    required_facet_values: [],
  }, facets, customer);
  assertEquals(perItemPremise, null);
  const symbolicPerItemPremise = resolveDerivedSelectionReasoning({
    ...args,
    reasoning:
      "Для гостиной площадью 30 м² при условии, что каждый светильник имеет ≥5500 лм, требуется подбор. Живая схема содержит характеристику „Максимальная площадь освещения, м2“ со значением 30, что соответствует помещению. Проверяю другие варианты по этим двум проверяемым характеристикам.",
    compatible_classifications: [],
    required_facet_values: [],
  }, facets, customer);
  assertEquals(symbolicPerItemPremise, null);
  const prefixedPerItemPremise = resolveDerivedSelectionReasoning({
    ...args,
    reasoning:
      "Каждый светильник для гостиной площадью 30 м² при норме 150 лк должен выдавать не менее 5000 лм. Живая схема содержит характеристику „Максимальная площадь освещения, м2“ со значением 30, что соответствует помещению.",
    required_facet_values: [],
  }, facets, customer);
  assertEquals(prefixedPerItemPremise, null);

  const customerPrice = resolveDerivedSelectionReasoning({
    ...args,
    reasoning:
      "Для гостиной площадью 30 м² при норме 150–200 лк требуется поток 4500–6000 лм, цена не более 4000 тенге.",
  }, facets, `${customer} Цена не более 4000 тенге.`);
  assertEquals(customerPrice, null);
});

Deno.test("system-total scope cannot expose a model-only minimum for each card", () => {
  const resolved = resolveDerivedSelectionReasoning({
    reasoning:
      "Для комнаты 25 м² каждый светильник должен иметь световой поток не менее 4000 лм. Степень защиты IP44 обязательна.",
    measurement_scope: "system_total",
    compatible_classifications: [],
    excluded_classifications: [],
    required_facet_values: ["f1v0"],
    explicit_customer_classifications: [],
  }, [{
    key: "flux",
    caption: "Световой поток, лм",
    type: "number",
    unit: "лм",
    values: [{ value: "1800" }, { value: "5000" }],
  }, {
    key: "protection",
    caption: "Степень защиты IP",
    values: [{ value: "IP44" }],
  }], "Нужен светильник для комнаты 25 м².");
  assertEquals(resolved?.text.includes("4000 лм"), false);
  assertEquals(resolved?.measurementEvidence.includes("4000 лм"), false);
  assertEquals(resolved?.text.includes("IP44"), true);
});

Deno.test("exact model-only physical number without an exact live value is not a visible must", () => {
  const resolved = resolveDerivedSelectionReasoning({
    reasoning:
      "Для гостиной световой поток должен быть 4000 лм. Учитываю накладной монтаж и подходящий класс применения.",
    measurement_scope: "per_product",
    compatible_classifications: [],
    excluded_classifications: [],
    required_facet_values: [],
    explicit_customer_classifications: [],
  }, [{
    key: "flux",
    caption: "Световой поток, лм",
    type: "number",
    unit: "лм",
    values: [{ value: "1800" }, { value: "5000" }],
  }], "Нужен светильник для гостиной 25 м².");
  assertEquals(resolved?.text.includes("должен быть 4000 лм"), false);
});

Deno.test("a customer-owned card threshold remains visible after numeric authority checking", () => {
  const resolved = resolveDerivedSelectionReasoning({
    reasoning:
      "Для гостиной 25 м² нужен световой поток не менее 4000 лм. Учитываю накладной монтаж.",
    measurement_scope: "per_product",
    compatible_classifications: [],
    excluded_classifications: [],
    required_facet_values: [],
    explicit_customer_classifications: [],
  }, [{
    key: "flux",
    caption: "Световой поток, лм",
    type: "number",
    unit: "лм",
    values: [{ value: "1800" }, { value: "5000" }],
  }], "Нужен светильник для гостиной 25 м² с потоком не менее 4000 лм.");
  assertEquals(resolved?.text.includes("не менее 4000 лм"), true);
  assertEquals(resolved?.measurementEvidence.includes("не менее 4000 лм"), true);
});

Deno.test("a model cannot bypass aggregate provenance by mislabelling a visible system total as per-product", () => {
  const facets = [{
    key: "throughput",
    caption: "Выходная производительность, кг",
    unit: "кг",
    values: [{ value: "1800" }, { value: "24000" }],
  }];
  const declaration = {
    reasoning:
      "Для всей системы нужна суммарная выходная производительность не менее 24 000 кг. Отдельные товары следует сравнить по характеристикам.",
    measurement_scope: "per_product",
    compatible_classifications: [],
    excluded_classifications: [],
    required_facet_values: [],
    explicit_customer_classifications: [],
  };
  const open = resolveDerivedSelectionReasoning(
    declaration,
    facets,
    "Нужны варианты для объекта 120 м².",
  );
  assertEquals(open?.measurementScope, "system_total");
  assertEquals(open?.text.includes("24 000 кг"), false);
  const single = resolveDerivedSelectionReasoning(
    declaration,
    facets,
    "Нужно одно изделие для объекта 120 м².",
  );
  assertEquals(single?.measurementScope, "per_product");
});

Deno.test("a computed total removes only a separable model-owned per-item scalar from all reasoning channels", () => {
  const resolved = resolveDerivedSelectionReasoning(
    {
      reasoning:
        "Для зоны 120 м² × 150 лк = 18000 лм суммарно. Каждому изделию требуется поток не менее 2000 лм. Для открытой среды степень защиты IP65 обязательна.",
      measurement_scope: "per_product",
      retrieval_query: "поток не менее 2000 лм",
      compatible_classifications: [],
      excluded_classifications: [],
      required_facet_values: ["f0v0", "f1v0"],
      explicit_customer_classifications: [],
    },
    [
      {
        key: "flux",
        caption: "Световой поток",
        unit: "лм",
        values: [{ value: "2000" }],
      },
      {
        key: "protection",
        caption: "Степень защиты IP",
        values: [{ value: "IP65" }],
      },
    ],
    "Для зоны 120 м² предложи варианты изделий.",
  );
  assertEquals(resolved?.measurementScope, "system_total");
  assertEquals(resolved?.text.includes("120 м² × 150 лк = 18000 лм"), true);
  assertEquals(resolved?.text.includes("IP65"), true);
  assertEquals(resolved?.text.includes("2000 лм"), false);
  assertEquals(resolved?.measurementEvidence.includes("2000 лм"), false);
  assertEquals(resolved?.retrievalQuery, null);
  assertEquals(
    resolved?.requiredFacetValues.some(({ key }) => key === "Световой поток"),
    false,
  );
});

Deno.test("computed area demand does not keep a model's later product-side recommendation", () => {
  const reasoning =
    "Для освещения двора частного дома площадью 120 м² рекомендуется обеспечить освещённость 10–20 лк (базовый уровень для придомовой территории). Световой поток = 120 м² × 15 лк (средний ориентир) = 1800 лм. Учитывая высоту установки 4 м и потери света, оптимально выбрать прожектор со световым потоком не менее 2000–2500 лм. Для уличного применения обязательна степень защиты не ниже IP65 (защита от пыли и струй воды). Напряжение питания 220 В (стандартная сеть). Можно использовать один мощный прожектор (30–50 Вт) или несколько менее мощных для равномерного освещения.";
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
    "Нужен прожектор на улицу. Предложи варианты для освещения двора площадью 120 м².",
  );
  assertEquals(resolved?.measurementScope, "system_total");
  assertEquals(resolved?.text.includes("1800 лм"), true);
  assertEquals(resolved?.text.includes("10–20 лк"), true);
  assertEquals(resolved?.text.includes("IP65"), true);
  assertEquals(resolved?.text.includes("2000–2500 лм"), false);
  assertEquals(resolved?.measurementEvidence.includes("2000–2500 лм"), false);
  const alreadySystemTotal = resolveDerivedSelectionReasoning(
    {
      reasoning,
      measurement_scope: "system_total",
      compatible_classifications: [],
      excluded_classifications: [],
      required_facet_values: [],
      explicit_customer_classifications: [],
    },
    [],
    "Нужен прожектор на улицу. Предложи варианты для освещения двора площадью 120 м².",
  );
  assertEquals(alreadySystemTotal?.measurementScope, "system_total");
  assertEquals(alreadySystemTotal?.text.includes("2000–2500 лм"), false);
  assertEquals(alreadySystemTotal?.text.includes("IP65"), true);
});

Deno.test("a computed total fails closed when the per-item scalar cannot be separated from the equation", () => {
  const resolved = resolveDerivedSelectionReasoning(
    {
      reasoning:
        "Для зоны 120 м² × 150 лк = 18000 лм суммарно, и каждому изделию требуется поток не менее 2000 лм.",
      measurement_scope: "per_product",
      compatible_classifications: [],
      excluded_classifications: [],
      required_facet_values: [],
      explicit_customer_classifications: [],
    },
    [],
    "Для зоны 120 м² предложи варианты изделий.",
  );
  assertEquals(resolved, null);
});

Deno.test("a computed total keeps an independent calculation and protection clause across a coordinator", () => {
  const resolved = resolveDerivedSelectionReasoning(
    {
      reasoning:
        "Для зоны 120 м² × 150 лк = 18000 лм суммарно, а каждому изделию нужен поток не менее 2000 лм; защита IP65 обязательна.",
      measurement_scope: "per_product",
      compatible_classifications: [],
      excluded_classifications: [],
      required_facet_values: [],
      explicit_customer_classifications: [],
    },
    [],
    "Для зоны 120 м² предложи варианты изделий.",
  );
  assertEquals(resolved?.measurementScope, "system_total");
  assertEquals(resolved?.text.includes("120 м² × 150 лк = 18000 лм"), true);
  assertEquals(resolved?.text.includes("2000 лм"), false);
  assertEquals(resolved?.text.includes("IP65"), true);
  assertEquals(resolved?.measurementEvidence.includes("IP65"), true);
});

Deno.test("model-only per-item targets are removed, but customer-owned targets stay visible", () => {
  const reasoning =
    "Для зоны 120 м² × 150 лк = 18000 лм. Каждому изделию требуется поток не менее 2000 лм.";
  const declaration = {
    reasoning,
    measurement_scope: "per_product",
    compatible_classifications: [],
    excluded_classifications: [],
    required_facet_values: [],
    explicit_customer_classifications: [],
  };
  const oneToOne = resolveDerivedSelectionReasoning(
    declaration,
    [],
    "Хочу заменить старое изделие на одно новое для зоны 120 м². Покажи варианты.",
  );
  assertEquals(oneToOne?.measurementScope, "per_product");
  assertEquals(oneToOne?.measurementEvidence.includes("2000 лм"), false);

  const customerOwned = resolveDerivedSelectionReasoning(
    declaration,
    [],
    "Для зоны 120 м² покажи варианты. Каждое изделие должно иметь поток не менее 2000 лм.",
  );
  assertEquals(customerOwned?.measurementEvidence.includes("2000 лм"), true);
});

Deno.test("explicit single target and one-to-one replacement outrank open alternatives", () => {
  const reasoning = "120 м² × 150 лк = 18000 лм для участка.";
  assertEquals(
    reasoningComputesSystemTotalFromSpatialExtent(
      "Нужен один прибор для участка 120 м². Предложи варианты.",
      reasoning,
    ),
    false,
  );
  assertEquals(
    reasoningComputesSystemTotalFromSpatialExtent(
      "Хочу заменить старое изделие на новое для участка 120 м². Покажи несколько вариантов.",
      reasoning,
    ),
    false,
  );
  assertEquals(
    reasoningComputesSystemTotalFromSpatialExtent(
      "Хочу заменить одно изделие на три изделия для участка 120 м².",
      reasoning,
    ),
    true,
  );
  assertEquals(
    reasoningComputesSystemTotalFromSpatialExtent(
      "Для участка 120 м² покажи варианты: можно поставить один мощный прибор или несколько слабых.",
      reasoning,
    ),
    true,
  );
});

Deno.test("a customer-owned per-item target cannot be recast as a system total", () => {
  const reasoning = "120 м² × 150 лк = 18000 лм для участка.";
  assertEquals(
    reasoningComputesSystemTotalFromSpatialExtent(
      "Для участка 120 м² предложи варианты. Каждый прибор должен иметь поток 18000 лм.",
      reasoning,
    ),
    false,
  );
  assertEquals(
    reasoningComputesSystemTotalFromSpatialExtent(
      "Для участка 120 м² предложи варианты. Каждый прибор не менее 2000 лм.",
      reasoning,
    ),
    true,
  );
});

Deno.test("exposed use requires a structured live protection obligation before selection", () => {
  const protectionFacets = [{
    key: "protection",
    caption: "Степень защиты IP",
    values: [{ value: "IP44" }, { value: "IP65" }],
  }];
  const baseline = resolveDerivedSelectionReasoning(
    {
      reasoning:
        "Для эксплуатации вне помещения необходимо подтвердить защиту от воздействия среды.",
      measurement_scope: "not_applicable",
      compatible_classifications: [],
      excluded_classifications: [],
      required_facet_values: [],
      explicit_customer_classifications: [],
    },
    [],
    "Нужен прибор для двора",
  );
  assertEquals(Boolean(baseline), true);
  assertEquals(
    hasUnresolvedEnvironmentalProtectionObligation(
      "Нужен прибор для двора",
      protectionFacets,
      baseline,
    ),
    true,
  );
  assertEquals(
    hasUnresolvedEnvironmentalProtectionObligation(
      "Нужен прибор для двора",
      protectionFacets,
      {
        ...baseline!,
        compatible: [{ key: "Класс применения", value: "наружный" }],
      },
    ),
    true,
  );
  assertEquals(
    hasUnresolvedEnvironmentalProtectionObligation(
      "Нужен прибор для двора",
      protectionFacets,
      {
        ...baseline!,
        requiredFacetValues: [{ key: "Степень защиты IP", value: "IP65" }],
      },
    ),
    false,
  );
  assertEquals(
    hasUnresolvedEnvironmentalProtectionObligation(
      "Нужен прибор для двора",
      protectionFacets,
      {
        ...baseline!,
        compatible: [{ key: "Степень защиты IP", value: "IP65" }],
      },
    ),
    true,
  );
  assertEquals(
    hasUnresolvedEnvironmentalProtectionObligation(
      "Нужен прибор для двора",
      protectionFacets,
      {
        ...baseline!,
        customerGroundedCompatible: [{
          key: "Степень защиты IP",
          value: "IP65",
        }],
      },
    ),
    false,
  );
});

Deno.test("environmental protection correction uses the required technical-facet contract", () => {
  const customer = "Нужен прибор для открытого двора";
  const facets = [{
    key: "protection",
    caption: "Степень защиты IP",
    values: [{ value: "IP20" }, { value: "IP65" }],
  }];
  const schema = buildDerivedSelectionReasoningToolSchema(facets, customer);
  const properties = schema.function.parameters.properties as Record<
    string,
    { items?: { enum?: string[] } }
  >;
  assertEquals(
    properties.required_facet_values.items?.enum?.includes("f0v1"),
    true,
  );
  assertEquals(
    properties.compatible_classifications.items?.enum?.includes("f0v1") ??
      false,
    false,
  );
  const draft = {
    reasoning:
      "Для эксплуатации во дворе каждому прибору нужна подтверждённая защита от воздействия погоды.",
    measurement_scope: "not_applicable",
    compatible_classifications: ["f0v1"],
    excluded_classifications: [],
    required_facet_values: [],
    explicit_customer_classifications: [],
  };
  const compatibleOnly = resolveDerivedSelectionReasoning(
    draft,
    facets,
    customer,
  );
  assertEquals(Boolean(compatibleOnly), true);
  assertEquals(
    hasUnresolvedEnvironmentalProtectionObligation(
      customer,
      facets,
      compatibleOnly,
    ),
    true,
  );
  const valueWithoutReasoning = resolveDerivedSelectionReasoning(
    { ...draft, required_facet_values: ["f0v1"] },
    facets,
    customer,
  );
  assertEquals(
    hasUnresolvedEnvironmentalProtectionObligation(
      customer,
      facets,
      valueWithoutReasoning,
    ),
    true,
  );
  const required = resolveDerivedSelectionReasoning(
    {
      ...draft,
      reasoning:
        "Для эксплуатации во дворе у каждого прибора необходима степень защиты IP65.",
      compatible_classifications: [],
      required_facet_values: ["f0v1"],
    },
    facets,
    customer,
  );
  assertEquals(required?.requiredFacetValues, [{
    key: "Степень защиты IP",
    value: "IP65",
  }]);
  assertEquals(
    hasUnresolvedEnvironmentalProtectionObligation(customer, facets, required),
    false,
  );
});

Deno.test("weather exposure rejects weak or unknown IP declarations without forcing IP65", () => {
  const facets = [{
    key: "ip",
    caption: "Степень защиты IP",
    values: [
      { value: "IP20" },
      { value: "IP23" },
      { value: "IP44" },
      { value: "IP65" },
      { value: "IP6X" },
    ],
  }];
  const baseline = resolveDerivedSelectionReasoning(
    {
      reasoning:
        "Для открытой площадки требуется подтверждённая защита корпуса.",
      measurement_scope: "not_applicable",
      compatible_classifications: [],
      excluded_classifications: [],
      required_facet_values: [],
      explicit_customer_classifications: [],
    },
    [],
    "Нужен прибор для открытой площадки",
  )!;
  for (const value of ["IP20", "IP23", "IP6X", "неизвестно"]) {
    assertEquals(
      hasUnresolvedEnvironmentalProtectionObligation(
        "Нужен прибор для открытой площадки",
        facets,
        {
          ...baseline,
          requiredFacetValues: [{ key: "Степень защиты IP", value }],
        },
      ),
      true,
    );
  }
  for (const value of ["IP44", "IP65"]) {
    assertEquals(
      hasUnresolvedEnvironmentalProtectionObligation(
        "Нужен прибор для открытой площадки",
        facets,
        {
          ...baseline,
          requiredFacetValues: [{ key: "Степень защиты IP", value }],
        },
      ),
      false,
    );
  }
  assertEquals(
    hasUnresolvedEnvironmentalProtectionObligation(
      "Нужен прибор для комнаты",
      facets,
      {
        ...baseline,
        requiredFacetValues: [{ key: "Степень защиты IP", value: "IP20" }],
      },
    ),
    false,
  );
});

Deno.test("dust exposure requires the solid-particle digit of the same live IP facet", () => {
  const facets = [{
    key: "ip",
    caption: "Степень защиты IP",
    values: [
      { value: "IP20" },
      { value: "IP44" },
      { value: "IP54" },
      { value: "IP65" },
      { value: "IP6X" },
    ],
  }];
  const declaration = (value: string) => ({
    requiredFacetValues: [{ key: "Степень защиты IP", value }],
  });
  for (const value of ["IP20", "IP44", "IPX5", "неизвестно"]) {
    assertEquals(
      hasUnresolvedEnvironmentalProtectionObligation(
        "Нужен прибор для пыльного цеха",
        facets,
        declaration(value),
      ),
      true,
    );
  }
  for (const value of ["IP54", "IP65", "IP6X"]) {
    assertEquals(
      hasUnresolvedEnvironmentalProtectionObligation(
        "Нужен прибор для пыльного цеха",
        facets,
        declaration(value),
      ),
      false,
    );
  }
  assertEquals(
    hasUnresolvedEnvironmentalProtectionObligation(
      "Нужен прибор для пыльной открытой площадки",
      facets,
      declaration("IP6X"),
    ),
    true,
  );
  assertEquals(
    hasUnresolvedEnvironmentalProtectionObligation(
      "Нужен прибор для пыльной открытой площадки",
      facets,
      declaration("IP65"),
    ),
    false,
  );
});

Deno.test("protection obligation does not invent a facet or block neutral use", () => {
  const facets = [{ caption: "Класс защиты", values: [{ value: "IP65" }] }];
  assertEquals(
    hasUnresolvedEnvironmentalProtectionObligation(
      "Нужен прибор для комнаты",
      facets,
      null,
    ),
    false,
  );
  for (
    const neutral of ["Нужен пылесос", "Нужен снегоуборщик", "Нужен дворник"]
  ) {
    assertEquals(
      hasUnresolvedEnvironmentalProtectionObligation(neutral, facets, null),
      false,
    );
  }
  assertEquals(
    hasUnresolvedEnvironmentalProtectionObligation(
      "Нужен прибор для открытой площадки",
      [{ caption: "Цвет корпуса", values: [{ value: "черный" }] }],
      null,
    ),
    false,
  );
  assertEquals(
    hasUnresolvedEnvironmentalProtectionObligation(
      "Нужен прибор для улицы",
      facets,
      null,
    ),
    true,
  );
  assertEquals(
    hasUnresolvedEnvironmentalProtectionObligation(
      "Нужен прибор для открытой площадки",
      facets,
      null,
    ),
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

  // The design guard must not silently change an unrelated retrieval branch,
  // even when the existing classification cleanup rewrites visible prose.
  const ordinary = resolveDerivedSelectionReasoning({
    reasoning: "Подбираю накладные изделия для указанного применения.",
    retrieval_query: "накладные изделия",
    compatible_classifications: [],
    excluded_classifications: [],
  }, [{
    key: "kind",
    caption: "Класс применения",
    values: [{ value: "подвесные изделия" }, { value: "накладные изделия" }],
  }], "Нужны подвесные изделия", "Изделия");
  assertEquals(ordinary?.retrievalQuery, "накладные изделия");
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

Deno.test("a room circumstance cannot become an exact catalog purpose filter", () => {
  const facets = [{
    key: "purpose",
    caption: "Назначение",
    type: "string",
    values: [
      { value: "зал; гостиная; спальня; кафе; кухня" },
      { value: "офис" },
      { value: "улица" },
    ],
  }];
  const declared = {
    reasoning: "Подбираю люстру с подтверждённой площадью освещения.",
    compatible_classifications: ["f0v0"],
    excluded_classifications: [],
    required_facet_values: [],
    explicit_customer_classifications: [{
      customer_phrase: "зале",
      classification_id: "f0v0",
    }],
  };
  const room = resolveDerivedSelectionReasoning(
    declared,
    facets,
    "Хочу поменять дома люстру в зале 30 квадратов",
    "Люстры",
  );
  assertEquals(room?.explicitCustomerMappings, []);
  assertEquals(room?.customerGroundedCompatible, []);
  assertEquals(room?.compatible, [{
    key: "Назначение",
    value: "зал; гостиная; спальня; кафе; кухня",
  }]);
  assertEquals(
    room?.text.includes("не становится обязательным фильтром"),
    true,
  );

  const forRoom = resolveDerivedSelectionReasoning(
    {
      ...declared,
      explicit_customer_classifications: [{
        customer_phrase: "гостиной",
        classification_id: "f0v0",
      }],
    },
    facets,
    "Нужен светильник для гостиной площадью 30 м²",
    "Светильники",
  );
  assertEquals(forRoom?.explicitCustomerMappings, []);
  assertEquals(forRoom?.customerGroundedCompatible, []);
});

Deno.test("a model cannot turn room area into a required product shape", () => {
  const facets = [{
    key: "shape",
    caption: "Форма люстры",
    type: "string",
    values: [{ value: "квадрат" }, { value: "круг" }],
  }];
  const declaration = {
    reasoning: "Для подбора проверяю обязательную форму люстры: квадрат.",
    compatible_classifications: [],
    excluded_classifications: [],
    required_facet_values: ["f0v0"],
    explicit_customer_classifications: [],
  };

  for (const request of [
    "Хочу поменять люстру в зале 30 квадратов",
    "Хочу поменять люстру в зале 30 квадратных метров",
    "Хочу поменять люстру в зале 30 квадратов. А есть другие варианты?",
  ]) {
    const resolved = resolveDerivedSelectionReasoning(
      declaration,
      facets,
      request,
      "Люстры",
    );
    assertEquals(resolved?.requiredFacetValues, [], request);
    assertEquals(resolved?.reasoningEvidence.includes("квадрат"), false, request);
    assertEquals(resolved?.measurementEvidence.includes("квадрат"), false, request);
  }

  for (const request of [
    "Нужна квадратная люстра для зала 30 квадратов",
    "Нужна люстра квадратной формы для зала 30 квадратов",
    "Нужна форма квадрат для зала 30 квадратов",
  ]) {
    const resolved = resolveDerivedSelectionReasoning(
      declaration,
      facets,
      request,
      "Люстры",
    );
    assertEquals(resolved?.requiredFacetValues, [{
      key: "Форма люстры",
      value: "квадрат",
    }], request);
  }

  // Another functional, model-derived technical requirement remains eligible.
  const technical = resolveDerivedSelectionReasoning({
    ...declaration,
    reasoning: "Для установки на улице требуется степень защиты IP65.",
  }, [{
    key: "ip",
    caption: "Степень защиты IP",
    type: "string",
    values: [{ value: "IP65" }, { value: "IP44" }],
  }], "Нужен прожектор для улицы площадью 30 квадратов", "Прожекторы");
  assertEquals(technical?.requiredFacetValues, [{
    key: "Степень защиты IP",
    value: "IP65",
  }]);

  const mixedFacets = [{
    key: "shape",
    caption: "Форма изделия",
    values: [{ value: "квадрат" }, { value: "круг" }],
  }, {
    key: "ip",
    caption: "Степень защиты IP",
    values: [{ value: "IP65" }, { value: "IP44" }],
  }];
  const mixed = resolveDerivedSelectionReasoning({
    ...declaration,
    reasoning: "Для улицы нужна степень защиты IP65 и форма изделия: квадрат.",
    required_facet_values: ["f0v0", "f1v0"],
    retrieval_query: "квадрат",
  }, mixedFacets, "Нужен прибор для улицы на участке 30 квадратов", "Изделия");
  assertEquals(mixed?.requiredFacetValues, [{
    key: "Степень защиты IP",
    value: "IP65",
  }]);
  assertEquals(mixed?.reasoningEvidence.includes("IP65"), true);
  assertEquals(mixed?.reasoningEvidence.includes("квадрат"), false);
  assertEquals(mixed?.retrievalQuery, null);

  const separated = resolveDerivedSelectionReasoning({
    ...declaration,
    reasoning: "Для улицы нужна степень защиты IP65. Форма изделия: квадрат.",
    required_facet_values: ["f0v0", "f1v0"],
  }, mixedFacets, "Нужен прибор для улицы на участке 30 квадратов", "Изделия");
  assertEquals(separated?.requiredFacetValues, [{
    key: "Степень защиты IP",
    value: "IP65",
  }]);
  assertEquals(separated?.reasoningEvidence.includes("IP65"), true);
  assertEquals(separated?.reasoningEvidence.includes("квадрат"), false);

  const explicitMixed = resolveDerivedSelectionReasoning({
    ...declaration,
    reasoning: "Для улицы нужна степень защиты IP65 и форма изделия: квадрат.",
    required_facet_values: ["f0v0", "f1v0"],
    retrieval_query: "квадрат",
  }, mixedFacets, "Нужно квадратное изделие для улицы на участке 30 квадратов", "Изделия");
  assertEquals(explicitMixed?.requiredFacetValues, [{
    key: "Форма изделия",
    value: "квадрат",
  }, {
    key: "Степень защиты IP",
    value: "IP65",
  }]);
  assertEquals(explicitMixed?.retrievalQuery, "квадрат");
});

Deno.test("model-only appearance prose and retrieval are rejected without a required ID", () => {
  const shapeFacets = [{
    key: "shape",
    caption: "Форма люстры",
    values: [{ value: "квадрат" }, { value: "круг" }],
  }];
  const model = {
    reasoning:
      "Для зала 30 квадратов проверяю достаточную яркость. Форма люстры: квадрат.",
    retrieval_query: "квадрат",
    required_facet_values: [],
    compatible_classifications: [],
    excluded_classifications: [],
  };
  const inferred = resolveDerivedSelectionReasoning(
    model,
    shapeFacets,
    "Нужна люстра в зал 30 квадратов",
    "Люстры",
  );
  assertEquals(inferred?.requiredFacetValues, []);
  assertEquals(inferred?.retrievalQuery, null);
  assertEquals(inferred?.reasoningEvidence.includes("Форма люстры"), false);
  assertEquals(inferred?.measurementEvidence.includes("Форма люстры"), false);
  assertEquals(inferred?.reasoningEvidence.includes("30 квадратов"), true);

  const explicit = resolveDerivedSelectionReasoning(
    model,
    shapeFacets,
    "Нужна квадратная люстра в зал 30 квадратов",
    "Люстры",
  );
  assertEquals(explicit?.requiredFacetValues, [{
    key: "Форма люстры",
    value: "квадрат",
  }]);
  assertEquals(explicit?.retrievalQuery, "квадрат");
  assertEquals(explicit?.reasoningEvidence.includes("Форма люстры"), true);

  const style = resolveDerivedSelectionReasoning(
    {
      ...model,
      reasoning: "Подбираю светильники для гостиной. Стиль: лофт.",
      retrieval_query: "лофт",
    },
    [{
      key: "style",
      caption: "Стиль",
      values: [{ value: "лофт" }, { value: "классика" }],
    }],
    "Нужны светильники в гостиную",
    "Светильники",
  );
  assertEquals(style?.requiredFacetValues, []);
  assertEquals(style?.reasoningEvidence.includes("лофт"), false);
  assertEquals(style?.retrievalQuery, null);

  const explicitStyle = resolveDerivedSelectionReasoning(
    {
      ...model,
      reasoning: "Подбираю светильники для гостиной. Стиль: лофт.",
      retrieval_query: "лофт",
    },
    [{
      key: "style",
      caption: "Стиль",
      values: [{ value: "лофт" }, { value: "классика" }],
    }],
    "Нужны светильники в стиле лофт для гостиной",
    "Светильники",
  );
  assertEquals(explicitStyle?.requiredFacetValues, [{
    key: "Стиль",
    value: "лофт",
  }]);
  assertEquals(explicitStyle?.retrievalQuery, "лофт");
});

Deno.test("dropping model-only appearance keeps independent technical reasoning and retrieval", () => {
  const facets = [{
    key: "shape",
    caption: "Форма изделия",
    values: [{ value: "квадрат" }, { value: "круг" }],
  }, {
    key: "ip",
    caption: "Степень защиты IP",
    values: [{ value: "IP65" }, { value: "IP44" }],
  }];
  const resolved = resolveDerivedSelectionReasoning(
    {
      reasoning:
        "Для улицы нужна степень защиты IP65 и форма изделия: квадрат.",
      retrieval_query: "IP65",
      required_facet_values: [],
      compatible_classifications: [],
      excluded_classifications: [],
    },
    facets,
    "Нужен светильник для улицы на участке 30 квадратов",
    "Светильники",
  );
  assertEquals(resolved?.requiredFacetValues, [{
    key: "Степень защиты IP",
    value: "IP65",
  }]);
  assertEquals(resolved?.reasoningEvidence.includes("IP65"), true);
  assertEquals(resolved?.reasoningEvidence.includes("форма изделия"), false);
  assertEquals(resolved?.retrievalQuery, "IP65");
});

Deno.test("English shape keys cannot bypass customer-owned design grounding", () => {
  for (const facet of [
    { key: "shape", caption: undefined },
    { key: "appearance", caption: "Геометрия товара" },
    { key: "form", caption: undefined },
    { key: "forma", caption: undefined },
  ]) {
    const facets = [{
      ...facet,
      values: [{ value: "квадрат" }, { value: "круг" }],
    }];
    const label = facet.caption || facet.key;
    const declaration = {
      reasoning: `Для подбора проверяю ${label}: квадрат.`,
      required_facet_values: ["f0v0"],
      compatible_classifications: [],
      excluded_classifications: [],
    };
    const inferred = resolveDerivedSelectionReasoning(
      declaration,
      facets,
      "Нужно изделие для помещения 30 квадратов",
      "Изделия",
    );
    assertEquals(inferred?.requiredFacetValues, [], facet.key);
    assertEquals(inferred?.reasoningEvidence.includes("квадрат"), false, facet.key);

    const explicit = resolveDerivedSelectionReasoning(
      declaration,
      facets,
      "Нужно квадратное изделие для помещения 30 квадратов",
      "Изделия",
    );
    assertEquals(explicit?.requiredFacetValues, [{
      key: label,
      value: "квадрат",
    }], facet.key);
  }
});

Deno.test("English style and design axes remain customer-owned", () => {
  for (const key of ["style", "design"]) {
    const facets = [{
      key,
      values: [{ value: "лофт" }, { value: "классика" }],
    }];
    const declaration = {
      reasoning: `Для подбора проверяю ${key}: лофт.`,
      required_facet_values: ["f0v0"],
      compatible_classifications: [],
      excluded_classifications: [],
    };
    const inferred = resolveDerivedSelectionReasoning(
      declaration,
      facets,
      "Нужно изделие для гостиной 30 м²",
      "Изделия",
    );
    assertEquals(inferred?.requiredFacetValues, [], key);

    const explicit = resolveDerivedSelectionReasoning(
      declaration,
      facets,
      `Нужно изделие ${key} лофт для гостиной 30 м²`,
      "Изделия",
    );
    assertEquals(explicit?.requiredFacetValues, [{ key, value: "лофт" }], key);

    const naturalExplicit = resolveDerivedSelectionReasoning(
      declaration,
      facets,
      key === "style"
        ? "Нужно изделие в стиле лофт для гостиной 30 м²"
        : "Нужно изделие с дизайном лофт для гостиной 30 м²",
      "Изделия",
    );
    assertEquals(
      naturalExplicit?.requiredFacetValues,
      [{ key, value: "лофт" }],
      key,
    );
  }
});

Deno.test("a direct product-use qualifier remains customer-owned", () => {
  const facets = [{
    key: "purpose",
    caption: "Назначение",
    type: "string",
    values: [{ value: "бытовой" }, { value: "промышленный" }],
  }];
  const resolved = resolveDerivedSelectionReasoning(
    {
      reasoning: "Подбираю бытовой светильник по заявленному применению.",
      compatible_classifications: ["f0v0"],
      excluded_classifications: [],
      required_facet_values: [],
      explicit_customer_classifications: [{
        customer_phrase: "бытовой",
        classification_id: "f0v0",
      }],
    },
    facets,
    "Нужен бытовой светильник",
    "Светильники",
  );
  assertEquals(resolved?.customerGroundedCompatible, [{
    key: "Назначение",
    value: "бытовой",
  }]);
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
  assertEquals(
    resolved?.text.includes("если товаров из подтверждённого класса нет"),
    true,
  );
  assertEquals(resolved?.applicationSuitabilityAlternatives, [{
    key: "Класс применения",
    value: "бытовые",
  }]);
  assertEquals(
    resolved?.measurementEvidence,
    "Подбираю подходящий вариант по явно указанному применению.",
  );
  assertEquals(
    resolved?.measurementEvidence.includes("бытовые изделия"),
    false,
  );
});

Deno.test("a generic replacement target noun cannot bind unrelated lighting-use classes", () => {
  const facets = [{
    caption: "Вид светильника",
    type: "string",
    values: [
      { value: "аварийное освещение" },
      { value: "офисно-административное освещение" },
      { value: "светильники для промышленного освещения" },
      { value: "для освещения улиц" },
      { value: "декоративное освещение" },
      { value: "светильник для ориентационного освещения" },
      { value: "бытовые светильники накладные" },
      { value: "бытовые светильники подвесные" },
    ],
  }];
  const resolved = resolveDerivedSelectionReasoning(
    {
      reasoning: "Для гостиной подбираю светодиодное освещение по площади.",
      compatible_classifications: ["f0v1"],
      excluded_classifications: [],
    },
    facets,
    "Хочу заменить люстру на светодиодное освещение в гостиной 25 м²",
    "Светильники",
  );

  assertEquals(resolved?.customerGroundedCompatible, []);
  assertEquals(resolved && compileCustomerClassificationCriteria(resolved), []);
  assertEquals(resolved?.familyCompatibleFacetKeys, []);
  assertEquals(
    resolved?.text.includes("По вашему обязательному классу"),
    false,
  );
});

Deno.test("a generic power-use noun cannot bind arbitrary server and office branches", () => {
  const facets = [{
    caption: "Класс применения",
    type: "string",
    values: [
      { value: "для резервного электропитания серверов" },
      { value: "для электропитания офисной техники" },
      { value: "для газовых котлов" },
      { value: "бытовые модели" },
    ],
  }];
  const resolved = resolveDerivedSelectionReasoning(
    {
      reasoning:
        "Подбираю резервное электропитание по нагрузке и времени работы.",
      compatible_classifications: ["f0v0"],
      excluded_classifications: [],
    },
    facets,
    "Нужен ИБП для электропитания в доме",
    "Источники бесперебойного питания",
  );

  assertEquals(resolved?.customerGroundedCompatible, []);
  assertEquals(resolved && compileCustomerClassificationCriteria(resolved), []);
});

Deno.test("an explicit descriptive family remains user-owned across mounting variants", () => {
  const facets = [{
    caption: "Вид светильника",
    type: "string",
    values: [
      { value: "бытовые светильники накладные" },
      { value: "бытовые светильники подвесные" },
      { value: "офисное освещение" },
    ],
  }];
  const resolved = resolveDerivedSelectionReasoning(
    {
      reasoning: "Для дома нужен подходящий светильник.",
      compatible_classifications: ["f0v2"],
      excluded_classifications: [],
    },
    facets,
    "Нужен бытовой светильник",
    "Светильники",
  );
  assertEquals(resolved?.customerGroundedCompatible, [
    { key: "Вид светильника", value: "бытовые светильники накладные" },
    { key: "Вид светильника", value: "бытовые светильники подвесные" },
  ]);
  assertEquals(resolved?.applicationSuitabilityAlternatives, [{
    key: "Вид светильника",
    value: "бытовой",
  }]);
});

Deno.test("a customer-owned noun class still keeps its live mounting family", () => {
  const resolved = resolveDerivedSelectionReasoning(
    {
      reasoning: "Покажу варианты бра с разным монтажом.",
      compatible_classifications: ["f0v0"],
      excluded_classifications: [],
    },
    [{
      caption: "Вид светильника",
      type: "string",
      values: [
        { value: "бра настенные" },
        { value: "бра потолочные" },
        { value: "торшеры" },
      ],
    }],
    "Нужны бра для комнаты",
    "Светильники",
  );

  assertEquals(resolved?.customerGroundedCompatible, [
    { key: "Вид светильника", value: "бра настенные" },
    { key: "Вид светильника", value: "бра потолочные" },
  ]);
});

Deno.test("a complete live subtype remains exact even when its generic noun is shared", () => {
  const resolved = resolveDerivedSelectionReasoning(
    {
      reasoning: "Нужно офисно-административное освещение.",
      compatible_classifications: ["f0v0"],
      excluded_classifications: [],
    },
    [{
      caption: "Вид светильника",
      type: "string",
      values: [
        { value: "офисно-административное освещение" },
        { value: "аварийное освещение" },
        { value: "декоративное освещение" },
        { value: "бытовые светильники" },
      ],
    }],
    "Нужно офисно-административное освещение",
    "Светильники",
  );

  assertEquals(resolved?.customerGroundedCompatible, [{
    key: "Вид светильника",
    value: "офисно-административное освещение",
  }]);
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
  assertEquals(refined?.text.includes("бытовые изделия накладные"), true);
  assertEquals(refined?.text.includes("бытовые изделия подвесные"), true);
  assertEquals(refined?.text.includes("промышленные изделия"), false);

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
  assertEquals(resolved?.applicationSuitabilityAlternatives, [{
    key: "Вид светильника",
    value: "бытовой",
  }]);
});

Deno.test("broad application stays mandatory across catalog sales classes when each card proves it", () => {
  const facets = [{
    key: "kind",
    caption: "Вид светильника",
    type: "string",
    unit: null,
    values: [
      { value: "Бытовые светильники накладные" },
      { value: "Бытовые светильники подвесные" },
      { value: "Светильники для ЖКХ" },
      { value: "Промышленные светильники" },
    ],
  }];
  const declaration = resolveDerivedSelectionReasoning(
    {
      reasoning: "Сначала проверю бытовые светильники с датчиком движения.",
      compatible_classifications: ["f0v0"],
      excluded_classifications: [],
    },
    facets,
    "Нужен бытовой светильник с датчиком движения",
    "Светильники",
  );
  if (!declaration) throw new Error("expected a grounded declaration");
  const criteria = [
    ...compileCustomerClassificationCriteria(declaration),
    ...compileApplicationSuitabilityAlternatives(declaration),
    {
      key: "С датчиком движения",
      op: "eq" as const,
      value: "да",
      level: "A" as const,
      evidence: "user_explicit" as const,
    },
  ];
  assertEquals(projectCriteriaFacetOptions(criteria, facets).options, {
    kind: ["Бытовые светильники накладные", "Бытовые светильники подвесные"],
  });
  const item = (id: string, kind: string, description: string): ProductRef => ({
    id,
    pagetitle: `Светильник ${id} с датчиком движения`,
    vendor: null,
    price: 3000,
    stock: "in_stock",
    short_traits: [`Вид светильника: ${kind}`],
    description_excerpt: description,
  });
  const passed = applyCriteriaGate([
    item("domestic", "Бытовые светильники накладные", "Реагирует на движение."),
    item(
      "cross-class",
      "Светильники для ЖКХ",
      "Для общественного и бытового освещения. Реагирует на движение.",
    ),
    item(
      "industry",
      "Промышленные светильники",
      "Только для промышленного освещения. Реагирует на движение.",
    ),
    item(
      "negated",
      "Светильники для ЖКХ",
      "Не предназначен для бытового освещения. Реагирует на движение.",
    ),
    item(
      "acoustic",
      "Бытовые светильники накладные",
      "Датчик реагирует только на звук.",
    ),
  ], criteria).passed_ids;
  assertEquals(passed, ["domestic", "cross-class"]);
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

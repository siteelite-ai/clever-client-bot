// Unit tests: Layer 5 — рассуждение модели как источник истины.
// Data-agnostic: абстрактные имена параметров.

import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import {
  alignCriteriaImportanceWithReasoning,
  alignCriteriaWithReasoning,
  certifiedCustomerApplicationCapacityOptions,
  compileMeasuredReasoningSearchContract,
  customerAggregateMeasurementScope,
  customerOwnsDerivedExactFacetValue,
  demoteUnfrozenRenderCriteria,
  extractReasoningBounds,
  extractUnownedMeasuredClaims,
  filterPerProductMeasuredCriteria,
  hasMeasuredSelectionRequirement,
  preserveCertifiedCustomerCapacityOptions,
  projectLiteralMeasuredCriteria,
  projectReasoningRangeCriteria,
  projectSingleRecommendedMeasuredCriterion,
  promoteMeasuredReasoningCriteria,
  promoteProjectableMeasuredFallbackCriteria,
} from "./criteria-reasoning.ts";
import {
  applyCriteriaGate,
  checkCriterion,
  type Criterion,
  extendSelectionCriteriaPlan,
  mergeMandatorySelectionCriteria,
  projectCriteriaFacetOptions,
  resolveTerminalSelectionCriteria,
  restrictSelectionCriteriaPlan,
} from "./criteria-gate.ts";
import {
  compatibilityRelationsToCriteria,
  subsumeCriteriaProvenByCompatibility,
  subsumePairedStateCriteria,
} from "./compatibility-contract.ts";
import {
  extractSchemaBackedMeasuredReference,
  terminalPairedFitDecision,
} from "../../chat-consultant-v3/selection-jargon-policy.ts";
import type { ProductRef } from "./types.ts";

function product(id: string, traits: string[]): ProductRef {
  return {
    id,
    pagetitle: `P-${id}`,
    vendor: null,
    price: 100,
    stock: "unknown",
    short_traits: traits,
  };
}

Deno.test("measurement units cannot be assembled across model/customer roles", () => {
  const criterion: Criterion = {
    key: "Номинальный ток, А",
    op: "eq",
    value: 1.5,
    level: "A",
    evidence: "model_assumption",
  };
  const customer = "А есть другие варианты?";
  // The model's final 1,5 and customer's opening А belong to different
  // messages. They must not become a fictitious 1,5 А physical measurement.
  assertEquals(
    filterPerProductMeasuredCriteria(
      [criterion],
      "Ищу модель 1,5",
      customer,
      "per_product",
    ).criteria,
    [criterion],
  );
  // Within a single model message, the line break is ordinary spacing.
  assertEquals(
    filterPerProductMeasuredCriteria(
      [criterion],
      "Ищу модель 1,5\nА",
      customer,
      "per_product",
    ).removed,
    [criterion],
  );
});

Deno.test("one visible recommended measurement projects to one exact live facet", () => {
  const projected = projectSingleRecommendedMeasuredCriterion(
    "Расчетная нагрузка составляет 3 кВт. Рекомендуется изделие с площадью поверхности 20 см².",
    [{
      key: "surface_area",
      caption: "Площадь поверхности, см2",
      unit: "см²",
      values: [{ value: "10" }, { value: "20" }, { value: "30" }],
    }],
  );
  assertEquals(projected, {
    criterion: {
      key: "Площадь поверхности, см2",
      op: "eq",
      value: "20",
      unit: "см²",
      level: "A",
      evidence: "derived_required",
    },
    reason: "projected",
  });
});

Deno.test("recommended exact measurement is schema-driven across inflection and decimal spelling", () => {
  const projected = projectSingleRecommendedMeasuredCriterion(
    "Для расчетной нагрузки рекомендуется силовой вариант сечением 2.5 мм².",
    [{
      key: "section",
      caption: "Сечение изделия, мм2",
      unit: "мм²",
      values: [{ value: "1.5" }, { value: "2.5" }, { value: "4" }],
    }],
  );
  assertEquals(projected.criterion, {
    key: "Сечение изделия, мм2",
    op: "eq",
    value: "2.5",
    unit: "мм²",
    level: "A",
    evidence: "derived_required",
  });
});

Deno.test("recommended measurement fails closed without a unique local facet meaning", () => {
  const facets = [
    {
      key: "before_size",
      caption: "Диаметр до преобразования, мм",
      unit: "мм",
      values: [{ value: "12" }, { value: "14" }],
    },
    {
      key: "after_size",
      caption: "Диаметр после преобразования, мм",
      unit: "мм",
      values: [{ value: "8" }, { value: "12" }],
    },
  ];
  assertEquals(
    projectSingleRecommendedMeasuredCriterion(
      "Рекомендуется диаметр 12 мм.",
      facets,
    ),
    { criterion: null, reason: "ambiguous_schema_match" },
  );
  assertEquals(
    projectSingleRecommendedMeasuredCriterion(
      "Рекомендуется значение 12 мм.",
      facets,
    ),
    { criterion: null, reason: "no_schema_match" },
  );
});

Deno.test("directional and competing recommended tiers stay outside exact projection", () => {
  const facets = [{
    key: "dimension",
    caption: "Рабочий размер, мм",
    unit: "мм",
    values: [{ value: "10" }, { value: "12" }, { value: "14" }],
  }];
  assertEquals(
    projectSingleRecommendedMeasuredCriterion(
      "Рекомендуется рабочий размер не менее 12 мм.",
      facets,
    ).reason,
    "directional_or_range",
  );
  assertEquals(
    projectSingleRecommendedMeasuredCriterion(
      "Минимальный рабочий размер 10 мм. Рекомендуется рабочий размер 12 мм.",
      facets,
    ).reason,
    "competing_values",
  );
});

Deno.test("extractReasoningBounds: направления и строгость", () => {
  assertEquals(extractReasoningBounds("нужен диаметр больше 12 мм"), [
    { op: "min", value: 12, unit: "мм", strict: true },
  ]);
  assertEquals(extractReasoningBounds("не менее 40 мм"), [
    { op: "min", value: 40, unit: "мм", strict: false },
  ]);
  assertEquals(extractReasoningBounds("не более 15 а"), [
    { op: "max", value: 15, unit: "а", strict: false },
  ]);
  assertEquals(extractReasoningBounds("нужно 12 штук"), []);
});

Deno.test("escaped comparison glyphs keep strict bounds, but angle quotes do not", () => {
  assertEquals(
    extractReasoningBounds("До установки диаметр › 10 мм, после усадки диаметр ‹ 10 мм."),
    [
      { op: "min", value: 10, unit: "мм", strict: true },
      { op: "max", value: 10, unit: "мм", strict: true },
    ],
  );
  assertEquals(extractReasoningBounds("Размер ‹10 мм› указан в карточке."), []);
});

Deno.test("измеримое рассуждение требует машинного критерия, голая маркировка — нет", () => {
  assertEquals(
    hasMeasuredSelectionRequirement("нужен поток 3750–5000 лм для комнаты"),
    true,
  );
  assertEquals(
    hasMeasuredSelectionRequirement("трубка должна охватывать кабель 12 мм"),
    true,
  );
  assertEquals(
    hasMeasuredSelectionRequirement("покажи кабель ВВГ 2×1,5"),
    false,
  );
  assertEquals(
    hasMeasuredSelectionRequirement(
      "Обычно такие лампы имеют E27 или E14 и часто работают на 220 В.",
    ),
    false,
  );
  assertEquals(
    hasMeasuredSelectionRequirement(
      "Считаем: площадь 25 м² × 175 лк, итого 4375 лм.",
    ),
    true,
  );
  assertEquals(
    hasMeasuredSelectionRequirement(
      "ДКУ-LED-03-100W — исходная модель; подбираю замену.",
    ),
    false,
  );
  assertEquals(
    hasMeasuredSelectionRequirement(
      "Посмотрю несколько вариантов на любой кошелёк: от простых бытовых на 3–5 метров до усиленных.",
    ),
    false,
  );
  assertEquals(
    hasMeasuredSelectionRequirement("Покажи удлинители длиной 3–5 метров"),
    true,
  );
});

Deno.test("числовой диапазон из рассуждения проецируется на уникальный живой фасет", () => {
  const projected = projectReasoningRangeCriteria(
    [],
    "ориентир 3750–5000 люмен",
    [
      {
        key: "svetovoj_potok",
        caption: "Световой поток",
        type: "number",
        unit: "лм",
      },
      { key: "power", caption: "Мощность", type: "number", unit: "Вт" },
    ],
  );
  assertEquals(projected.added, [{
    key: "Световой поток",
    op: "range",
    value: [3750, 5000],
    unit: "лм",
    level: "A",
  }]);
});

Deno.test("распределённая суммарная потребность не становится параметром каждой карточки", () => {
  const reasoning =
    "Для площадки нужен суммарный световой поток 20000–25000 лм; его лучше равномерно распределить между несколькими приборами по периметру.";
  const projected = projectReasoningRangeCriteria([], reasoning, [
    { key: "flow", caption: "Световой поток", type: "number", unit: "лм" },
  ]);
  assertEquals(projected.added, []);
  assertEquals(hasMeasuredSelectionRequirement(reasoning), false);
});

Deno.test("область суммарного расчёта действует между соседними предложениями", () => {
  const reasoning =
    "Общий световой поток должен быть не менее 25000 лм. Это суммарная потребность всей системы: её нужно распределить между несколькими товарами.";
  const projected = projectReasoningRangeCriteria([], reasoning, [
    { key: "flow", caption: "Световой поток", type: "number", unit: "лм" },
  ]);
  assertEquals(projected.added, []);
  assertEquals(hasMeasuredSelectionRequirement(reasoning), false);
});

Deno.test("customer aggregate scope is known before discovery only for explicit physical totals", () => {
  assertEquals(
    customerAggregateMeasurementScope(
      "Общий световой поток 5000 лм от нескольких прожекторов.",
    ),
    "system_total",
  );
  assertEquals(
    customerAggregateMeasurementScope(
      "Суммарный световой поток не менее 5000 лм. Покажи прожекторы.",
    ),
    "system_total",
  );
  assertEquals(
    customerAggregateMeasurementScope(
      "Нужна система освещения с суммарным световым потоком 5000 лм.",
    ),
    "system_total",
  );
  assertEquals(
    customerAggregateMeasurementScope(
      "Для участка суммарная длина кабеля 500 м, покажи варианты.",
    ),
    "system_total",
  );
  assertEquals(
    customerAggregateMeasurementScope(
      "Нужен светильник со световым потоком не менее 1800 лм.",
    ),
    null,
  );
  assertEquals(
    customerAggregateMeasurementScope(
      "Хочу заменить люстру на светильник с общим световым потоком 5000 лм.",
    ),
    null,
  );
  assertEquals(
    customerAggregateMeasurementScope(
      "Нужен один светильник с суммарным световым потоком 5000 лм.",
    ),
    null,
  );
  assertEquals(
    customerAggregateMeasurementScope(
      "Суммарный бюджет не более 5000 тенге. Покажи товары.",
    ),
    null,
  );
});

Deno.test("customer-owned total without area overrides a model per-product scope through search and render", () => {
  const customer =
    "Суммарный световой поток не менее 5000 лм от нескольких приборов. Покажи варианты IP65.";
  const reasoning =
    "Для всей системы нужен поток не менее 5000 лм. Каждый вариант должен иметь защиту IP65.";
  const total: Criterion = {
    key: "Световой поток",
    op: "min",
    value: 5000,
    unit: "лм",
    level: "A",
    evidence: "user_explicit",
  };
  const protection: Criterion = {
    key: "Степень защиты",
    op: "eq",
    value: "IP65",
    level: "A",
    evidence: "user_explicit",
  };
  // A model may serialize `per_product`, but an explicit customer total has
  // stronger authority and must be resolved before any search/plan freeze.
  const modelScope = "per_product";
  const scope = customerAggregateMeasurementScope(customer) ?? modelScope;
  assertEquals(scope, "system_total");

  const early = filterPerProductMeasuredCriteria(
    [total, protection],
    reasoning,
    customer,
    scope,
  ).criteria;
  assertEquals(early, [protection]);
  const accidentallyFrozen = extendSelectionCriteriaPlan(
    null,
    [total, protection],
    "guarded_search",
  );
  const reconciled = restrictSelectionCriteriaPlan(accidentallyFrozen, early);
  assertEquals(reconciled?.mandatory_criteria, [protection]);

  // The terminal path can merge stale arrays; the same scope must remove the
  // aggregate before extending the frozen contract or gating cards.
  const terminal = filterPerProductMeasuredCriteria(
    resolveTerminalSelectionCriteria([total], [total], [protection]),
    reasoning,
    customer,
    scope,
  ).criteria;
  const rendered = extendSelectionCriteriaPlan(
    reconciled,
    terminal,
    "render_alignment",
  );
  assertEquals(rendered.mandatory_criteria, [protection]);
  assertEquals(
    applyCriteriaGate([
      product("below-total-a", [
        "Световой поток: 1200 лм",
        "Степень защиты: IP65",
      ]),
      product("below-total-b", [
        "Световой поток: 2400 лм",
        "Степень защиты: IP65",
      ]),
      product("wrong-protection", [
        "Световой поток: 6000 лм",
        "Степень защиты: IP44",
      ]),
    ], [...rendered.mandatory_criteria]).passed_ids,
    ["below-total-a", "below-total-b"],
  );
});

Deno.test("mixed total and explicit per-item minimum constrain only each item's minimum", () => {
  const customer =
    "Суммарный световой поток должен быть не менее 5000 лм; каждый прибор должен давать не менее 1000 лм и иметь IP65.";
  const total: Criterion = {
    key: "Световой поток",
    op: "min",
    value: 5000,
    unit: "лм",
    level: "A",
    evidence: "user_explicit",
  };
  const each: Criterion = {
    ...total,
    value: 1000,
  };
  const protection: Criterion = {
    key: "Степень защиты",
    op: "eq",
    value: "IP65",
    level: "A",
    evidence: "user_explicit",
  };
  const scope = customerAggregateMeasurementScope(customer);
  assertEquals(scope, "system_total");
  const criteria = filterPerProductMeasuredCriteria(
    [total, each, protection],
    "Общий поток системы 5000 лм. Каждый прибор должен давать не менее 1000 лм.",
    customer,
    scope,
  ).criteria;
  assertEquals(criteria, [each, protection]);
  assertEquals(
    applyCriteriaGate([
      product("sufficient", [
        "Световой поток: 1200 лм",
        "Степень защиты: IP65",
      ]),
      product("too-weak", [
        "Световой поток: 800 лм",
        "Степень защиты: IP65",
      ]),
      product("wrong-protection", [
        "Световой поток: 5500 лм",
        "Степень защиты: IP44",
      ]),
    ], criteria).passed_ids,
    ["sufficient"],
  );
});

Deno.test("customer aggregate outranks a contradictory model per-item claim for the same value", () => {
  const customer =
    "Суммарный световой поток не менее 5000 лм от нескольких приборов; каждый прибор должен давать не менее 1000 лм.";
  const mistakenReasoning = "Каждый прибор должен давать не менее 5000 лм.";
  const total: Criterion = {
    key: "Световой поток",
    op: "min",
    value: 5000,
    unit: "лм",
    level: "A",
    evidence: "user_explicit",
  };
  const each: Criterion = {
    ...total,
    value: 1000,
  };
  assertEquals(customerAggregateMeasurementScope(customer), "system_total");
  const scoped = filterPerProductMeasuredCriteria(
    [total, each],
    mistakenReasoning,
    customer,
    "system_total",
  );
  assertEquals(scoped.criteria, [each]);
  assertEquals(scoped.removed, [total]);
});

Deno.test("aggregate numeric value with embedded unit does not survive without a separate unit field", () => {
  const total: Criterion = {
    key: "Световой поток",
    op: "eq",
    value: "5000 лм",
    level: "A",
    evidence: "user_explicit",
  };
  const customer = "Суммарный световой поток 5000 лм от нескольких приборов.";
  assertEquals(customerAggregateMeasurementScope(customer), "system_total");
  const aggregate = filterPerProductMeasuredCriteria(
    [total],
    customer,
    customer,
    "system_total",
  );
  assertEquals(aggregate.criteria, []);
  assertEquals(aggregate.removed, [total]);
  assertEquals(
    filterPerProductMeasuredCriteria(
      [total],
      "Один прибор со световым потоком 5000 лм.",
      "Один прибор со световым потоком 5000 лм.",
      "per_product",
    ).criteria,
    [total],
  );
});

Deno.test("aggregate range encoded inside a facet value does not become a per-card range", () => {
  const total: Criterion = {
    key: "Световой поток",
    op: "eq",
    value: "2000–3000 лм",
    level: "A",
    evidence: "user_explicit",
  };
  const customer = "Суммарный световой поток системы должен быть 2000–3000 лм.";
  const scoped = filterPerProductMeasuredCriteria(
    [total],
    customer,
    customer,
    "system_total",
  );
  assertEquals(scoped.criteria, []);
  assertEquals(scoped.removed, [total]);
});

Deno.test("live numeric facet unit scopes an aggregate even when the model omits the unit", () => {
  const total: Criterion = {
    key: "Световой поток",
    op: "min",
    value: 5000,
    level: "A",
    evidence: "user_explicit",
  };
  const customer = "Суммарный световой поток системы не менее 5000 лм.";
  const facets = [{
    key: "flow",
    caption: "Световой поток",
    unit: "лм",
    values: [{ value: "1000" }, { value: "5000" }],
  }];
  const scoped = filterPerProductMeasuredCriteria(
    [total],
    customer,
    customer,
    "system_total",
    facets,
  );
  assertEquals(scoped.criteria, []);
  assertEquals(scoped.removed, [total]);
});

Deno.test("измеримый диапазон каждого отдельного товара остаётся обязательным", () => {
  const reasoning = "Каждый прибор должен давать 4000–5000 лм.";
  const projected = projectReasoningRangeCriteria([], reasoning, [
    { key: "flow", caption: "Световой поток", type: "number", unit: "лм" },
  ]);
  assertEquals(projected.added, [
    {
      key: "Световой поток",
      op: "range",
      value: [4000, 5000],
      unit: "лм",
      level: "A",
    },
  ]);
  assertEquals(hasMeasuredSelectionRequirement(reasoning), true);
});

Deno.test("system-total: total output and illustrative each-item power cannot become card filters", () => {
  const reasoning =
    "Для освещения двора частного дома площадью 120 м² рекомендуется обеспечить освещённость 10–20 лк. " +
    "Световой поток = 120 м² × 15 лк = 1800 лм. Учитывая потери света, оптимально выбрать прожектор " +
    "со световым потоком не менее 2000–2500 лм. Для уличного применения обязательна степень защиты " +
    "не ниже IP65. Можно использовать один мощный прожектор (30–50 Вт) или несколько менее мощных " +
    "(по 20–30 Вт каждый) для равномерного распределения света по площади. " +
    "Это суммарная потребность всей системы: её нужно распределить между несколькими товарами, " +
    "а не требовать от одной карточки.";
  const modelCriteria: Criterion[] = [
    { key: "Степень защиты", op: "eq", value: "IP65", level: "A" },
    {
      key: "Световой поток, Лм",
      op: "min",
      value: 2000,
      unit: "лм",
      level: "A",
    },
    {
      key: "Мощность, Вт",
      op: "range",
      value: [20, 30],
      unit: "Вт",
      level: "A",
    },
  ];
  const scoped = filterPerProductMeasuredCriteria(
    modelCriteria,
    reasoning,
    "Площадь двора 120 м², покажи варианты.",
    "system_total",
  );
  assertEquals(scoped.criteria, [modelCriteria[0]]);
  assertEquals(scoped.removed, [modelCriteria[1], modelCriteria[2]]);

  const facets = [
    {
      key: "flow",
      caption: "Световой поток, Лм",
      type: "number",
      unit: "лм",
      values: [{ value: "1800" }, { value: "2000" }, { value: "2500" }],
    },
    {
      key: "power",
      caption: "Мощность, Вт",
      type: "number",
      unit: "Вт",
      values: [{ value: "20" }, { value: "30" }],
    },
    {
      key: "protection",
      caption: "Степень защиты",
      type: "checkbox",
      unit: null,
      values: [{ value: "IP65" }],
    },
  ];
  const projected = projectReasoningRangeCriteria([], reasoning, facets, {
    measurementScope: "system_total",
  });
  assertEquals(projected.added, []);
  const compiled = compileMeasuredReasoningSearchContract(
    modelCriteria,
    reasoning,
    [],
    facets,
    { measurementScope: "system_total" },
  );
  assertEquals(compiled.mandatory_criteria, [modelCriteria[0]]);
  assertEquals(compiled.options, { protection: ["IP65"] });
});

Deno.test("system-total: a customer's per-item voltage survives an unrelated aggregate lumen target", () => {
  const customer = "Нужно суммарно 5000 лм, каждый светильник на 220 В.";
  const reasoning =
    "Общий поток системы должен быть 5000 лм. Каждый светильник должен работать на 220 В.";
  const total: Criterion = {
    key: "Световой поток, лм",
    op: "min",
    value: 5000,
    unit: "лм",
    level: "A",
    evidence: "user_explicit",
  };
  const voltage: Criterion = {
    key: "Напряжение, В",
    op: "eq",
    value: 220,
    unit: "В",
    level: "A",
    evidence: "user_explicit",
  };
  const scoped = filterPerProductMeasuredCriteria(
    [total, voltage],
    reasoning,
    customer,
    "system_total",
  );
  assertEquals(scoped.criteria, [voltage]);
  assertEquals(scoped.removed, [total]);
  const compiled = compileMeasuredReasoningSearchContract(
    [total, voltage],
    reasoning,
    [total, voltage],
    [
      {
        key: "flow",
        caption: "Световой поток, лм",
        type: "number",
        unit: "лм",
        values: [{ value: "5000" }],
      },
      {
        key: "voltage",
        caption: "Напряжение, В",
        type: "number",
        unit: "В",
        values: [{ value: "220" }],
      },
    ],
    { measurementScope: "system_total", customerText: customer },
  );
  assertEquals(compiled.mandatory_criteria, [voltage]);
  assertEquals(compiled.options, { voltage: ["220"] });
});

Deno.test("system-total: customer supply voltage survives an aggregate output without the word each", () => {
  const customer =
    "Для группы светильников нужен суммарный световой поток 5000 лм и питание от сети 220 В. Покажи варианты.";
  const reasoning =
    "Общий поток системы 5000 лм. Модели должны подключаться к сети 220 В.";
  const total: Criterion = {
    key: "Световой поток, лм",
    op: "min",
    value: 5000,
    unit: "лм",
    level: "A",
    evidence: "user_explicit",
  };
  const voltage: Criterion = {
    key: "Напряжение, В",
    op: "eq",
    value: 220,
    unit: "В",
    level: "A",
    evidence: "user_explicit",
  };
  assertEquals(customerAggregateMeasurementScope(customer), "system_total");
  const scoped = filterPerProductMeasuredCriteria(
    [total, voltage],
    reasoning,
    customer,
    "system_total",
  );
  assertEquals(scoped.criteria, [voltage]);
  assertEquals(scoped.removed, [total]);
  assertEquals(
    applyCriteriaGate([
      product("compatible", ["Световой поток: 1200 лм", "Напряжение: 220 В"]),
      product("wrong-supply", ["Световой поток: 6000 лм", "Напряжение: 110 В"]),
    ], scoped.criteria).passed_ids,
    ["compatible"],
  );
});

Deno.test("system-total: explicit aggregate voltage is not treated as an item supply", () => {
  const customer =
    "Для всей системы нужно суммарное напряжение 220 В и суммарная мощность 5000 Вт.";
  const voltage: Criterion = {
    key: "Напряжение, В",
    op: "eq",
    value: 220,
    unit: "В",
    level: "A",
    evidence: "user_explicit",
  };
  assertEquals(customerAggregateMeasurementScope(customer), "system_total");
  assertEquals(
    filterPerProductMeasuredCriteria(
      [voltage],
      "Напряжение каждого товара 220 В.",
      customer,
      "system_total",
    ).criteria,
    [],
  );
});

Deno.test("system-total: a mains value cannot certify a different voltage role", () => {
  const customer = "Суммарный поток 5000 лм; питание от сети 220 В.";
  const generic: Criterion = {
    key: "Напряжение, В",
    op: "eq",
    value: 220,
    unit: "В",
    level: "A",
  };
  const working: Criterion = {
    ...generic,
    key: "Номинальное рабочее напряжение, В",
  };
  const insulation: Criterion = {
    ...generic,
    key: "Напряжение изоляции, В",
  };
  assertEquals(
    filterPerProductMeasuredCriteria(
      [generic, working, insulation],
      "Подключение к сети 220 В.",
      customer,
      "system_total",
    ).criteria,
    [generic],
  );
  assertEquals(
    filterPerProductMeasuredCriteria(
      [working],
      "Рабочее напряжение 220 В.",
      "Суммарный поток 5000 лм; рабочее напряжение 220 В.",
      "system_total",
    ).criteria,
    [working],
  );
});

Deno.test("system-total: mating dimension is kept, but a referenced cable diameter is not", () => {
  const fit: Criterion = {
    key: "Посадочный диаметр, мм",
    op: "eq",
    value: 90,
    unit: "мм",
    level: "A",
    evidence: "user_explicit",
  };
  const total: Criterion = {
    key: "Световой поток, лм",
    op: "min",
    value: 5000,
    unit: "лм",
    level: "A",
  };
  const customer =
    "Для группы приборов нужен суммарный поток 5000 лм, посадочное отверстие 90 мм.";
  assertEquals(
    filterPerProductMeasuredCriteria(
      [total, fit],
      "Общий поток 5000 лм; монтажное отверстие 90 мм.",
      customer,
      "system_total",
    ).criteria,
    [fit],
  );
  const unrelatedDiameter: Criterion = {
    key: "Диаметр трубки, мм",
    op: "eq",
    value: 12,
    unit: "мм",
    level: "A",
  };
  assertEquals(
    filterPerProductMeasuredCriteria(
      [unrelatedDiameter],
      "Нужна трубка ровно 12 мм.",
      "Кабель диаметром 12 мм; суммарная длина изоляции 20 м.",
      "system_total",
    ).criteria,
    [],
  );
});

Deno.test("system-total: exact independent colour temperature cannot become a lower bound", () => {
  const customer =
    "Для группы нужен суммарный поток 5000 лм; цветовая температура 3000 К.";
  const exact: Criterion = {
    key: "Цветовая температура, К",
    op: "eq",
    value: 3000,
    unit: "К",
    level: "A",
  };
  const broadened: Criterion = { ...exact, op: "min" };
  const scoped = filterPerProductMeasuredCriteria(
    [exact, broadened],
    "Нужна цветовая температура не менее 3000 К.",
    customer,
    "system_total",
  );
  assertEquals(scoped.criteria, [exact]);
  assertEquals(scoped.removed, [broadened]);
  assertEquals(
    applyCriteriaGate([
      product("requested", ["Цветовая температура: 3000 К"]),
      product("wrong-colour", ["Цветовая температура: 6500 К"]),
    ], scoped.criteria).passed_ids,
    ["requested"],
  );
});

Deno.test("system-total: an independent customer range retains only its two correct endpoints", () => {
  const customer =
    "Для системы суммарно 5000 лм; цветовая температура 3000–4000 К.";
  const lower: Criterion = {
    key: "Цветовая температура, К",
    op: "min",
    value: 3000,
    unit: "К",
    level: "A",
  };
  const upper: Criterion = { ...lower, op: "max", value: 4000 };
  const wrongLower: Criterion = { ...lower, value: 4000 };
  const wrongUpper: Criterion = { ...upper, value: 3000 };
  assertEquals(
    filterPerProductMeasuredCriteria(
      [lower, upper, wrongLower, wrongUpper],
      "Требуется диапазон цветовой температуры 3000–4000 К.",
      customer,
      "system_total",
    ).criteria,
    [lower, upper],
  );
});

Deno.test("system-total: postpositive fit and working-on-supply phrases retain independent axes", () => {
  const fit: Criterion = {
    key: "Посадочный диаметр, мм",
    op: "eq",
    value: 90,
    unit: "мм",
    level: "A",
  };
  const supply: Criterion = {
    key: "Напряжение питания, В",
    op: "eq",
    value: 220,
    unit: "В",
    level: "A",
  };
  const customer =
    "Суммарный поток 5000 лм. 90 мм посадочный диаметр. Светильники должны работать на 220 В.";
  assertEquals(
    filterPerProductMeasuredCriteria(
      [fit, supply],
      customer,
      customer,
      "system_total",
    ).criteria,
    [fit, supply],
  );
});

Deno.test("system-total: live facet unit removes a unitless aggregate before contract compilation", () => {
  const total: Criterion = {
    key: "Световой поток",
    op: "min",
    value: 5000,
    level: "A",
  };
  const customer = "Для системы нужен суммарный световой поток 5000 лм.";
  const contract = compileMeasuredReasoningSearchContract(
    [total],
    customer,
    [total],
    [{
      key: "flow",
      caption: "Световой поток",
      type: "number",
      unit: "лм",
      values: [{ value: "5000" }],
    }],
    { measurementScope: "system_total", customerText: customer },
  );
  assertEquals(contract.mandatory_criteria, []);
  assertEquals(contract.options, {});
});

Deno.test("system-total: independent customer input-voltage range projects from reasoning", () => {
  const customer =
    "Для системы суммарный поток 5000 лм; входное напряжение 220–240 В.";
  const reasoning =
    "Суммарный поток 5000 лм. Нужно входное напряжение 220–240 В.";
  const projected = projectReasoningRangeCriteria(
    [],
    reasoning,
    [{
      key: "input_voltage",
      caption: "Входное напряжение, В",
      type: "number",
      unit: "В",
      values: [{ value: "220" }, { value: "230" }, { value: "240" }],
    }],
    { measurementScope: "system_total", customerText: customer },
  );
  assertEquals(projected.added, [{
    key: "Входное напряжение, В",
    op: "range",
    value: [220, 240],
    unit: "В",
    level: "A",
  }]);
});

Deno.test("system-total: customer allocation `по X лм на изделие` keeps the per-item bound only", () => {
  const customer = "Нужно суммарно 5000 лм, по 2000 лм на прожектор.";
  const total: Criterion = {
    key: "Световой поток, лм",
    op: "min",
    value: 5000,
    unit: "лм",
    level: "A",
  };
  const each: Criterion = {
    key: "Световой поток, лм",
    op: "min",
    value: 2000,
    unit: "лм",
    level: "A",
  };
  const scoped = filterPerProductMeasuredCriteria(
    [total, each],
    customer,
    customer,
    "system_total",
  );
  assertEquals(scoped.criteria, [each]);
  assertEquals(scoped.removed, [total]);
});

Deno.test("system-total cannot make an assumed norm mandatory for every item", () => {
  const customer = "Для площади 25 м² подберите несколько светильников.";
  const reasoning =
    "По расчётной норме 160 лк нужно суммарно 4000 лм. Каждый товар должен давать не менее 4000 лм.";
  const assumedEach: Criterion = {
    key: "Световой поток, лм",
    op: "min",
    value: 4000,
    unit: "лм",
    level: "A",
    evidence: "derived_required",
  };
  assertEquals(
    filterPerProductMeasuredCriteria(
      [assumedEach],
      reasoning,
      customer,
      "system_total",
    ).criteria,
    [],
  );
  const explicitEach =
    "Нужно несколько приборов для площади 25 м²: два по 3000 лм каждый.";
  const owned: Criterion = { ...assumedEach, value: 3000 };
  assertEquals(
    filterPerProductMeasuredCriteria(
      [owned],
      "Каждый прибор даёт минимум 3000 лм.",
      explicitEach,
      "system_total",
    ).criteria,
    [owned],
  );
});

Deno.test("system-total: only the exact local `до` or `от` direction may bind each item", () => {
  const min: Criterion = {
    key: "Световой поток, лм",
    op: "min",
    value: 1000,
    unit: "лм",
    level: "A",
  };
  const max: Criterion = { ...min, op: "max" };
  const upTo = "Общий поток минимум 5000 лм и каждый прожектор до 1000 лм.";
  assertEquals(
    filterPerProductMeasuredCriteria([min, max], upTo, "", "system_total")
      .criteria,
    [max],
  );
  const from = "Общий поток максимум 5000 лм и каждый прожектор от 1000 лм.";
  assertEquals(
    filterPerProductMeasuredCriteria([min, max], from, "", "system_total")
      .criteria,
    [min],
  );
  assertEquals(
    filterPerProductMeasuredCriteria(
      [max],
      "Можно использовать каждый прибор до 1000 лм.",
      "",
      "system_total",
    ).criteria,
    [],
  );
});

Deno.test("system-total: a measured numeric criterion without unit field is scoped by its live caption", () => {
  const criterion: Criterion = {
    key: "Световой поток, лм",
    op: "min",
    value: 5000,
    level: "A",
  };
  const scoped = filterPerProductMeasuredCriteria(
    [criterion],
    "Суммарный световой поток должен быть 5000 лм.",
    "",
    "system_total",
  );
  assertEquals(scoped.criteria, []);
  assertEquals(scoped.removed, [criterion]);
});

Deno.test("system-total: a locally required per-item minimum survives an aggregate target", () => {
  const reasoning =
    "Вся система должна дать суммарно 5000 лм. Каждый прибор должен давать не менее 1000 лм.";
  const total: Criterion = {
    key: "Световой поток, лм",
    op: "min",
    value: 5000,
    unit: "лм",
    level: "A",
  };
  const each: Criterion = {
    key: "Световой поток, лм",
    op: "min",
    value: 1000,
    unit: "лм",
    level: "A",
  };
  const scoped = filterPerProductMeasuredCriteria(
    [total, each],
    reasoning,
    "",
    "system_total",
  );
  assertEquals(scoped.criteria, [each]);
  const projected = projectReasoningRangeCriteria(
    [],
    reasoning,
    [{
      key: "flow",
      caption: "Световой поток, лм",
      type: "number",
      unit: "лм",
    }],
    { measurementScope: "system_total" },
  );
  assertEquals(projected.added, [each]);
});

Deno.test("system-total: separate scopes in one sentence remain separate per measurement", () => {
  const reasoning =
    "Суммарно нужно 5000 лм и каждый прибор должен давать не менее 1000 лм.";
  const total: Criterion = {
    key: "Световой поток, лм",
    op: "min",
    value: 5000,
    unit: "лм",
    level: "A",
  };
  const each: Criterion = {
    key: "Световой поток, лм",
    op: "min",
    value: 1000,
    unit: "лм",
    level: "A",
  };
  assertEquals(
    filterPerProductMeasuredCriteria(
      [total, each],
      reasoning,
      "",
      "system_total",
    ).criteria,
    [each],
  );
  const illustrative = filterPerProductMeasuredCriteria(
    [{
      key: "Мощность, Вт",
      op: "range",
      value: [20, 30],
      unit: "Вт",
      level: "A",
    }],
    "Нужно всего 5000 лм и можно поставить несколько изделий по 20–30 Вт каждый.",
    "",
    "system_total",
  );
  assertEquals(illustrative.criteria, []);
});

Deno.test("system-total: a per-item required band cannot justify the wrong endpoint direction", () => {
  const reasoning = "Каждый прибор должен давать 1000–1500 лм.";
  const criterion = (op: "min" | "max", value: number): Criterion => ({
    key: "Световой поток, лм",
    op,
    value,
    unit: "лм",
    level: "A",
  });
  assertEquals(
    filterPerProductMeasuredCriteria(
      [
        criterion("min", 1000),
        criterion("max", 1500),
        criterion("min", 1500),
        criterion("max", 1000),
      ],
      reasoning,
      "",
      "system_total",
    ).criteria,
    [criterion("min", 1000), criterion("max", 1500)],
  );
});

Deno.test("system-total: semicolon-separated total, per-item example and assortment band remain nonbinding", () => {
  const reasoning = "Общий поток ~1800 лм; оптимально не менее 2000–2500 лм; " +
    "по 20–30 Вт каждый; варианты 20–100 Вт.";
  const candidate: Criterion[] = [
    {
      key: "Световой поток, лм",
      op: "min",
      value: 2000,
      unit: "лм",
      level: "A",
    },
    {
      key: "Мощность, Вт",
      op: "range",
      value: [20, 30],
      unit: "Вт",
      level: "A",
    },
    {
      key: "Мощность, Вт",
      op: "range",
      value: [20, 100],
      unit: "Вт",
      level: "A",
    },
  ];
  assertEquals(
    filterPerProductMeasuredCriteria(candidate, reasoning, "", "system_total")
      .criteria,
    [],
  );
  assertEquals(
    projectReasoningRangeCriteria(
      [],
      reasoning,
      [
        {
          key: "flow",
          caption: "Световой поток, лм",
          type: "number",
          unit: "лм",
        },
        { key: "power", caption: "Мощность, Вт", type: "number", unit: "Вт" },
      ],
      { measurementScope: "system_total" },
    ).added,
    [],
  );
});

Deno.test("per-product measurement scope keeps customer-owned 1800 lm requirements unchanged", () => {
  const reasoning = "Для одной позиции нужен световой поток не менее 1800 лм.";
  const customer = "Нужен светильник со световым потоком не менее 1800 лм.";
  const criterion: Criterion = {
    key: "Световой поток, лм",
    op: "min",
    value: 1800,
    unit: "лм",
    level: "A",
  };
  assertEquals(
    filterPerProductMeasuredCriteria(
      [criterion],
      reasoning,
      customer,
      "per_product",
    ).criteria,
    [criterion],
  );
  const projected = projectReasoningRangeCriteria(
    [],
    reasoning,
    [{
      key: "flow",
      caption: "Световой поток, лм",
      type: "number",
      unit: "лм",
    }],
    { measurementScope: "per_product", customerText: customer },
  );
  assertEquals(projected.added, [criterion]);
});

Deno.test("per-product source authority does not hard-filter on a model-invented measured norm", () => {
  const customer = "Подберите светильник в гостиную площадью 25 м2.";
  const reasoning =
    "Для 25 м² расчётная норма 160 лк даёт не менее 4000 лм у светильника.";
  const flow: Criterion = {
    key: "Световой поток, лм",
    op: "min",
    value: 4000,
    unit: "лм",
    level: "A",
    evidence: "derived_required",
  };
  const category: Criterion = {
    key: "Вид исполнения",
    op: "eq",
    value: "Бытовой",
    level: "A",
  };
  const price: Criterion = {
    key: "Цена",
    op: "max",
    value: 5000,
    unit: "₸",
    level: "A",
  };
  const count: Criterion = {
    key: "Количество в упаковке",
    op: "eq",
    value: 2,
    unit: "шт",
    level: "A",
  };
  const facets = [{
    key: "flow",
    caption: "Световой поток, лм",
    type: "number",
    unit: "лм",
    values: [{ value: "3000" }, { value: "4000" }, { value: "5000" }],
  }];
  const filtered = filterPerProductMeasuredCriteria(
    [flow, category, price, count],
    reasoning,
    customer,
    "per_product",
    facets,
  );
  assertEquals(filtered.criteria, [category, price, count]);
  assertEquals(filtered.removed, [flow]);
  for (const untrustedScope of [null, undefined, "not_applicable"]) {
    assertEquals(
      filterPerProductMeasuredCriteria(
        [flow],
        reasoning,
        customer,
        untrustedScope,
        facets,
      ).criteria,
      [],
    );
  }
  const contract = compileMeasuredReasoningSearchContract(
    [flow],
    reasoning,
    [],
    facets,
    { measurementScope: "per_product", customerText: customer },
  );
  assertEquals(contract.projected_criteria, []);
  assertEquals(contract.mandatory_criteria, []);
  assertEquals(contract.options, {});
});

Deno.test("per-product direct customer number requires the same axis and operator", () => {
  const customer = "Нужен светильник со световым потоком не менее 4000 лм.";
  const reasoning = "Световой поток должен быть не менее 4000 лм.";
  const flow: Criterion = {
    key: "Световой поток, лм",
    op: "min",
    value: 4000,
    unit: "лм",
    level: "A",
  };
  const facets = [{
    key: "flow",
    caption: "Световой поток, лм",
    type: "number",
    unit: "лм",
    values: [{ value: "3000" }, { value: "4000" }, { value: "5000" }],
  }];
  assertEquals(
    filterPerProductMeasuredCriteria(
      [flow],
      reasoning,
      customer,
      "per_product",
      facets,
    ).criteria,
    [flow],
  );
  const contract = compileMeasuredReasoningSearchContract(
    [],
    reasoning,
    [],
    facets,
    { measurementScope: "per_product", customerText: customer },
  );
  assertEquals(contract.projected_criteria, [flow]);
  assertEquals(contract.options, { flow: ["4000", "5000"] });
  assertEquals(
    filterPerProductMeasuredCriteria(
      [flow],
      reasoning,
      "Нужен светильник ровно 4000 лм.",
      "per_product",
      facets,
    ).criteria,
    [],
  );
});

Deno.test("per-product exact-facet and existing-item values need customer authority", () => {
  const exact: Criterion = {
    key: "Световой поток, лм",
    op: "eq",
    value: "4000",
    level: "A",
  };
  const minimum: Criterion = { ...exact, op: "min" };
  const length: Criterion = {
    key: "Длина, м",
    op: "eq",
    value: 25,
    unit: "м",
    level: "A",
  };
  const voltage: Criterion = {
    key: "Напряжение, кВ",
    op: "eq",
    value: 25,
    unit: "кВ",
    level: "A",
  };
  const facets = [
    { key: "flow", caption: "Световой поток, лм", unit: "лм" },
    { key: "length", caption: "Длина, м", unit: "м" },
    { key: "voltage", caption: "Напряжение, кВ", unit: "кВ" },
  ];
  assertEquals(
    filterPerProductMeasuredCriteria(
      [exact, length],
      "Выбираю точное значение 4000 лм и длину 25 м.",
      "Комната 25 м2.",
      "per_product",
      facets,
    ).criteria,
    [],
  );
  assertEquals(
    filterPerProductMeasuredCriteria(
      [voltage],
      "Напряжение должно быть 25 кВ.",
      "Комната 25 кв. м.",
      "per_product",
      facets,
    ).criteria,
    [],
  );
  assertEquals(
    filterPerProductMeasuredCriteria(
      [exact],
      "Выбираю точное значение 4000 лм.",
      "Нужен светильник со световым потоком 4000 лм.",
      "per_product",
      facets,
    ).criteria,
    [exact],
  );
  assertEquals(
    filterPerProductMeasuredCriteria(
      [minimum, exact],
      "Выбираю световой поток не менее 4000 лм.",
      "Сейчас стоит светильник 4000 лм. Хочу заменить.",
      "per_product",
      facets,
    ).criteria,
    [],
  );
  assertEquals(
    filterPerProductMeasuredCriteria(
      [{ ...minimum, value: "5000" }],
      "Выбираю световой поток не менее 5000 лм.",
      "Сейчас стоит светильник 4000 лм. Хочу заменить на новый со световым потоком не менее 5000 лм.",
      "per_product",
      facets,
    ).criteria.length,
    1,
  );
  assertEquals(
    filterPerProductMeasuredCriteria(
      [{ ...minimum, value: "5000" }],
      "Для нового светильника нужен поток не менее 5000 лм.",
      "Хочу заменить старый светильник на новый со световым потоком не менее 5000 лм.",
      "per_product",
      facets,
    ).criteria.length,
    1,
  );
});

Deno.test("visible hard measurement extractor uses the same customer authority without exact live values", () => {
  const reasoning =
    "Для гостиной 25 м² световой поток должен быть не менее 4000 лм. Цвет корпуса можно выбрать позже.";
  const facets = [{
    key: "flow",
    caption: "Световой поток, лм",
    unit: "лм",
  }];
  const claims = extractUnownedMeasuredClaims(
    reasoning,
    "Нужен светильник для гостиной 25 м2.",
    facets,
    "per_product",
  );
  assertEquals(claims.length, 1);
  assertEquals(claims[0].text, "не менее 4000 лм");
  assertEquals(reasoning.slice(claims[0].start, claims[0].end), claims[0].text);
  assertEquals(claims[0].criterion.op, "min");
  assertEquals(claims[0].criterion.value, 4000);
  assertEquals(
    extractUnownedMeasuredClaims(
      "Световой поток должен быть 4000 лм.",
      "Нужен светильник для гостиной 25 м2.",
      facets,
      "per_product",
    ).map(({ text, criterion }) => ({ text, op: criterion.op })),
    [{ text: "должен быть 4000 лм", op: "eq" }],
  );
  assertEquals(
    extractUnownedMeasuredClaims(
      "Световой поток должен быть не менее 4000 лм.",
      "Нужен светильник со световым потоком не менее 4000 лм.",
      facets,
      "per_product",
    ),
    [],
  );
  assertEquals(
    extractUnownedMeasuredClaims(
      "Ориентир около 4000 лм, можно уточнить позже.",
      "Нужен светильник для гостиной 25 м2.",
      facets,
      "per_product",
    ),
    [],
  );
  const totalAndItem =
    "Суммарный поток должен быть не менее 4000 лм. Каждый прибор должен давать не менее 4000 лм.";
  assertEquals(
    extractUnownedMeasuredClaims(
      totalAndItem,
      "Для комнаты 25 м2 нужны несколько приборов.",
      facets,
      "system_total",
    ).map(({ text }) => text),
    ["не менее 4000 лм"],
  );
});

Deno.test("source authority keeps customer decimal sections without splitting the comma", () => {
  const facet = {
    key: "section",
    caption: "Сечение кабеля, мм2",
    unit: "мм²",
    values: [{ value: "0.5" }],
  };
  const criterion: Criterion = {
    key: facet.caption,
    op: "eq",
    value: 0.5,
    unit: "мм²",
    level: "A",
  };
  const customer = "Нужно сечение кабеля 0,5 мм²";
  const reasoning = "Требуется сечение кабеля 0,5 мм².";
  assertEquals(
    filterPerProductMeasuredCriteria(
      [criterion],
      reasoning,
      customer,
      "per_product",
      [facet],
    ).criteria,
    [criterion],
  );
  assertEquals(
    extractUnownedMeasuredClaims(reasoning, customer, [facet]),
    [],
  );
});

Deno.test("live capacity relation is not an invented area norm or exact product value", () => {
  const facet = {
    key: "max_area",
    caption: "Максимальная площадь освещения, м²",
    type: "number",
    unit: "м²",
    values: [{ value: "25" }, { value: "30" }, { value: "35" }],
  };
  const minimum: Criterion = {
    key: facet.caption,
    op: "min",
    value: 30,
    unit: "м²",
    level: "A",
  };
  const customer = "Нужен прибор для комнаты площадью 30 м²";
  const reasoning =
    "Максимальная площадь освещения должна быть не менее 30 м², чтобы прибор покрывал помещение.";
  assertEquals(
    filterPerProductMeasuredCriteria(
      [minimum],
      reasoning,
      customer,
      "per_product",
      [facet],
    ).criteria,
    [minimum],
  );
  assertEquals(extractUnownedMeasuredClaims(reasoning, customer, [facet]), []);
  const copiedExact = { ...minimum, op: "eq" as const };
  assertEquals(
    filterPerProductMeasuredCriteria(
      [copiedExact],
      reasoning,
      customer,
      "per_product",
      [facet],
    ).criteria,
    [],
  );
  const unrelatedFacet = {
    ...facet,
    key: "pack_area",
    caption: "Максимальная площадь упаковки, м²",
  };
  const unrelatedReasoning =
    "Максимальная площадь упаковки должна быть не менее 30 м².";
  assertEquals(
    filterPerProductMeasuredCriteria(
      [{ ...minimum, key: unrelatedFacet.caption }],
      unrelatedReasoning,
      customer,
      "per_product",
      [unrelatedFacet],
    ).criteria,
    [],
  );
});

Deno.test("customer site area certifies one live service capacity without model fit prose", () => {
  const customer =
    "хочу поменять дома люстру в зале 30 квадратов. Что предложишь из современного?";
  const facet = {
    key: "maksimalynaya_ploschady_osvescheniya__m2",
    caption: "Максимальная площадь освещения, м2",
    type: "string",
    unit: null,
    values: [{ value: "25" }, { value: "30" }, { value: "35" }],
  };
  const projected = projectLiteralMeasuredCriteria(
    [],
    customer,
    customer,
    [facet],
  );
  assertEquals(projected.added, [{
    key: facet.caption,
    op: "min",
    value: "30",
    unit: "м²",
    level: "A",
  }]);
  const scoped = filterPerProductMeasuredCriteria(
    projected.added.map((criterion) => ({
      ...criterion,
      evidence: "user_explicit" as const,
    })),
    "",
    customer,
    "per_product",
    [facet],
  );
  assertEquals(scoped.criteria.length, 1);
  assertEquals(scoped.removed, []);
  const mixedRequest = "Зал 30 квадратов, кабель для подсветки 5 м";
  assertEquals(filterPerProductMeasuredCriteria(
    projected.added,
    "",
    mixedRequest,
    "per_product",
    [facet],
  ).criteria, projected.added);
  const withIndependentVoltage = `${customer} Требуется напряжение 220 В.`;
  assertEquals(
    filterPerProductMeasuredCriteria(
      projected.added,
      "",
      withIndependentVoltage,
      "per_product",
      [facet, {
        key: "voltage",
        caption: "Напряжение, В",
        type: "number",
        unit: "В",
        values: [{ value: "220" }],
      }],
    ).criteria,
    projected.added,
  );
  assertEquals(
    projectCriteriaFacetOptions(scoped.criteria, [facet]).options,
    { [facet.key]: ["30", "35"] },
  );
  assertEquals(
    applyCriteriaGate([
      product("too-small", [`${facet.caption}: 25`]),
      product("fits", [`${facet.caption}: 30`]),
      product("more-capacity", [`${facet.caption}: 35`]),
      product("unproved", []),
    ], scoped.criteria).passed_ids,
    ["fits", "more-capacity"],
  );
});

Deno.test("customer minimum for a product's service capacity stays directional across reasoning, facets and cards", () => {
  const facet = {
    key: "coverage_area",
    caption: "Максимальная площадь освещения, м²",
    type: "number",
    unit: "м²",
    values: [{ value: "25" }, { value: "50" }, { value: "75" }],
  };
  const customer = "Покажи другие приборы с площадью освещения не менее 50 м²";
  const reasoning =
    "Рекомендуется прибор с максимальной площадью освещения 50 м².";
  const projected = projectLiteralMeasuredCriteria(
    [],
    customer,
    reasoning,
    [facet],
  );
  assertEquals(projected.added, [{
    key: facet.caption,
    op: "min",
    value: "50",
    unit: "м²",
    level: "A",
  }]);
  assertEquals(projected.matched, projected.added);
  assertEquals(
    projectLiteralMeasuredCriteria(
      [{
        key: facet.caption,
        op: "eq",
        value: "50",
        unit: "м²",
        level: "A",
      }],
      customer,
      reasoning,
      [facet],
    ).criteria,
    projected.added,
  );
  const scoped = filterPerProductMeasuredCriteria(
    projected.added,
    reasoning,
    customer,
    "per_product",
    [facet],
  );
  assertEquals(scoped.criteria, projected.added);
  const contract = compileMeasuredReasoningSearchContract(
    [],
    reasoning,
    [],
    [facet],
    {
      measurementScope: "per_product",
      customerText: customer,
    },
  );
  assertEquals(contract.mandatory_criteria, projected.added);
  assertEquals(contract.options, { coverage_area: ["50", "75"] });
  const frozen = projected.added.map((criterion) => ({
    ...criterion,
    evidence: "user_explicit" as const,
  }));
  assertEquals(
    certifiedCustomerApplicationCapacityOptions(
      frozen,
      customer,
      [facet],
    ),
    { coverage_area: ["50", "75"] },
  );
  assertEquals(
    applyCriteriaGate([
      product("too-small", [`${facet.caption}: 25`]),
      product("fits", [`${facet.caption}: 50`]),
      product("more-capacity", [`${facet.caption}: 75`]),
      product("unproved", []),
    ], scoped.criteria).passed_ids,
    ["fits", "more-capacity"],
  );
  // The consultant's exact recommendation cannot turn the customer's
  // inclusive minimum into an equality that drops higher-capacity choices.
  assertEquals(
    filterPerProductMeasuredCriteria(
      [{
        ...projected.added[0],
        op: "eq",
      }],
      reasoning,
      customer,
      "per_product",
      [facet],
    ).criteria,
    [],
  );
});

Deno.test("a direct service minimum needs customer direction, matching axis/unit and one verified live facet", () => {
  const facet = {
    key: "lighting_capacity",
    caption: "Максимальная площадь освещения, м²",
    type: "number",
    unit: "м²",
    values: [{ value: "25" }, { value: "50" }, { value: "75" }],
  };
  const projected = (customer: string, facets = [facet], reasoning = customer) =>
    projectLiteralMeasuredCriteria([], customer, reasoning, facets).added;
  for (
    const customer of [
      "Для комнаты площадью не менее 50 м² нужны приборы",
      "Покажи приборы с площадью освещения не более 50 м²",
      "Покажи приборы с площадью освещения больше 50 м²",
      "Покажи приборы с площадью обогрева не менее 50 м²",
      "Покажи приборы с площадью освещения не менее 50 м³",
    ]
  ) {
    assertEquals(projected(customer), [], customer);
    assertEquals(projected(customer, [facet], "Рекомендую вариант 50 м²."), [], customer);
  }
  assertEquals(
    projected(
      "Покажи приборы с площадью освещения не менее 50 м²",
      [{ ...facet, caption: "Максимальная площадь упаковки, м²" }],
    ),
    [],
  );
  assertEquals(
    projected(
      "Покажи приборы с площадью освещения не менее 50 м²",
      [{ ...facet, values: [{ value: "25" }] }],
    ),
    [],
  );
  assertEquals(
    projected(
      "Покажи приборы с площадью освещения не менее 50 м²",
      [facet, { ...facet, key: "second_lighting_capacity" }],
    ),
    [],
  );
});

Deno.test("direct minimum service capacity applies to another live service axis and ASCII area units", () => {
  const facet = {
    key: "heating_area",
    caption: "Максимальная площадь обогрева, м2",
    type: "number",
    unit: null,
    values: [{ value: "25" }, { value: "35" }, { value: "45" }],
  };
  const customer = "Подбери обогреватели с площадью обогрева не менее 30 м2";
  const projected = projectLiteralMeasuredCriteria(
    [], customer, customer, [facet],
  );
  assertEquals(projected.added, [{
    key: facet.caption,
    op: "min",
    value: "30",
    unit: "м²",
    level: "A",
  }]);
  assertEquals(projectCriteriaFacetOptions(projected.added, [facet]).options, {
    heating_area: ["35", "45"],
  });
});

Deno.test("capacity certificate rejects unrelated, ambiguous and unproved facets", () => {
  const customer = "Нужен прибор для комнаты площадью 30 м²";
  const facet = {
    key: "max_area",
    caption: "Максимальная площадь освещения, м²",
    type: "string",
    unit: "м²",
    values: [{ value: "25" }, { value: "30" }, { value: "35" }],
  };
  const criterion: Criterion = {
    key: facet.caption,
    op: "min",
    value: 30,
    unit: "м²",
    level: "A",
  };
  const accepted = (
    subject: Criterion,
    facets: typeof facet[],
    text = customer,
    scope = "per_product",
    reasoning = "",
  ) =>
    filterPerProductMeasuredCriteria(
      [subject],
      reasoning,
      text,
      scope,
      facets,
    ).criteria;
  assertEquals(
    accepted({ ...criterion, key: "Максимальная площадь упаковки, м²" }, [{
      ...facet,
      key: "pack_area",
      caption: "Максимальная площадь упаковки, м²",
    }], customer, "per_product", "Упаковка покрывает площадь 30 м²."),
    [],
  );
  assertEquals(
    accepted({ ...criterion, key: "Максимальная площадь обогрева, м²" }, [
      facet,
      {
        ...facet,
        key: "heat_area",
        caption: "Максимальная площадь обогрева, м²",
      },
    ]),
    [],
  );
  assertEquals(
    accepted(criterion, [{
      ...facet,
      values: [{ value: "25" }],
    }]),
    [],
  );
  assertEquals(accepted({ ...criterion, op: "eq" }, [facet]), []);
  assertEquals(accepted({ ...criterion, op: "max" }, [facet]), []);
  assertEquals(
    accepted(criterion, [facet], "Нужна упаковка площадью 30 м²"),
    [],
  );
  assertEquals(accepted(criterion, [facet], "Нужен прибор площадью 30 м²"), []);
  assertEquals(accepted(criterion, [facet], customer, "system_total"), []);
  assertEquals(accepted(
    criterion,
    [facet],
    "Нужен прибор площадью 30 м²",
    "per_product",
    "Изделие подходит для этой площади и покрывает её.",
  ), [criterion]);
  assertEquals(
    accepted({
      key: "Световой поток, лм",
      op: "min",
      value: 4500,
      unit: "лм",
      level: "A",
    }, [{
      ...facet,
      key: "flow",
      caption: "Световой поток, лм",
      unit: "лм",
      values: [{ value: "4500" }],
    }]),
    [],
  );
});

Deno.test("non-enumerated customer area projects a live service-capacity threshold", () => {
  const facet = {
    key: "max_area",
    caption: "Максимальная площадь освещения, м²",
    type: "number",
    unit: "м²",
    values: [{ value: "25" }, { value: "30" }, { value: "35" }],
  };
  const customer = "Нужен светильник для комнаты 27 м²";
  const projected = projectLiteralMeasuredCriteria([], customer, customer, [facet]);
  assertEquals(projected.added, [{
    key: facet.caption,
    op: "min",
    value: "27",
    unit: "м²",
    level: "A",
  }]);
  // The real discovery branch counts `matched`, then scopes it, to decide
  // whether another model measurement must be invented before searching.
  assertEquals(projected.matched, projected.added);
  const scoped = filterPerProductMeasuredCriteria(
    projected.matched,
    "",
    customer,
    "per_product",
    [facet],
  );
  assertEquals(scoped.criteria, projected.added);
  assertEquals(projectCriteriaFacetOptions(scoped.criteria, [facet]).options, {
    max_area: ["30", "35"],
  });
  assertEquals(applyCriteriaGate([
    product("too-small", [`${facet.caption}: 25`]),
    product("fits", [`${facet.caption}: 30`]),
    product("more-capacity", [`${facet.caption}: 35`]),
    product("unknown", []),
  ], scoped.criteria).passed_ids, ["fits", "more-capacity"]);

  const noSufficientValues = { ...facet, values: [{ value: "20" }, { value: "25" }] };
  assertEquals(projectLiteralMeasuredCriteria(
    [], customer, customer, [noSufficientValues],
  ).added, []);
  const packaging = { ...facet, key: "package", caption: "Максимальная площадь упаковки, м²" };
  assertEquals(projectLiteralMeasuredCriteria(
    [], customer, customer, [packaging],
  ).added, []);
  const secondCapacity = { ...facet, key: "heat", caption: "Максимальная площадь обогрева, м²" };
  assertEquals(projectLiteralMeasuredCriteria(
    [], customer, customer, [facet, secondCapacity],
  ).added, []);
  assertEquals(projectLiteralMeasuredCriteria(
    [], customer, customer, [facet, {
      ...secondCapacity,
      values: [{ value: "20" }, { value: "25" }],
    }],
  ).added, []);
  const exactProductValue =
    "Для комнаты нужна максимальная площадь освещения товара ровно 27 м²";
  assertEquals(projectLiteralMeasuredCriteria(
    [], exactProductValue, exactProductValue, [facet],
  ).added, []);
  assertEquals(projectLiteralMeasuredCriteria(
    [], "Кабель сечением 27 мм²", "Кабель сечением 27 мм²", [facet],
  ).added, []);
  assertEquals(filterPerProductMeasuredCriteria(
    projected.matched, "", customer, "system_total", [facet],
  ).criteria, []);
});

Deno.test("capacity option certificate carries only frozen customer thresholds, never model equalities", () => {
  const facet = {
    key: "max_area",
    caption: "Максимальная площадь освещения, м²",
    type: "number",
    unit: "м²",
    values: [{ value: "25" }, { value: "30" }, { value: "35" }],
  };
  const customer = "Хочу светильник для комнаты 27 м²";
  const projected = projectLiteralMeasuredCriteria(
    [], customer, customer, [facet],
  ).matched;
  const frozen = filterPerProductMeasuredCriteria(
    projected.map((criterion) => ({
      ...criterion,
      evidence: "user_explicit" as const,
    })),
    customer,
    customer,
    "per_product",
    [facet],
  ).criteria;
  assertEquals(certifiedCustomerApplicationCapacityOptions(
    frozen, customer, [facet],
  ), { max_area: ["30", "35"] });
  assertEquals(certifiedCustomerApplicationCapacityOptions(
    [], customer, [facet],
  ), {});
  assertEquals(certifiedCustomerApplicationCapacityOptions(
    [{ ...frozen[0], evidence: "model_assumption" }], customer, [facet],
  ), {});
  assertEquals(certifiedCustomerApplicationCapacityOptions(
    [{ ...frozen[0], op: "eq", value: "35" }], customer, [facet],
  ), {});
  assertEquals(certifiedCustomerApplicationCapacityOptions(
    frozen, "Нужен светильник площадью 27 м²", [facet],
  ), {});
  assertEquals(certifiedCustomerApplicationCapacityOptions(
    frozen, customer, [{
      ...facet,
      key: "package_area",
      caption: "Максимальная площадь упаковки, м²",
    }],
  ), {});
  assertEquals(certifiedCustomerApplicationCapacityOptions(
    [{ ...frozen[0], key: "Минимальная площадь обслуживания, м²", op: "max" }],
    customer,
    [{
      ...facet,
      key: "minimum_area",
      caption: "Минимальная площадь обслуживания, м²",
      values: [{ value: "20" }, { value: "25" }],
    }],
  ), {});
  assertEquals(preserveCertifiedCustomerCapacityOptions(
    frozen,
    customer,
    [facet],
    { max_area: ["25", "30", "35", "45"] },
    {},
  ), { max_area: ["30", "35"] });
  const exactProductCustomer =
    "Хочу светильник для комнаты 27 м², максимальная площадь освещения товара ровно 30 м²";
  const exactProductCriteria: Criterion[] = [
    frozen[0],
    {
      key: facet.caption,
      op: "eq",
      value: "30",
      unit: "м²",
      level: "A",
      evidence: "user_explicit",
    },
  ];
  assertEquals(certifiedCustomerApplicationCapacityOptions(
    exactProductCriteria, exactProductCustomer, [facet],
  ), { max_area: ["30"] });
  assertEquals(preserveCertifiedCustomerCapacityOptions(
    exactProductCriteria,
    exactProductCustomer,
    [facet],
    { max_area: ["30", "35"] },
    { max_area: ["30"] },
  ), { max_area: ["30"] });
});

Deno.test("minimum service area is not auto-certified as an upper coverage bound", () => {
  const facet = {
    key: "min_area",
    caption: "Минимальная площадь обслуживания, м²",
    type: "number",
    unit: "м²",
    values: [{ value: "20" }, { value: "25" }],
  };
  const customer = "Нужен прибор для комнаты 27 м²";
  assertEquals(projectLiteralMeasuredCriteria(
    [], customer, customer, [facet],
  ).added, []);
  assertEquals(filterPerProductMeasuredCriteria([{
    key: facet.caption,
    op: "max",
    value: "27",
    unit: "м²",
    level: "A",
    evidence: "user_explicit",
  }], "", customer, "per_product", [facet]).criteria, []);
  const exactMinimum = { ...facet, values: [{ value: "27" }] };
  assertEquals(projectLiteralMeasuredCriteria(
    [], customer, customer, [exactMinimum],
  ).added[0]?.op, "max");
  assertEquals(filterPerProductMeasuredCriteria([{
    key: exactMinimum.caption,
    op: "max",
    value: "27",
    unit: "м²",
    level: "A",
    evidence: "user_explicit",
  }], "", customer, "per_product", [exactMinimum]).criteria, []);
});

Deno.test("one catalog service capacity also certifies a non-lighting application", () => {
  const facet = {
    key: "heating_area",
    caption: "Максимальная площадь обогрева, м²",
    type: "number",
    unit: "м²",
    values: [{ value: "25" }, { value: "30" }, { value: "40" }],
  };
  const projected = projectLiteralMeasuredCriteria(
    [],
    "Обогреватель для офиса 30 м²",
    "Обогреватель для офиса 30 м²",
    [facet],
  );
  assertEquals(
    filterPerProductMeasuredCriteria(
      projected.added,
      "Обогреватель для офиса 30 м²",
      "Обогреватель для офиса 30 м²",
      "per_product",
      [facet],
    ).criteria,
    projected.added,
  );
});

Deno.test("explicit exact live capacity stays customer-owned", () => {
  const facet = {
    key: "max_area",
    caption: "Максимальная площадь освещения, м²",
    type: "number",
    unit: "м²",
    values: [{ value: "25" }, { value: "30" }, { value: "35" }],
  };
  const exact: Criterion = {
    key: facet.caption,
    op: "eq",
    value: 30,
    unit: "м²",
    level: "A",
  };
  const customer = "Нужна максимальная площадь освещения товара ровно 30 м²";
  const reasoning = "Максимальная площадь освещения изделия ровно 30 м².";
  assertEquals(
    filterPerProductMeasuredCriteria(
      [exact],
      reasoning,
      customer,
      "per_product",
      [facet],
    ).criteria,
    [exact],
  );
  assertEquals(extractUnownedMeasuredClaims(reasoning, customer, [facet]), []);
});

Deno.test("modal measured claim respects a customer floor without authorizing equality filtering", () => {
  const facets = [{
    key: "flow",
    caption: "Световой поток",
    unit: null,
    values: [{ value: "5250 Лм" }, { value: "7000 Лм" }],
  }];
  const reasoning = "Световой поток должен быть 7000 лм.";
  assertEquals(
    extractUnownedMeasuredClaims(
      reasoning,
      "Нужен световой поток не менее 7000 лм.",
      facets,
    ),
    [],
  );
  assertEquals(
    filterPerProductMeasuredCriteria(
      [{
        key: "Световой поток",
        op: "eq",
        value: 7000,
        unit: "лм",
        level: "A",
      }],
      reasoning,
      "Нужен световой поток не менее 7000 лм.",
      "per_product",
      facets,
    ).criteria,
    [],
  );
  assertEquals(
    extractUnownedMeasuredClaims(
      reasoning,
      "Сейчас стоит светильник 7000 лм. Хочу заменить.",
      facets,
    ).length,
    1,
  );
});

Deno.test("full-word lumen aliases cannot leave a rejected model-only threshold visible", () => {
  const facet = {
    key: "flow",
    caption: "Световой поток",
    unit: null,
    values: [{ value: "4000 лм" }, { value: "5000 лм" }],
  };
  const criterion: Criterion = {
    key: facet.caption,
    op: "min",
    value: 4000,
    level: "A",
  };
  const reasoning = "Световой поток должен быть не менее 4000 люменов.";
  const customer = "Нужен светильник для комнаты 25 м².";
  assertEquals(
    filterPerProductMeasuredCriteria(
      [criterion],
      reasoning,
      customer,
      "per_product",
      [facet],
    ).criteria,
    [],
  );
  const claims = extractUnownedMeasuredClaims(reasoning, customer, [facet]);
  assertEquals(claims.map((claim) => claim.text), ["не менее 4000 люменов"]);
  assertEquals(claims[0].criterion.unit, "лм");
  assertEquals(
    extractUnownedMeasuredClaims(reasoning, "Нужно не менее 4000 лм.", [facet]),
    [],
  );
  assertEquals(
    extractUnownedMeasuredClaims(reasoning, customer).map((claim) =>
      claim.text
    ),
    ["не менее 4000 люменов"],
  );
});

Deno.test("only a complete certified paired fit survives the scalar authority gate", () => {
  const customer = "Подбери трубку ТТУ на кабель диаметром 10 мм.";
  const reasoning =
    "Для кабеля 10 мм внутренний диаметр до усадки должен быть строго больше 10 мм, а после усадки строго меньше 10 мм.";
  const before: Criterion = {
    key: "Диаметр до усадки, мм",
    op: "min",
    value: 10,
    unit: "мм",
    exclusive: true,
    level: "A",
    evidence: "derived_required",
  };
  const after: Criterion = {
    key: "Диаметр после усадки, мм",
    op: "max",
    value: 10,
    unit: "мм",
    exclusive: true,
    level: "A",
    evidence: "derived_required",
  };
  const inventedFlow: Criterion = {
    key: "Световой поток, лм",
    op: "min",
    value: 4000,
    unit: "лм",
    level: "A",
    evidence: "derived_required",
  };
  const facets = [
    {
      key: "before",
      caption: before.key,
      unit: "мм",
      values: [{ value: "12" }, { value: "14" }],
    },
    {
      key: "after",
      caption: after.key,
      unit: "мм",
      values: [{ value: "6" }, { value: "7" }],
    },
    {
      key: "flow",
      caption: inventedFlow.key,
      unit: "лм",
      values: [{ value: "4000" }, { value: "5000" }],
    },
  ];
  const withoutCertification = filterPerProductMeasuredCriteria(
    [before, after],
    reasoning,
    customer,
    "per_product",
    facets,
  );
  assertEquals(withoutCertification.criteria, []);
  const certified = filterPerProductMeasuredCriteria(
    [before, after, inventedFlow],
    `${reasoning} Световой поток должен быть не менее 4000 лм.`,
    customer,
    "per_product",
    facets,
    [before, after],
  );
  assertEquals(certified.criteria, [before, after]);
  assertEquals(certified.removed, [inventedFlow]);
  assertEquals(
    filterPerProductMeasuredCriteria(
      [before, after],
      reasoning,
      customer,
      "per_product",
      facets,
      [before],
    ).criteria,
    [],
  );
  assertEquals(
    filterPerProductMeasuredCriteria(
      [before, after],
      reasoning,
      customer,
      "per_product",
      facets,
      [{ ...before, exclusive: false }, after],
    ).criteria,
    [],
  );
  assertEquals(
    filterPerProductMeasuredCriteria(
      [{ ...before, evidence: "model_assumption" }, after],
      reasoning,
      customer,
      "per_product",
      facets,
      [before, after],
    ).criteria,
    [after],
  );
  const totalScope = filterPerProductMeasuredCriteria(
    [before, after],
    reasoning,
    customer,
    "system_total",
    facets,
    [before, after],
  );
  assertEquals(totalScope.criteria, filterPerProductMeasuredCriteria(
    [before, after],
    reasoning,
    customer,
    "system_total",
    facets,
  ).criteria);
});

Deno.test("TTU selection contract retains certified fit bounds only after the 20% clearance is proven", () => {
  const customer = "Подбери трубку ТТУ для кабеля диаметром 10 мм.";
  const reasoning =
    "До изменения внутренний диаметр должен быть не менее 12 мм, а после изменения внутренний диаметр должен быть строго меньше 10 мм.";
  const facets = [
    {
      key: "diameter_before",
      caption: "Внутренний диаметр до изменения, мм",
      unit: "мм",
      values: [{ value: "12" }, { value: "16" }],
    },
    {
      key: "diameter_after",
      caption: "Внутренний диаметр после изменения, мм",
      unit: "мм",
      values: [{ value: "6" }, { value: "8" }],
    },
  ];
  const decision = terminalPairedFitDecision(
    { value: 10, unit: "мм" },
    customer,
    reasoning,
    facets,
    "Трубки термоусаживаемые",
  );
  assertEquals(decision.state, "required");
  assertEquals(decision.selected_pair?.before_facet_key, facets[0].key);
  assertEquals(decision.selected_pair?.after_facet_key, facets[1].key);
  const compatibilityCriteria = compatibilityRelationsToCriteria(
    decision.relations,
    decision.clearance,
  ).map((criterion) => ({
    ...criterion,
    evidence: "derived_required" as const,
  }));
  const copiedObjectMeasurements: Criterion[] = facets.map((facet) => ({
    key: facet.caption,
    op: "eq",
    value: 10,
    unit: "мм",
    level: "A",
    evidence: "user_explicit",
  }));
  const evidenceCriteria = subsumePairedStateCriteria(
    subsumeCriteriaProvenByCompatibility(
      copiedObjectMeasurements,
      decision.relations,
    ),
  );
  assertEquals(evidenceCriteria, []);
  const merged = mergeMandatorySelectionCriteria([
    ...evidenceCriteria,
    ...compatibilityCriteria,
  ]);
  const emitted = filterPerProductMeasuredCriteria(
    merged,
    reasoning,
    customer,
    "per_product",
    facets,
    compatibilityCriteria,
  ).criteria;
  assertEquals(emitted, [
    {
      key: facets[0].key,
      op: "min",
      value: 12,
      unit: "мм",
      level: "A",
      evidence: "derived_required",
    },
    {
      key: facets[1].key,
      op: "max",
      value: 10,
      unit: "мм",
      level: "A",
      exclusive: true,
      evidence: "derived_required",
    },
  ]);
  assertEquals(filterPerProductMeasuredCriteria(
    merged,
    reasoning,
    customer,
    "per_product",
    facets,
    [],
  ).criteria, []);

  // The same model-provided pair is not authoritative when the request owns
  // two different reference sizes. There is no certified relation to pass.
  const ambiguousCustomer =
    "Подбери трубку ТТУ для кабеля диаметром 10 мм и для кабеля диаметром 12 мм.";
  const ambiguousReference = extractSchemaBackedMeasuredReference(
    ambiguousCustomer,
    facets,
    "Трубки термоусаживаемые",
  );
  assertEquals(ambiguousReference, null);
  const ambiguous = terminalPairedFitDecision(
    ambiguousReference,
    ambiguousCustomer,
    reasoning,
    facets,
    "Трубки термоусаживаемые",
  );
  assertEquals(ambiguous.state, "unproven");
  const ambiguousCertified = compatibilityRelationsToCriteria(
    ambiguous.relations,
  ).map((criterion) => ({
    ...criterion,
    evidence: "derived_required" as const,
  }));
  assertEquals(
    filterPerProductMeasuredCriteria(
      mergeMandatorySelectionCriteria(compatibilityCriteria),
      reasoning,
      ambiguousCustomer,
      "per_product",
      facets,
      ambiguousCertified,
    ).criteria,
    [],
  );
});

Deno.test("12 mm cable's certified 14.4 mm boundary survives into selection metadata", () => {
  const customer = "Подбери термоусадочную трубку на кабель диаметром 12 мм.";
  const reasoning = "До усадки внутренний диаметр должен быть не менее 14,4 мм, а после усадки внутренний диаметр должен быть строго меньше 12 мм.";
  const facets = [
    { key: "diameter_before", caption: "Внутренний диаметр до усадки, мм", unit: "мм", values: [{ value: "14" }, { value: "14,4" }, { value: "16" }] },
    { key: "diameter_after", caption: "Внутренний диаметр после усадки, мм", unit: "мм", values: [{ value: "7" }, { value: "8" }] },
  ];
  const decision = terminalPairedFitDecision(
    { value: 12, unit: "мм" }, customer, reasoning, facets,
    "Трубки термоусаживаемые",
  );
  assertEquals(decision.state, "required");
  const certified = compatibilityRelationsToCriteria(
    decision.relations,
    decision.clearance,
  ).map((criterion) => ({ ...criterion, evidence: "derived_required" as const }));
  const metadata = filterPerProductMeasuredCriteria(
    mergeMandatorySelectionCriteria(certified),
    reasoning,
    customer,
    "per_product",
    facets,
    certified,
  ).criteria;
  assertEquals(metadata, [
    { key: facets[0].key, op: "min", value: 14.4, unit: "мм", level: "A", evidence: "derived_required" },
    { key: facets[1].key, op: "max", value: 12, unit: "мм", level: "A", exclusive: true, evidence: "derived_required" },
  ]);
  assertEquals(filterPerProductMeasuredCriteria(
    metadata, reasoning, customer, "per_product", facets, [],
  ).criteria, []);
});

Deno.test("full-word kilowatt and length aliases are exact unit tokens", () => {
  const power = [{
    key: "power",
    caption: "Мощность",
    unit: "кВт",
    values: [{ value: "5" }, { value: "7" }],
  }];
  const reasoning = "Мощность должна быть не менее 5 киловаттов.";
  assertEquals(
    extractUnownedMeasuredClaims(reasoning, "Нужен прибор.", power)
      .map((claim) => [claim.text, claim.criterion.unit]),
    [["не менее 5 киловаттов", "квт"]],
  );
  assertEquals(
    extractUnownedMeasuredClaims(
      reasoning,
      "Нужна мощность не менее 5 кВт.",
      power,
    ),
    [],
  );
  assertEquals(
    extractUnownedMeasuredClaims(
      "Длина должна быть не менее 10 миллиметров.",
      "Нужно соединение.",
    ).map((claim) => claim.criterion.unit),
    ["мм"],
  );
  assertEquals(
    extractUnownedMeasuredClaims(
      "Требуется не менее 4000 люменовидных элементов.",
      "Нужен светильник.",
    ),
    [],
  );
});

Deno.test("словесная составная единица не конфликтует с производным диапазоном", () => {
  const projected = projectReasoningRangeCriteria(
    [],
    "Для комнаты нужен поток 3750–5000 лм (из расчёта 150–200 лм на м²).",
    [
      { key: "flow", caption: "Световой поток", type: "number", unit: "лм" },
      { key: "power", caption: "Мощность", type: "number", unit: "Вт" },
    ],
  );
  assertEquals(projected.added, [
    {
      key: "Световой поток",
      op: "range",
      value: [3750, 5000],
      unit: "лм",
      level: "A",
    },
  ]);
});

Deno.test("дефисы артикула не превращаются в диапазон измеримого фасета", () => {
  const projected = projectReasoningRangeCriteria(
    [],
    "ДКУ-LED-03-100W — исходная модель; подбираю замену.",
    [{
      key: "power",
      caption: "Мощность ламп, Вт",
      type: "number",
      unit: "Вт",
      values: [{ value: "3" }, { value: "100" }],
    }],
  );
  assertEquals(projected.added, []);
});

Deno.test("ключевые параметры замены обязательны, вероятная характеристика остаётся рекомендацией", () => {
  const aligned = alignCriteriaImportanceWithReasoning(
    [
      { key: "Количество полюсов", op: "eq", value: "1", level: "A" },
      { key: "Номинальный ток", op: "eq", value: "16", level: "A" },
      { key: "Характеристика", op: "eq", value: "C", level: "A" },
    ],
    "1-полюсный скорее всего. Ключевые параметры: номинальный ток 16 А, характеристика C.",
  );
  assertEquals(
    aligned.criteria.map((criterion) => [criterion.key, criterion.level]),
    [
      ["Количество полюсов", "B"],
      ["Номинальный ток", "A"],
      ["Характеристика", "A"],
    ],
  );
});

Deno.test("явно заявленная пригодность для применения остаётся обязательной", () => {
  const aligned = alignCriteriaImportanceWithReasoning(
    [
      { key: "Способ монтажа", op: "eq", value: "потолочный", level: "A" },
      { key: "Цвет", op: "eq", value: "белый", level: "A" },
    ],
    "Модель должна подходить для потолочного монтажа. Белый цвет — по желанию.",
  );
  assertEquals(
    aligned.criteria.map((criterion) => [criterion.key, criterion.level]),
    [
      ["Способ монтажа", "A"],
      ["Цвет", "B"],
    ],
  );
});

Deno.test("русский диапазон от X до Y проецируется так же, как запись через тире", () => {
  const projected = projectReasoningRangeCriteria(
    [],
    "нужно от 3500 до 5000 люмен",
    [
      { key: "flow", caption: "Поток", type: "number", unit: "лм" },
    ],
  );
  assertEquals(projected.added, [{
    key: "Поток",
    op: "range",
    value: [3500, 5000],
    unit: "лм",
    level: "A",
  }]);
});

Deno.test("явная производная нижняя граница проецируется без выдуманного максимума", () => {
  const projected = projectReasoningRangeCriteria(
    [],
    "Нужен световой поток не менее 3750 лм; около 5000 лм — лишь комфортный ориентир.",
    [
      { key: "flow", caption: "Световой поток", type: "number", unit: "лм" },
      { key: "power", caption: "Мощность", type: "number", unit: "Вт" },
    ],
  );
  assertEquals(projected.added, [
    { key: "Световой поток", op: "min", value: 3750, unit: "лм", level: "A" },
  ]);
});

Deno.test("явная нижняя граница побеждает комфортный диапазон с тем же началом", () => {
  const projected = projectReasoningRangeCriteria(
    [],
    "Расчётный ориентир — 3750–5000 лм. Светильник должен обеспечивать не менее 3750 лм; 5000 лм — комфортный уровень.",
    [{ key: "flow", caption: "Световой поток", type: "number", unit: "лм" }],
  );
  assertEquals(projected.added, [
    { key: "Световой поток", op: "min", value: 3750, unit: "лм", level: "A" },
  ]);
});

Deno.test("направление перед диапазоном не превращает верхний ориентир в запрет", () => {
  const projected = projectReasoningRangeCriteria(
    [],
    "Сечение жилы должно быть не менее 0,5–0,75 мм² для предотвращения падения напряжения.",
    [{
      key: "section",
      caption: "Сечение кабеля, мм2",
      type: "number",
      unit: "мм²",
    }],
  );
  assertEquals(projected.added, [
    {
      key: "Сечение кабеля, мм2",
      op: "min",
      value: 0.5,
      unit: "мм²",
      level: "A",
    },
  ]);
});

Deno.test("локальный оптимальный максимум не закрывает явно односторонний минимум", () => {
  const projected = projectReasoningRangeCriteria(
    [],
    "Световой поток = 25 м² × 150 лк = 3750 лм (минимум), оптимально до 5000 лм. Светильник должен обеспечивать не менее 3750 лм.",
    [{ key: "flow", caption: "Световой поток", type: "number", unit: "лм" }],
  );
  assertEquals(projected.added, [
    { key: "Световой поток", op: "min", value: 3750, unit: "лм", level: "A" },
  ]);
});

Deno.test("обязательный комфортный максимум сохраняется как граница", () => {
  assertEquals(
    extractReasoningBounds("Для комфортного света требуется не более 5000 лм."),
    [{ op: "max", value: 5000, unit: "лм", strict: false }],
  );
});

Deno.test("две явно названные границы сохраняют настоящий закрытый диапазон", () => {
  const projected = projectReasoningRangeCriteria(
    [],
    "Требуется диапазон 3750–5000 лм: не менее 3750 лм и не более 5000 лм.",
    [{ key: "flow", caption: "Световой поток", type: "number", unit: "лм" }],
  );
  assertEquals(projected.added, [
    {
      key: "Световой поток",
      op: "range",
      value: [3750, 5000],
      unit: "лм",
      level: "A",
    },
  ]);
});

Deno.test("проверенный средний расчёт сохраняет исходный диапазон результата", () => {
  const projected = projectReasoningRangeCriteria(
    [],
    "Ориентир 150–200 лк. Считаем: 25 м² × 175 лк (среднее) ≈ 4375 лм.",
    [{ key: "flow", caption: "Световой поток", type: "number", unit: "лм" }],
  );
  assertEquals(projected.added, [
    {
      key: "Световой поток",
      op: "range",
      value: [3750, 5000],
      unit: "лм",
      level: "A",
    },
  ]);
});

Deno.test("форматированный приблизительный результат сохраняет диапазон расчёта", () => {
  const projected = projectReasoningRangeCriteria(
    [],
    "Ориентир 150–200 лк: 25 м² × 175 лк ≈ **~4400 лм** — это целевой поток.",
    [{
      key: "svetovoy_potok",
      caption: "Световой поток, лм",
      type: "number",
      unit: "лм",
      values: [{ value: "3000" }, { value: "3750" }, { value: "4000" }, {
        value: "5000",
      }, { value: "6000" }],
    }],
  );
  assertEquals(projected.added, [
    {
      key: "Световой поток, лм",
      op: "range",
      value: [3750, 5000],
      unit: "лм",
      level: "A",
    },
  ]);
});

Deno.test("два диапазона одной единицы не проецируются на один фасет наугад", () => {
  const projected = projectReasoningRangeCriteria(
    [],
    "до установки 15–20 мм, после установки 6–8 мм",
    [
      { key: "size", caption: "Размер", type: "number", unit: "мм" },
    ],
  );
  assertEquals(projected.added, []);
});

Deno.test("локальное состояние диапазона не переносится на противоположный параметр", () => {
  const projected = projectReasoningRangeCriteria(
    [],
    "Для свободной посадки внутренний диаметр до усадки должен быть 12–20 мм, а после усадки — меньше 10 мм.",
    [
      {
        key: "before_diameter",
        caption: "Внутренний диаметр до термоусадки, мм",
        type: "checkbox",
        unit: "мм",
        values: [{ value: "12" }, { value: "20" }],
      },
      {
        key: "after_diameter",
        caption: "Внутренний диаметр после термоусадки, мм",
        type: "checkbox",
        unit: "мм",
        values: [{ value: "6" }, { value: "10" }],
      },
      {
        key: "wall_after",
        caption: "Толщина стенки после усадки, мм",
        type: "checkbox",
        unit: "мм",
        values: [{ value: "1" }, { value: "2" }],
      },
    ],
  );

  assertEquals(projected.added, [{
    key: "Внутренний диаметр до термоусадки, мм",
    op: "range",
    value: [12, 20],
    unit: "мм",
    level: "A",
  }]);
});

Deno.test("существующий критерий модели разрешает неоднозначность фасетов с одной единицей", () => {
  const projected = projectReasoningRangeCriteria(
    [{
      key: "Световой поток, Лм",
      op: "min",
      value: 3750,
      unit: "лм",
      level: "A",
    }],
    "Нужен световой поток 3750–5000 лм",
    [
      {
        key: "lamp_flow",
        caption: "Световой поток, Лм",
        type: "number",
        unit: "лм",
      },
      {
        key: "module_flow",
        caption: "Поток светодиодного модуля",
        type: "number",
        unit: "лм",
      },
    ],
  );
  assertEquals(projected.added, [
    {
      key: "Световой поток, Лм",
      op: "range",
      value: [3750, 5000],
      unit: "лм",
      level: "A",
    },
  ]);
});

Deno.test("числовые live-значения компенсируют строковый тип фасета каталога", () => {
  const projected = projectReasoningRangeCriteria(
    [{ key: "Световой поток", op: "min", value: 3750, unit: "лм", level: "A" }],
    "Нужен световой поток 3750–5000 лм",
    [{
      key: "flow",
      caption: "Световой поток",
      type: "checkbox",
      unit: "лм",
      values: [{ value: "3000" }, { value: "4000" }, { value: "5000" }],
    }],
  );
  assertEquals(projected.added, [
    {
      key: "Световой поток",
      op: "range",
      value: [3750, 5000],
      unit: "лм",
      level: "A",
    },
  ]);
});

Deno.test("слова рядом с диапазоном разрешают неоднозначность live-фасетов", () => {
  const projected = projectReasoningRangeCriteria(
    [],
    "Для комнаты нужен суммарный световой поток 3750–5000 лм.",
    [
      {
        key: "lamp_flow",
        caption: "Световой поток",
        type: "checkbox",
        unit: "лм",
        values: [{ value: "4000" }],
      },
      {
        key: "module_flow",
        caption: "Поток светодиодного модуля",
        type: "checkbox",
        unit: "лм",
        values: [{ value: "4100" }],
      },
    ],
  );
  assertEquals(projected.added, [
    {
      key: "Световой поток",
      op: "range",
      value: [3750, 5000],
      unit: "лм",
      level: "A",
    },
  ]);
});

Deno.test("единица из live-подписи компенсирует пустое поле unit", () => {
  const projected = projectReasoningRangeCriteria(
    [],
    "Нужен световой поток 3750–5000 лм",
    [{
      key: "flow_lm",
      caption: "Световой поток, Лм",
      type: "checkbox",
      unit: null,
      values: [{ value: "4000" }],
    }],
  );
  assertEquals(projected.added, [
    {
      key: "Световой поток, Лм",
      op: "range",
      value: [3750, 5000],
      unit: "лм",
      level: "A",
    },
  ]);
});

Deno.test("часть длинного слова в подписи не выдаётся за физическую единицу", () => {
  const temperatureOnly = projectReasoningRangeCriteria(
    [],
    "Требуется длительный ток не менее 17 А.",
    [{
      key: "installation_temperature",
      caption: "Температура монтажа",
      type: "string",
      unit: null,
      values: [{ value: "-15+50 °C" }],
    }],
  );
  assertEquals(temperatureOnly.added, []);

  const withCurrent = projectReasoningRangeCriteria(
    [],
    "Требуется длительный ток не менее 17 А.",
    [
      {
        key: "installation_temperature",
        caption: "Температура монтажа",
        type: "string",
        unit: null,
        values: [{ value: "-15+50 °C" }],
      },
      {
        key: "rated_current",
        caption: "Допустимый ток, А",
        type: "string",
        unit: null,
        values: [{ value: "16" }, { value: "25" }],
      },
    ],
  );
  assertEquals(withCurrent.added, [{
    key: "Допустимый ток, А",
    op: "min",
    value: 17,
    unit: "а",
    level: "A",
  }]);
});

Deno.test("machine-key suffix cannot override the public physical unit", () => {
  const projected = projectReasoningRangeCriteria(
    [],
    "Для стабилизатора нужен диапазон входного напряжения 140–260 В.",
    [
      {
        key: "moschnosty__vt__quat__v",
        caption: "Мощность, Вт",
        type: "number",
        unit: null,
        values: [{ value: "8000-9000" }],
      },
      {
        key: "vhodnoe_napryaghenie__v__kirmeli_kerneui__v",
        caption: "Входное напряжение, В",
        type: "checkbox",
        unit: null,
        values: [{ value: "140-260" }],
      },
    ],
  );
  assertEquals(projected.added, [{
    key: "Входное напряжение, В",
    op: "range",
    value: [140, 260],
    unit: "в",
    level: "A",
  }]);
});

Deno.test("точное число клиента проецируется на разделенный live-фасет", () => {
  const projected = projectLiteralMeasuredCriteria(
    [],
    "Нужен аппарат 16 А",
    "Подбираю аппарат на 16 А.",
    [{
      key: "rated_current",
      caption: "Номинальный ток, А",
      type: "checkbox",
      unit: "А",
      values: [{ value: "6" }, { value: "16" }],
    }],
  );
  assertEquals(projected.added, [{
    key: "Номинальный ток, А",
    op: "eq",
    value: "16",
    unit: "А",
    level: "A",
  }]);
});

Deno.test("Latin and Cyrillic unit glyphs preserve one exact live measurement", () => {
  const projected = projectLiteralMeasuredCriteria(
    [],
    "Покажи лампы с тёплым светом 3000 K",
    "Проверяю точное значение 3000 K.",
    [{
      key: "colour_temperature",
      caption: "Цветовая температура, К",
      type: "checkbox",
      unit: "К",
      values: [{ value: "2700" }, { value: "3000" }, { value: "4000" }],
    }],
  );
  assertEquals(projected.added, [{
    key: "Цветовая температура, К",
    op: "eq",
    value: "3000",
    unit: "К",
    level: "A",
  }]);
  assertEquals(projected.matched, projected.added);
});

Deno.test("a customer range endpoint is not an exact measured product value", () => {
  const facets = [{
    key: "colour_temperature",
    caption: "Цветовая температура, К",
    type: "checkbox",
    unit: "К",
    values: [{ value: "4000" }, { value: "6500" }],
  }];
  for (
    const customer of [
      "Нужен белый свет 4000–6500 K",
      "Нужен белый свет от 4000 до 6500 K",
    ]
  ) {
    assertEquals(
      projectLiteralMeasuredCriteria([], customer, customer, facets).added,
      [],
    );
  }
  assertEquals(
    projectLiteralMeasuredCriteria(
      [],
      "Допустимо 4000–6500 K, но нужен вариант ровно 6500 K",
      "Допустимо 4000–6500 K, но нужен вариант ровно 6500 K",
      facets,
    ).added,
    [{
      key: "Цветовая температура, К",
      op: "eq",
      value: "6500",
      unit: "К",
      level: "A",
    }],
  );
});

Deno.test("guarded exact criterion disambiguates an otherwise ambiguous literal measurement", () => {
  const existing: Criterion = {
    key: "Цветовая температура, К",
    op: "eq",
    value: "3000",
    level: "A",
  };
  const projected = projectLiteralMeasuredCriteria(
    [existing],
    "Есть ли варианты 3000К?",
    "Проверяю точно 3000К.",
    [
      {
        key: "colour_temperature",
        caption: "Цветовая температура, К",
        type: "string",
        unit: null,
        values: [{ value: "3000" }, { value: "4000" }],
      },
      {
        key: "opaque_number",
        caption: "Внутренний код",
        type: "string",
        unit: null,
        values: [{ value: "3000" }],
      },
    ],
  );

  assertEquals(projected.added, []);
  assertEquals(projected.matched, [existing]);
});

Deno.test("explicit schema unit wins over unrelated unitless facets with the same live value", () => {
  const projected = projectLiteralMeasuredCriteria(
    [],
    "Покажи LED-лампы E27 с тёплым светом 3000 K",
    "Ищу лампы с тёплым светом.",
    [
      {
        key: "colour_temperature",
        caption: "Цветовая температура, К",
        type: "string",
        unit: null,
        values: [{ value: "2700" }, { value: "3000" }, { value: "4000" }],
      },
      {
        key: "average_lifetime",
        caption: "Средний номинальный срок службы, ч",
        type: "string",
        unit: null,
        values: [{ value: "3000" }, { value: "15000" }],
      },
      {
        key: "opaque_number",
        caption: "Внутренний код",
        type: "string",
        unit: null,
        values: [{ value: "3000" }],
      },
    ],
  );

  assertEquals(projected.added, [{
    key: "Цветовая температура, К",
    op: "eq",
    value: "3000",
    unit: "к",
    level: "A",
  }]);
  assertEquals(projected.matched, projected.added);
});

Deno.test("visible reasoning may disambiguate but cannot invent a customer-owned exact value", () => {
  const criterion: Criterion = {
    key: "Цветовая температура, К",
    op: "eq",
    value: "3000",
    level: "A",
  };
  const facets = [
    {
      key: "group_pack_quantity",
      caption: "Количество в групповой упаковке",
      type: "checkbox",
      unit: null,
      values: [{ value: "12" }, { value: "220" }, { value: "230" }],
    },
    {
      key: "colour_temperature",
      caption: "Цветовая температура, К",
      type: "string",
      unit: null,
      values: [{ value: "2700" }, { value: "3000" }],
    },
    {
      key: "working_temperature",
      caption: "Рабочая температура, К",
      type: "string",
      unit: null,
      values: [{ value: "3000" }],
    },
  ];

  assertEquals(
    customerOwnsDerivedExactFacetValue(
      criterion,
      "Покажи LED-лампы E27 с тёплым светом 3000 K",
      "Обязательная цветовая температура — 3000 K.",
      facets,
    ),
    true,
  );
  assertEquals(
    customerOwnsDerivedExactFacetValue(
      criterion,
      "Покажи LED-лампы E27 с тёплым светом",
      "Обязательная цветовая температура — 3000 K.",
      facets,
    ),
    false,
  );
});

Deno.test("unitless live-фасет выбирается только после исключения явно другой шкалы", () => {
  const projected = projectLiteralMeasuredCriteria(
    [],
    "Нужен аппарат с номинальным током 16 А",
    "Подбираю аппарат на 16 А.",
    [
      {
        key: "cable_section",
        caption: "Макс. сечение кабеля, мм2",
        type: "checkbox",
        unit: null,
        values: [{ value: "6" }, { value: "16" }],
      },
      {
        key: "rated_current",
        caption: "Номинальный ток",
        type: "checkbox",
        unit: null,
        values: [{ value: "6" }, { value: "16" }],
      },
    ],
  );
  assertEquals(projected.added, [{
    key: "Номинальный ток",
    op: "eq",
    value: "16",
    unit: "а",
    level: "A",
  }]);
});

Deno.test("a typical model range remains advisory instead of becoming mandatory", () => {
  const projected = projectReasoningRangeCriteria(
    [],
    "Для квартиры 4,5–6 кА отключающей способности обычно хватает, но проверю выборку.",
    [{
      key: "breaking_capacity",
      caption: "Номинальная отключающая способность, кА",
      type: "checkbox",
      unit: "кА",
      values: [{ value: "4.5" }, { value: "6" }],
    }],
  );
  assertEquals(projected.added, []);
});

Deno.test("an ordinary illustrative range is not promoted by the word usually alone", () => {
  const projected = projectReasoningRangeCriteria(
    [],
    "Сечение вспомогательных жил обычно 0,5–0,75 мм².",
    [{
      key: "section",
      caption: "Сечение кабеля, мм2",
      type: "checkbox",
      unit: "мм²",
      values: [{ value: "0.5" }, { value: "0.75" }],
    }],
  );
  assertEquals(projected.added, []);
});

Deno.test("an unqualified engineering range cannot bind a qualified capability facet", () => {
  const contract = compileMeasuredReasoningSearchContract(
    [],
    "Номинальный ток 25 А соответствует защите линии сечением 2,5–4 мм².",
    [],
    [{
      key: "max_connected_section",
      caption: "Макс. сечение подключаемого кабеля, мм2",
      type: "checkbox",
      unit: "мм²",
      values: [{ value: "16" }, { value: "25" }, { value: "35" }],
    }],
  );

  assertEquals(contract.projected_criteria, []);
  assertEquals(contract.mandatory_criteria, []);
  assertEquals(contract.options, {});
});

Deno.test("a supply-voltage range cannot bind working or insulation roles by unit alone", () => {
  const facets = [
    {
      key: "working_voltage",
      caption: "Номинальное рабочее напряжение, В",
      type: "checkbox",
      unit: "В",
      values: [{ value: "220" }, { value: "230" }, { value: "400" }],
    },
    {
      key: "insulation_voltage",
      caption: "Номинальное напряжение изоляции, В",
      type: "checkbox",
      unit: "В",
      values: [{ value: "250" }, { value: "500" }],
    },
  ];
  const unqualified = compileMeasuredReasoningSearchContract(
    [],
    "Для квартирной сети подходит переменное напряжение 220–230 В.",
    [],
    facets,
  );
  assertEquals(unqualified.projected_criteria, []);
  assertEquals(unqualified.mandatory_criteria, []);

  const working = compileMeasuredReasoningSearchContract(
    [],
    "Требуется рабочее напряжение 220–230 В.",
    [],
    facets,
  );
  assertEquals(working.projected_criteria, [{
    key: "Номинальное рабочее напряжение, В",
    op: "range",
    value: [220, 230],
    unit: "В",
    level: "A",
  }]);
});

Deno.test("direct product measurement can bind one otherwise unitless live facet", () => {
  const projected = projectLiteralMeasuredCriteria(
    [],
    "Мне нужен аппарат на 25 А",
    "Мне нужен аппарат на 25 А",
    [{
      key: "rated_current",
      caption: "Номинальный ток",
      type: "checkbox",
      unit: null,
      values: [{ value: "16" }, { value: "25" }, { value: "32" }],
    }],
  );
  assertEquals(projected.added, [{
    key: "Номинальный ток",
    op: "eq",
    value: "25",
    unit: "а",
    level: "A",
  }]);
});

Deno.test("bare measurement in an anchored product-spec list binds the unique live facet", () => {
  const projected = projectLiteralMeasuredCriteria(
    [{
      key: "Количество полюсов",
      op: "eq",
      value: "1",
      level: "A",
      evidence: "user_explicit",
    }],
    "Найди аппарат до 1000 тенге 1 полюсной, 16 А характеристика С",
    "Найди аппарат до 1000 тенге 1 полюсной, 16 А характеристика С",
    [
      {
        key: "pole_count",
        caption: "Количество полюсов",
        type: "checkbox",
        unit: null,
        values: [{ value: "1" }, { value: "2" }],
      },
      {
        key: "cable_section",
        caption: "Макс. сечение кабеля, мм2",
        type: "checkbox",
        unit: null,
        values: [{ value: "6" }, { value: "16" }],
      },
      {
        key: "rated_current",
        caption: "Номинальный ток",
        type: "checkbox",
        unit: null,
        values: [{ value: "6" }, { value: "16" }],
      },
    ],
  );
  assertEquals(projected.added, [{
    key: "Номинальный ток",
    op: "eq",
    value: "16",
    unit: "а",
    level: "A",
  }]);
});

Deno.test("an unrelated facet anchor cannot turn a named installation height into a product scalar", () => {
  const projected = projectLiteralMeasuredCriteria(
    [{
      key: "Цвет корпуса",
      op: "eq",
      value: "черный",
      level: "A",
      evidence: "user_explicit",
    }],
    "Нужен черный прожектор, высота установки примерно 1,5 м",
    "Нужен черный прожектор, высота установки примерно 1,5 м",
    [
      {
        key: "colour",
        caption: "Цвет корпуса",
        type: "checkbox",
        unit: null,
        values: [{ value: "черный" }],
      },
      {
        key: "weight",
        caption: "Вес",
        type: "checkbox",
        unit: null,
        values: [{ value: "1.5" }, { value: "2" }],
      },
    ],
  );
  assertEquals(projected.added, []);
  assertEquals(projected.matched, []);
});

Deno.test("application load after for-clause cannot bind a unitless product facet", () => {
  const projected = projectLiteralMeasuredCriteria(
    [],
    "Нужен аппарат для нагрузки на 25 А",
    "Нужен аппарат для нагрузки на 25 А",
    [{
      key: "rated_current",
      caption: "Номинальный ток",
      type: "checkbox",
      unit: null,
      values: [{ value: "16" }, { value: "25" }, { value: "32" }],
    }],
  );
  assertEquals(projected.added, []);
});

Deno.test("application height cannot become a unitless product facet with the same scalar", () => {
  const projected = projectLiteralMeasuredCriteria(
    [],
    "Двор 35 м², высота установки примерно 1,5 м",
    "Двор 35 м², высота установки примерно 1,5 м",
    [{
      key: "ves__salmaғy",
      caption: "Вес",
      type: "checkbox",
      unit: null,
      values: [{ value: "1.5" }, { value: "2" }],
    }],
  );
  assertEquals(projected.added, []);
  assertEquals(projected.matched, []);
});

Deno.test("natural customer area projects onto an ASCII-square live facet", () => {
  const projected = projectLiteralMeasuredCriteria(
    [],
    "Зал 30 квадратов",
    "Подбираю современный вариант для зала.",
    [{
      key: "max_area",
      caption: "Максимальная площадь освещения, м2",
      type: "checkbox",
      unit: null,
      values: [{ value: "25" }, { value: "30" }, { value: "35" }],
    }],
  );
  assertEquals(projected.added, [{
    key: "Максимальная площадь освещения, м2",
    op: "min",
    value: "30",
    unit: "м²",
    level: "A",
  }]);
});

Deno.test("a copied room area cannot own an exact product capacity", () => {
  const facet = {
    key: "max_area",
    caption: "Максимальная площадь освещения, м2",
    type: "checkbox",
    unit: null,
    values: [{ value: "25" }, { value: "30" }, { value: "35" }],
  };
  const criterion: Criterion = {
    key: facet.caption,
    op: "eq",
    value: "30",
    level: "A",
  };
  const customer =
    "хочу поменять дома люстру в зале 30 квадратов. Что предложишь из современного?";
  const reasoning =
    "Максимальная площадь освещения у люстры — значение 30 м², прямое соответствие комнате.";
  assertEquals(
    customerOwnsDerivedExactFacetValue(
      criterion,
      customer,
      reasoning,
      [facet],
    ),
    false,
  );
  assertEquals(
    projectLiteralMeasuredCriteria([], customer, reasoning, [facet]).added,
    [{ key: facet.caption, op: "min", value: "30", unit: "м²", level: "A" }],
  );
  const corrected = projectLiteralMeasuredCriteria(
    [criterion],
    customer,
    reasoning,
    [facet],
    [],
  );
  assertEquals(corrected.criteria, [{
    key: facet.caption,
    op: "min",
    value: "30",
    unit: "м²",
    level: "A",
  }]);
  assertEquals(corrected.matched, corrected.criteria);
  assertEquals(
    projectLiteralMeasuredCriteria(
      [],
      "Нужна максимальная площадь освещения товара ровно 30 м²",
      reasoning,
      [facet],
    ).added[0]?.op,
    "eq",
  );
  assertEquals(
    projectLiteralMeasuredCriteria(
      [],
      "Для комнаты ровно 30 м² нужен светильник",
      reasoning,
      [facet],
    ).added[0]?.op,
    "min",
  );
  assertEquals(
    customerOwnsDerivedExactFacetValue(
      criterion,
      "Нужна максимальная площадь освещения товара ровно 30 м²",
      reasoning,
      [facet],
    ),
    true,
  );
});

Deno.test("contextual capacity projection is generic across maximum and minimum live facets", () => {
  const projected = projectLiteralMeasuredCriteria(
    [],
    "Нужен узел для участка длиной 10 м",
    "Ищу узел с подходящей длиной участка.",
    [{
      key: "min_segment",
      caption: "Минимальная длина обслуживаемого участка, м",
      type: "number",
      unit: "м",
      values: [{ value: "10" }, { value: "15" }],
    }],
  );
  assertEquals(projected.added, [{
    key: "Минимальная длина обслуживаемого участка, м",
    op: "max",
    value: "10",
    unit: "м",
    level: "A",
  }]);
});

Deno.test("направленная величина клиента не сужается до точного равенства", () => {
  const projected = projectLiteralMeasuredCriteria(
    [],
    "Нужна мощность от 100 Вт",
    "Требуется не менее 100 Вт.",
    [{
      key: "power",
      caption: "Мощность, Вт",
      type: "number",
      unit: "Вт",
      values: [{ value: "100" }, { value: "150" }],
    }],
  );
  assertEquals(projected.added, []);
});

Deno.test("противоположные направления одного размера не превращаются в eq", () => {
  const projected = projectLiteralMeasuredCriteria(
    [],
    "Размер детали 10 мм",
    "До установки нужен размер больше 10 мм, после установки — меньше 10 мм.",
    [
      {
        key: "before",
        caption: "Размер до установки",
        type: "number",
        unit: "мм",
        values: [{ value: "10" }],
      },
      {
        key: "after",
        caption: "Размер после установки",
        type: "number",
        unit: "мм",
        values: [{ value: "10" }],
      },
    ],
  );
  assertEquals(projected.added, []);
});

Deno.test("два равноправных live-фасета одной единицы не выбираются наугад", () => {
  const projected = projectLiteralMeasuredCriteria(
    [],
    "Нужен параметр 10 мм",
    "Подбираю значение 10 мм.",
    [
      {
        key: "alpha",
        caption: "Параметр альфа",
        type: "number",
        unit: "мм",
        values: [{ value: "10" }],
      },
      {
        key: "beta",
        caption: "Параметр бета",
        type: "number",
        unit: "мм",
        values: [{ value: "10" }],
      },
    ],
  );
  assertEquals(projected.added, []);
});

Deno.test("числовой критерий из рассуждения повышается с B до обязательного A", () => {
  const result = promoteMeasuredReasoningCriteria([
    { key: "Световой поток", op: "min", value: 3750, unit: "лм", level: "B" },
    { key: "Цвет", op: "eq", value: "белый", level: "B" },
  ], "Для задачи нужен поток 3750–5000 лм");
  assertEquals(result.criteria, [
    { key: "Световой поток", op: "min", value: 3750, unit: "лм", level: "A" },
    { key: "Цвет", op: "eq", value: "белый", level: "B" },
  ]);
  assertEquals(result.promoted, ["Световой поток"]);
});

Deno.test("составная входная единица не конфликтует с производной товарной единицей", () => {
  const projected = projectReasoningRangeCriteria(
    [],
    "25 м² × 150–200 лм/м² = 3750–5000 лм",
    [{
      key: "output_flow",
      caption: "Выходной поток, лм",
      type: "number",
      unit: "лм",
      values: [{ value: "3750" }, { value: "4000" }, { value: "5000" }],
    }],
  );
  assertEquals(projected.added, [{
    key: "Выходной поток, лм",
    op: "range",
    value: [3750, 5000],
    unit: "лм",
    level: "A",
  }]);
});

Deno.test("живой фасет восстанавливает пропущенную моделью единицу обязательного критерия", () => {
  const result = promoteMeasuredReasoningCriteria(
    [{ key: "output_flow", op: "range", value: [3750, 5000], level: "B" }],
    "Нужен диапазон 3750–5000 лм",
    [{
      key: "output_flow",
      caption: "Выходной поток, лм",
      unit: "лм",
      values: [{ value: "4000" }],
    }],
  );
  assertEquals(result.criteria, [{
    key: "output_flow",
    op: "range",
    value: [3750, 5000],
    unit: "лм",
    level: "A",
  }]);
  assertEquals(result.promoted, ["output_flow"]);
});

Deno.test("alignCriteriaWithReasoning: eq на числе клиента → min по прозе", () => {
  const criteria: Criterion[] = [
    { key: "Параметр альфа", op: "eq", value: 12, unit: "мм", level: "A" },
  ];
  const r = alignCriteriaWithReasoning(
    criteria,
    "Диаметр должен быть больше 12 мм с запасом.",
  );
  assertEquals(r.alignments.length, 1);
  assertEquals(r.criteria[0].op, "min");
  assertEquals(r.criteria[0].exclusive, true);
});

Deno.test("строгость задаёт только проза системы, а не совпадение с числом клиента", () => {
  const criteria: Criterion[] = [
    { key: "Параметр альфа", op: "min", value: 12, unit: "мм", level: "A" },
  ];
  const strict = alignCriteriaWithReasoning(
    criteria,
    "нужен размер больше 12 мм",
  );
  const inclusive = alignCriteriaWithReasoning(
    criteria,
    "нужен размер не менее 12 мм",
  );
  assertEquals(strict.criteria[0].exclusive, true);
  assertEquals(inclusive.criteria[0].exclusive === true, false);
});

Deno.test("alignCriteriaWithReasoning: порог не выдумывается без совпадения числа", () => {
  const criteria: Criterion[] = [
    { key: "Параметр альфа", op: "eq", value: 12, unit: "мм", level: "A" },
  ];
  const r = alignCriteriaWithReasoning(criteria, "нужен запас не менее 40 мм");
  assertEquals(r.alignments.length, 0);
  assertEquals(r.criteria[0].op, "eq");
});

Deno.test("alignCriteriaWithReasoning: уровень B не трогаем", () => {
  const criteria: Criterion[] = [
    { key: "Параметр бета", op: "eq", value: 12, unit: "мм", level: "B" },
  ];
  const r = alignCriteriaWithReasoning(criteria, "больше 12 мм");
  assertEquals(r.alignments.length, 0);
});

Deno.test("гейт: строгое неравенство отсеивает границу", () => {
  const p = product("1", ["Параметр альфа: 12/6 мм"]);
  const strict: Criterion = {
    key: "Параметр альфа",
    op: "min",
    value: 12,
    unit: "мм",
    exclusive: true,
  };
  const loose: Criterion = {
    key: "Параметр альфа",
    op: "min",
    value: 12,
    unit: "мм",
  };
  assertEquals(checkCriterion(p, strict).verdict, "fail");
  assertEquals(checkCriterion(p, loose).verdict, "pass");
});

Deno.test("строгая формулировка побеждает нестрогую по тому же числу", () => {
  const criteria: Criterion[] = [
    { key: "Параметр альфа", op: "min", value: 12, unit: "мм", level: "A" },
  ];
  const r = alignCriteriaWithReasoning(
    criteria,
    "нужен диаметр больше 12 мм; то есть ≥ 12 мм; беру типоразмеры от 12 мм",
  );
  assertEquals(r.alignments.length, 1);
  assertEquals(r.criteria[0].op, "min");
  assertEquals(r.criteria[0].exclusive, true);
  assertEquals(r.ambiguities.length, 0);
});

Deno.test("противоположные направления: направление берём машинное, строгость — из прозы", () => {
  const criteria: Criterion[] = [
    { key: "Параметр альфа", op: "min", value: 12, unit: "мм", level: "A" },
  ];
  const r = alignCriteriaWithReasoning(
    criteria,
    "до усадки больше 12 мм, после усадки меньше 12 мм",
  );
  assertEquals(r.criteria[0].op, "min");
  assertEquals(r.criteria[0].exclusive, true);
  assertEquals(r.ambiguities.length, 0);
});

Deno.test("противоположные направления без совпадения с машинным op → ambiguity", () => {
  const criteria: Criterion[] = [
    { key: "Параметр альфа", op: "eq", value: 12, unit: "мм", level: "A" },
  ];
  const r = alignCriteriaWithReasoning(
    criteria,
    "до усадки больше 12 мм, после усадки меньше 12 мм",
  );
  assertEquals(r.alignments.length, 0);
  assertEquals(r.criteria[0].op, "eq");
  assertEquals(r.ambiguities.length, 2);
});

Deno.test("регресс fd817c18: трубка 12/6 не проходит после выравнивания", () => {
  const reasoning = [
    "ищу трубки с исходным диаметром (до усадки) больше 12 мм — чтобы надеть кабель, — и усаженным диаметром меньше 12 мм",
    "внутренний диаметр до усадки ≥ 12 мм",
    "иду смотреть типоразмеры с внутренним диаметром от 12 мм",
  ].join("\n");
  const criteria: Criterion[] = [
    {
      key: "Внутр диаметр до термоусадки, мм",
      op: "min",
      value: 12,
      unit: "мм",
      level: "A",
    },
  ];
  const r = alignCriteriaWithReasoning(criteria, reasoning);
  assertEquals(r.criteria[0].exclusive, true);
  const p = product("1", ["Внутр диаметр до термоусадки, мм: 12"]);
  assertEquals(checkCriterion(p, r.criteria[0]).verdict, "fail");
});

Deno.test("регресс 3f72aef8: направление max не переворачивается прозой «больше 10 мм»", () => {
  // Проза модели: «до усадки чуть больше 10 мм … после усадки — меньше 10
  // (чтобы обжать)». Второе число без единицы, парсер его отбрасывает —
  // остаётся одна граница min:10 strict. Она НЕ должна перевернуть критерий
  // «после усадки max 10», иначе требование становится невыполнимым.
  const reasoning =
    "внутренний диаметр до усадки чуть больше 10 мм (чтобы надеть), а после усадки — меньше 10 (чтобы плотно обжать)";
  const criteria: Criterion[] = [
    {
      key: "Внутр диаметр до термоусадки",
      op: "min",
      value: 10,
      unit: "мм",
      level: "A",
    },
    {
      key: "Внутр диаметр после термоусадки",
      op: "max",
      value: 10,
      unit: "мм",
      level: "A",
    },
  ];
  const r = alignCriteriaWithReasoning(criteria, reasoning);
  assertEquals(r.criteria[0].op, "min");
  assertEquals(r.criteria[0].exclusive, true);
  assertEquals(r.criteria[1].op, "max");
  assertEquals(r.criteria[1].exclusive, undefined);
  assertEquals(r.alignments.length, 1);
  assertEquals(r.ambiguities.length, 1);
  // Трубка 12/6 проходит оба критерия.
  const p = product("1", [
    "Внутр диаметр до термоусадки: 12",
    "Внутр диаметр после термоусадки: 6",
  ]);
  assertEquals(checkCriterion(p, r.criteria[0]).verdict, "pass");
  assertEquals(checkCriterion(p, r.criteria[1]).verdict, "pass");
});

Deno.test("«не менее» не сбивает уже строгий min", () => {
  const criteria: Criterion[] = [
    {
      key: "Параметр альфа",
      op: "min",
      value: 10,
      unit: "мм",
      level: "A",
      exclusive: true,
    },
  ];
  const r = alignCriteriaWithReasoning(criteria, "нужен размер не менее 10 мм");
  assertEquals(r.criteria[0].exclusive, true);
  assertEquals(r.alignments.length, 0);
});

Deno.test("advisory model defaults do not become mandatory filters", () => {
  const criteria: Criterion[] = [
    {
      key: "Параметр альфа",
      op: "range",
      value: [30, 40],
      unit: "ед",
      level: "A",
    },
    { key: "Параметр бета", op: "eq", value: "нейтральный", level: "A" },
    { key: "Параметр гамма", op: "eq", value: "внутренний", level: "A" },
  ];
  const aligned = alignCriteriaImportanceWithReasoning(
    criteria,
    "Значит, нужен параметр альфа 30–40 ед. Параметр бета логичнее нейтральный. Параметр гамма — внутренний.",
  );
  assertEquals(aligned.criteria.map((criterion) => criterion.level), [
    "A",
    "B",
    "B",
  ]);
  assertEquals(aligned.demoted, ["Параметр бета", "Параметр гамма"]);
});

Deno.test("user-backed criterion stays mandatory without necessity wording", () => {
  const criterion: Criterion = {
    key: "Параметр дельта",
    op: "eq",
    value: "точный",
    level: "A",
  };
  const aligned = alignCriteriaImportanceWithReasoning(
    [criterion],
    "Параметр дельта — точный.",
    [criterion],
  );
  assertEquals(aligned.criteria[0].level, "A");
  assertEquals(aligned.demoted, []);
});

Deno.test("calculated result remains mandatory without a modal verb", () => {
  const criterion: Criterion = {
    key: "Параметр результата",
    op: "range",
    value: [3750, 5000],
    unit: "ед",
    level: "A",
  };
  const aligned = alignCriteriaImportanceWithReasoning(
    [criterion],
    "25 ед × 150–200 ед = 3750–5000 ед суммарного результата.",
  );
  assertEquals(aligned.criteria[0].level, "A");
  assertEquals(aligned.demoted, []);
});

Deno.test("projected measured range keeps one contract across equivalent reasoning wording", () => {
  const facets = [{
    key: "measured_output",
    caption: "Measured output, lm",
    type: "number",
    unit: "lm",
    values: [{ value: "3000" }, { value: "3750" }, { value: "4000" }, {
      value: "5000",
    }, { value: "6000" }],
  }];
  const softFilters: Criterion[] = [
    { key: "Mounting", op: "eq", value: "ceiling", level: "A" },
  ];
  const contract = compileMeasuredReasoningSearchContract(
    softFilters,
    "For the stated area this gives the required measured output of approximately 3750-5000 lm. Mounting is preferably ceiling.",
    [],
    facets,
  );
  assertEquals(contract.projected_criteria, [
    {
      key: "Measured output, lm",
      op: "range",
      value: [3750, 5000],
      unit: "lm",
      level: "A",
    },
  ]);
  assertEquals(contract.mandatory_criteria, contract.projected_criteria);
  assertEquals(contract.options, { measured_output: ["3750", "4000", "5000"] });
  assertEquals(contract.demoted, ["Mounting"]);
});

Deno.test("projected measured range is not demoted by comfort wording", () => {
  const facets = [{
    key: "svetovoy_potok",
    caption: "Световой поток, лм",
    type: "number",
    unit: "лм",
    values: [{ value: "3000" }, { value: "3750" }, { value: "4000" }, {
      value: "5000",
    }],
  }];
  const contract = compileMeasuredReasoningSearchContract(
    [],
    "Для комфортного освещения это даёт потребный световой поток примерно 3750–5000 лм.",
    [],
    facets,
  );
  assertEquals(
    contract.mandatory_criteria.map((criterion) => criterion.level),
    ["A"],
  );
  assertEquals(contract.options, { svetovoy_potok: ["3750", "4000", "5000"] });
});

Deno.test("a bare derived up-to capability does not become a product maximum", () => {
  const facets = [{
    key: "rated_voltage",
    caption: "Номинальное напряжение, кВ",
    type: "string",
    unit: null,
    values: [{ value: "≤ 0.66" }, { value: "≤ 1" }, { value: "≤ 10" }],
  }];
  const derived = compileMeasuredReasoningSearchContract(
    [],
    "Изделие должно относиться к классу, рассчитанному на напряжение до 1 кВ.",
    [],
    facets,
  );
  assertEquals(derived.projected_criteria, []);
  assertEquals(derived.mandatory_criteria, []);

  const explicit = compileMeasuredReasoningSearchContract(
    [],
    "По условию клиента номинальное напряжение должно быть не более 1 кВ.",
    [],
    facets,
  );
  assertEquals(explicit.projected_criteria, [{
    key: "Номинальное напряжение, кВ",
    op: "max",
    value: 1,
    unit: "кв",
    level: "A",
  }]);
});

Deno.test("an exact live application class remains mandatory while colour stays advisory", () => {
  const contract = compileMeasuredReasoningSearchContract(
    [
      {
        key: "Вид исполнения",
        op: "eq",
        value: "Внутренний класс",
        level: "A",
      },
      { key: "Цвет", op: "eq", value: "Нейтральный", level: "A" },
    ],
    "Для указанного помещения рекомендую категорию «Внутренний класс» с нейтральным цветом.",
    [],
    [
      {
        key: "kind",
        caption: "Вид исполнения",
        type: "checkbox",
        unit: null,
        values: [{ value: "Внутренний класс" }],
      },
      {
        key: "colour",
        caption: "Цвет",
        type: "checkbox",
        unit: null,
        values: [{ value: "Нейтральный" }],
      },
    ],
  );

  assertEquals(contract.mandatory_criteria, [
    { key: "Вид исполнения", op: "eq", value: "Внутренний класс", level: "A" },
  ]);
  assertEquals(contract.options, { kind: ["Внутренний класс"] });
  assertEquals(contract.demoted, ["Цвет"]);
});

Deno.test("classification wording cannot promote an adjacent exact colour value", () => {
  const contract = compileMeasuredReasoningSearchContract(
    [
      {
        key: "Вид светильника",
        op: "eq",
        value: "бытовые светильники накладные",
        level: "A",
      },
      { key: "Цвет корпуса", op: "eq", value: "белый", level: "A" },
    ],
    "По классу «Вид светильника» выбираю «бытовые светильники накладные», цвет корпуса — белый.",
    [],
    [
      {
        key: "kind",
        caption: "Вид светильника",
        type: "checkbox",
        unit: null,
        values: [{ value: "бытовые светильники накладные" }],
      },
      {
        key: "colour",
        caption: "Цвет корпуса",
        type: "checkbox",
        unit: null,
        values: [{ value: "белый" }],
      },
    ],
  );

  assertEquals(contract.mandatory_criteria, [
    {
      key: "Вид светильника",
      op: "eq",
      value: "бытовые светильники накладные",
      level: "A",
    },
  ]);
  assertEquals(contract.options, { kind: ["бытовые светильники накладные"] });
  assertEquals(contract.demoted, ["Цвет корпуса"]);
});

Deno.test("a compound canonical class containing semicolons remains one obligation", () => {
  const contract = compileMeasuredReasoningSearchContract(
    [{
      key: "Вид исполнения",
      op: "eq",
      value: "первый; второй; третий",
      level: "A",
    }],
    "По классу «Вид исполнения» выбираю «первый; второй; третий».",
    [],
    [{
      key: "kind",
      caption: "Вид исполнения",
      type: "checkbox",
      unit: null,
      values: [{ value: "первый; второй; третий" }],
    }],
  );

  assertEquals(contract.mandatory_criteria, [
    {
      key: "Вид исполнения",
      op: "eq",
      value: "первый; второй; третий",
      level: "A",
    },
  ]);
  assertEquals(contract.options, { kind: ["первый; второй; третий"] });
});

Deno.test("advisory catalog filters are removed even when no measured range can be projected", () => {
  const contract = compileMeasuredReasoningSearchContract(
    [
      { key: "Protection", op: "eq", value: "IP65", level: "A" },
      { key: "Material", op: "eq", value: "aluminium", level: "A" },
    ],
    "For this use I first look at protection IP65. Aluminium is a useful housing material.",
    [],
    [
      {
        key: "protection",
        caption: "Protection",
        type: "checkbox",
        unit: null,
        values: [{ value: "IP65" }],
      },
      {
        key: "material",
        caption: "Material",
        type: "checkbox",
        unit: null,
        values: [{ value: "aluminium" }],
      },
    ],
  );
  assertEquals(contract.projected_criteria, []);
  assertEquals(contract.mandatory_criteria, []);
  assertEquals(contract.options, {});
  assertEquals(contract.demoted, ["Protection", "Material"]);
});

Deno.test("an otherwise unbounded selection promotes only projectable measured criteria", () => {
  const aligned = promoteProjectableMeasuredFallbackCriteria([
    { key: "Measured output", op: "min", value: 3750, unit: "lm", level: "B" },
    { key: "Colour", op: "eq", value: "neutral", level: "B" },
  ], [{
    key: "measured_output",
    caption: "Measured output",
    unit: "lm",
    values: [{ value: "3000" }, { value: "4000" }],
  }]);
  assertEquals(aligned.criteria.map((criterion) => criterion.level), [
    "A",
    "B",
  ]);
  assertEquals(aligned.promoted, ["Measured output"]);
});

Deno.test("a measured preference already demoted as advisory cannot be promoted again", () => {
  const criteria: Criterion[] = [
    { key: "Measured output", op: "min", value: 3750, unit: "lm", level: "A" },
  ];
  const importance = alignCriteriaImportanceWithReasoning(
    criteria,
    "Measured output 3750 lm is one possible reference point.",
  );
  const aligned = promoteProjectableMeasuredFallbackCriteria(
    importance.criteria,
    [{
      key: "measured_output",
      caption: "Measured output",
      unit: "lm",
      values: [{ value: "4000" }],
    }],
    importance.demoted,
  );
  assertEquals(importance.demoted, ["Measured output"]);
  assertEquals(aligned.criteria.map((criterion) => criterion.level), ["B"]);
  assertEquals(aligned.promoted, []);
});

Deno.test("render-only model criteria cannot retroactively strengthen an ordinary search", () => {
  const frozen: Criterion[] = [
    {
      key: "Measured output",
      op: "range",
      value: [3750, 5000],
      unit: "lm",
      level: "A",
    },
  ];
  const aligned = demoteUnfrozenRenderCriteria([
    ...frozen,
    { key: "Implementation count", op: "eq", value: 5, level: "A" },
  ], frozen);
  assertEquals(aligned.criteria, [
    frozen[0],
    { key: "Implementation count", op: "eq", value: 5, level: "B" },
  ]);
  assertEquals(aligned.demoted, ["Implementation count"]);
});

Deno.test("render-only replacement criteria cannot strengthen a compiled retrieval contract", () => {
  const frozen: Criterion[] = [
    { key: "Номинальный ток", op: "eq", value: 16, unit: "А", level: "A" },
    {
      key: "Характеристика срабатывания",
      op: "eq",
      value: "Тип C",
      level: "A",
    },
  ];
  const aligned = demoteUnfrozenRenderCriteria([
    ...frozen,
    { key: "Вес", op: "max", value: 1, unit: "кг", level: "A" },
  ], frozen);
  assertEquals(
    aligned.criteria.map((criterion) => [criterion.key, criterion.level]),
    [
      ["Номинальный ток", "A"],
      ["Характеристика срабатывания", "A"],
      ["Вес", "B"],
    ],
  );
  assertEquals(aligned.demoted, ["Вес"]);
});

Deno.test("fallback promotion preserves an existing mandatory contract", () => {
  const aligned = promoteProjectableMeasuredFallbackCriteria([
    { key: "Exact class", op: "eq", value: "declared", level: "A" },
    { key: "Measured output", op: "min", value: 3750, unit: "lm", level: "B" },
  ], [{
    key: "measured_output",
    caption: "Measured output",
    unit: "lm",
    values: [{ value: "4000" }],
  }]);
  assertEquals(aligned.criteria.map((criterion) => criterion.level), [
    "A",
    "B",
  ]);
  assertEquals(aligned.promoted, []);
});

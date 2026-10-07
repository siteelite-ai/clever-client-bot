import {
  assertEquals,
  assertFalse,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import type { Criterion } from "./criteria-gate.ts";
import {
  assessDerivedSuitabilityProof,
  diagnoseDerivedClarification,
  hasCheckableMandatoryProductCriterion,
  isGenuinelyMissingDerivedClarification,
  isQuantityOnlyPurchaseRequest,
  UNVERIFIED_SUITABILITY_RESPONSE,
} from "./derived-suitability-proof.ts";

Deno.test("derived application search with only a retrieval phrase fails closed", () => {
  const decision = assessDerivedSuitabilityProof({
    route: "server_derived",
    mandatoryCriteria: [],
    retrievalQuery: "аналоговая видеокамера",
    customerEvidence:
      "Нужна камера: аналоговая, на улице, расстояние 30 метров",
  });
  assertEquals(decision, {
    kind: "unverified",
    response: UNVERIFIED_SUITABILITY_RESPONSE,
  });
  assertEquals(
    UNVERIFIED_SUITABILITY_RESPONSE,
    "Не могу подтвердить пригодность конкретных товаров для описанных условий: мне не удалось установить обязательный параметр товара, который можно проверить по его характеристикам. Не буду показывать неподтверждённые варианты.",
  );
  assertFalse(/нет\s+в\s+наличии|товары\s+отсутствуют/iu.test(
    UNVERIFIED_SUITABILITY_RESPONSE,
  ));
  assertFalse(UNVERIFIED_SUITABILITY_RESPONSE.includes("?"));
});

Deno.test("a real mandatory per-product proof keeps the derived route open", () => {
  const criteria: Criterion[] = [
    {
      key: "Степень защиты",
      op: "eq",
      value: "IP65",
      level: "A",
      evidence: "derived_required",
    },
    {
      key: "Световой поток",
      op: "min",
      value: 3500,
      unit: "лм",
      level: "A",
      evidence: "derived_required",
    },
  ];
  assertEquals(
    assessDerivedSuitabilityProof({
      route: "server_derived",
      mandatoryCriteria: criteria,
      customerEvidence: "Прожектор для двора 35 м², один на всю зону",
    }),
    { kind: "continue" },
  );
  assertEquals(hasCheckableMandatoryProductCriterion(criteria), true);
});

Deno.test("previously frozen customer criteria still count as product proof", () => {
  const priorExplicitCriteria: Criterion[] = [
    {
      key: "Степень защиты",
      op: "eq",
      value: "IP65",
      level: "A",
      evidence: "user_explicit",
    },
    {
      key: "Световой поток",
      op: "min",
      value: 3500,
      unit: "лм",
      level: "A",
      evidence: "user_explicit",
    },
  ];
  assertEquals(
    assessDerivedSuitabilityProof({
      route: "server_derived",
      mandatoryCriteria: priorExplicitCriteria,
      customerEvidence: "Прожектор для двора, IP65, не менее 3500 лм",
    }),
    { kind: "continue" },
  );
});

Deno.test("advisory, malformed and catalog-only values cannot substitute for proof", () => {
  assertEquals(
    hasCheckableMandatoryProductCriterion([
      {
        key: "Тип",
        op: "eq",
        value: "А",
        level: "B",
        evidence: "model_assumption",
      },
      {
        key: "Цена",
        op: "min",
        value: Number.NaN,
        level: "A",
        evidence: "derived_required",
      },
      {
        key: "",
        op: "eq",
        value: "IP65",
        level: "A",
        evidence: "derived_required",
      },
      {
        key: "Найденный фасет",
        op: "eq",
        value: "да",
        level: "A",
        evidence: "catalog_verified",
      },
    ]),
    false,
  );
});

Deno.test("a clarification cannot ask a fact already supplied by the customer", () => {
  assertEquals(
    assessDerivedSuitabilityProof({
      route: "server_derived",
      mandatoryCriteria: [],
      clarification: { question: "Какая система камеры: аналоговая или IP?" },
      customerEvidence:
        "Нужна аналоговая камера на улице, расстояние 30 метров",
    }).kind,
    "unverified",
  );
  assertEquals(
    assessDerivedSuitabilityProof({
      route: "server_derived",
      mandatoryCriteria: [],
      clarification: { question: "Какое расстояние до устройства?" },
      customerEvidence: "Расстояние до устройства 30 метров",
    }).kind,
    "unverified",
  );
  assertEquals(
    assessDerivedSuitabilityProof({
      route: "server_derived",
      mandatoryCriteria: [],
      clarification: { question: "Какое напряжение питания: 220 или 380 В?" },
      customerEvidence: "Нужно подключить устройство на участке",
    }).kind,
    "clarify",
  );
});

Deno.test("derived clarification diagnostic explains cross-category decisions without changing them", () => {
  const cases = [
    {
      question: "Какая система камеры: аналоговая или IP?",
      customerEvidence: "Нужна аналоговая камера на улице, расстояние 30 метров",
      isMissing: false,
      reason: "already_answered_choice",
      questionAxis: "система",
    },
    {
      question: "Какая характеристика срабатывания нужна?",
      customerEvidence: "Нужен автомат 16 А, характеристика С",
      isMissing: false,
      reason: "already_answered_axis",
      questionAxis: "характеристика",
    },
    {
      question: "Какой диаметр нужен?",
      customerEvidence: "Диаметр трубы 20 мм, длина трассы 30 м",
      isMissing: false,
      reason: "already_answered_axis",
      questionAxis: "диаметр",
    },
    {
      question: "Какая мощность светильника нужна?",
      customerEvidence: "Мощность 50 Вт для двора",
      isMissing: false,
      reason: "already_answered_axis",
      questionAxis: "мощность",
    },
    {
      question: "Какое напряжение сети у кондиционера: 220 В или 380 В?",
      customerEvidence:
        "Мне нужен кабель для подключения кондиционера мощностью 3 кВт. Что посоветуете?",
      isMissing: true,
      reason: "missing",
      questionAxis: "напряжение",
    },
    {
      question: "Однофазная или трёхфазная сеть питания?",
      customerEvidence:
        "Мне нужен кабель для подключения кондиционера мощностью 3 кВт. Что посоветуете?",
      isMissing: true,
      reason: "missing",
      questionAxis: "фаза",
    },
  ] as const;
  for (const testCase of cases) {
    const clarification = { question: testCase.question };
    const diagnostic = diagnoseDerivedClarification(
      clarification,
      testCase.customerEvidence,
    );
    assertEquals(diagnostic, {
      isMissing: testCase.isMissing,
      reason: testCase.reason,
      questionAxis: testCase.questionAxis,
    }, testCase.question);
    assertEquals(
      isGenuinelyMissingDerivedClarification(
        clarification,
        testCase.customerEvidence,
      ),
      diagnostic.isMissing,
    );
    assertEquals(
      assessDerivedSuitabilityProof({
        route: "server_derived",
        mandatoryCriteria: [],
        clarification,
        customerEvidence: testCase.customerEvidence,
      }).kind,
      diagnostic.isMissing ? "clarify" : "unverified",
    );
  }
});

Deno.test("derived clarification diagnostic is bounded and contains no free-form text", () => {
  for (const clarification of [null, { question: "  ?  " }]) {
    assertEquals(diagnoseDerivedClarification(clarification, "private evidence"), {
      isMissing: false,
      reason: "malformed",
      questionAxis: null,
    });
  }
  const question = "Какой СверхсекретныйКодКлиента123 нужен?";
  const customerEvidence = "Private evidence: secret-123";
  const diagnostic = diagnoseDerivedClarification({ question }, customerEvidence);
  assertEquals(diagnostic, {
    isMissing: true,
    reason: "missing",
    questionAxis: "other",
  });
  const serialized = JSON.stringify(diagnostic);
  assertFalse(serialized.includes(question));
  assertFalse(serialized.includes(customerEvidence));
  assertFalse(serialized.includes("сверхсекретный"));
  assertEquals((diagnostic.questionAxis ?? "").length <= 16, true);
});

Deno.test("a one-letter answer is known only when it belongs to the questioned axis", () => {
  const question = "Какая характеристика срабатывания нужна?";
  assertEquals(
    assessDerivedSuitabilityProof({
      route: "server_derived",
      mandatoryCriteria: [],
      clarification: { question },
      customerEvidence: "Нужен автомат 16 А, характеристика С",
    }).kind,
    "unverified",
  );
  assertEquals(
    assessDerivedSuitabilityProof({
      route: "server_derived",
      mandatoryCriteria: [],
      clarification: { question },
      customerEvidence: "Нужен автомат 16 А типа С; характеристику не знаю",
    }).kind,
    "clarify",
  );
  assertEquals(
    assessDerivedSuitabilityProof({
      route: "server_derived",
      mandatoryCriteria: [],
      clarification: { question },
      customerEvidence:
        "Характеристика с дополнительной защитой, без названного значения",
    }).kind,
    "clarify",
  );
  assertEquals(
    assessDerivedSuitabilityProof({
      route: "server_derived",
      mandatoryCriteria: [],
      clarification: { question },
      customerEvidence: "Характеристика с 16 А пока не выбрана",
    }).kind,
    "clarify",
  );
  assertEquals(
    assessDerivedSuitabilityProof({
      route: "server_derived",
      mandatoryCriteria: [],
      clarification: { question },
      customerEvidence:
        "Нужен автомат 16 А, характеристика срабатывания пока не известна",
    }).kind,
    "clarify",
  );
});

Deno.test("unrelated measurements do not answer a missing named dimension", () => {
  const question = "Какой диаметр нужен?";
  for (
    const customerEvidence of [
      "Диаметр пока не знаю, трасса 30 м",
      "Диаметр ещё не известен, трасса 30 м",
      "Нужен диаметр для трассы 30 м",
      "Трасса 30 м; диаметр неизвестен",
    ]
  ) {
    assertEquals(
      assessDerivedSuitabilityProof({
        route: "server_derived",
        mandatoryCriteria: [],
        clarification: { question },
        customerEvidence,
      }).kind,
      "clarify",
      customerEvidence,
    );
  }
  assertEquals(
    assessDerivedSuitabilityProof({
      route: "server_derived",
      mandatoryCriteria: [],
      clarification: { question },
      customerEvidence: "Диаметр трубы 20 мм, длина трассы 30 м",
    }).kind,
    "unverified",
  );
});

Deno.test("exact lookup, availability and quantity-only browsing stay outside this guard", () => {
  assertEquals(isQuantityOnlyPurchaseRequest("Нужно 50 метров кабеля"), true);
  assertEquals(isQuantityOnlyPurchaseRequest("50 м провода"), true);
  assertEquals(
    isQuantityOnlyPurchaseRequest(
      "Нужна аналоговая камера на улице, расстояние 30 метров",
    ),
    false,
  );
  assertEquals(
    isQuantityOnlyPurchaseRequest(
      "Прожектор для двора 35 м², один на всю зону",
    ),
    false,
  );
  for (
    const request of [
      "Есть ВВГнг-LS 3×2,5?",
      "Покажите лампы с цоколем E27",
      "Нужно 50 метров кабеля",
    ]
  ) {
    assertEquals(
      assessDerivedSuitabilityProof({
        route: "other",
        mandatoryCriteria: [],
        customerEvidence: request,
      }),
      { kind: "continue" },
    );
  }
});

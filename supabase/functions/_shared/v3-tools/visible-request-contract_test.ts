import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  buildVisibleRequestContract,
  deriveCustomerOwnedVisibleFacetProofs,
  productSupportsVisibleRequestContract,
  productSupportsVisibleRequestRequirement,
  recordVerifiedCustomerFacetFilterEvidence,
  shouldContinueVisibleRecoveryPage,
  shouldExpandVisibleRecoverySearch,
  titleSupportsVisibleRequestContract,
  withVerifiedCustomerFacetEvidence,
} from "./visible-request-contract.ts";

const motionFacet = {
  key: "motion_sensor_catalog_key",
  caption: "С датчиком движения",
  unit: null,
  values: [{ value: "да" }, { value: "нет" }],
};

function frozenMotionProofs(message: string) {
  return deriveCustomerOwnedVisibleFacetProofs(
    message,
    [motionFacet],
    [{
      key: "С датчиком движения",
      op: "eq",
      value: "да",
      evidence: "user_explicit",
      level: "A",
    }],
    [{ key: motionFacet.key, value: "да" }],
  );
}

Deno.test("literal linear length requires an actual unit in the title", () => {
  const contract = buildVisibleRequestContract("подбери удлинитель на 50 м");
  assertEquals(titleSupportsVisibleRequestContract("Удлинитель УК-50 /50м", contract), true);
  assertEquals(titleSupportsVisibleRequestContract("Удлинитель EB-50-007", contract), false);
});

Deno.test("a complete relational noun beside the product head proves the adjective", () => {
  for (const [request, head, full, compact] of [
    ["светодиодный светильник", "Светильники", "Светильник светодиодный 48W", "Светильник светодиод (потолочный) 48W"],
    ["лазерный уровень", "Уровень", "Лазерный уровень", "Уровень лазер"],
  ]) {
    const contract = buildVisibleRequestContract(request, {
      productClass: head, candidateTitles: [full, compact],
    });
    assertEquals(contract.length, 1);
    assertEquals(titleSupportsVisibleRequestContract(compact, contract), true);
    assertEquals(titleSupportsVisibleRequestContract(full, contract), true);
  }
});

Deno.test("relational noun proof is not arbitrary prefix matching or trait-word coincidence", () => {
  const contract = buildVisibleRequestContract("светодиодный светильник", {
    productClass: "Светильники", candidateTitles: ["Светильник светодиодный", "Светильник светодиод"],
  });
  for (const title of [
    "Светильник светло-серый",
    "Светильник светодиодрайвер",
    "Светильник без светодиод",
    "Светильник для светодиод",
    "Светильник\nКомплект: светодиод",
  ]) assertEquals(titleSupportsVisibleRequestContract(title, contract), false);
  assertEquals(productSupportsVisibleRequestContract({
    pagetitle: "Светильник потолочный",
    short_traits: ["Описание: светильник светодиод"],
  }, contract), false);
});

Deno.test("room area is not treated as a product length", () => {
  assertEquals(buildVisibleRequestContract("светильник для гостиной 25 м²").length, 0);
});

Deno.test("installation height is application context, not exact product length", () => {
  assertEquals(
    buildVisibleRequestContract("Нужен товар для площадки, высота установки 4 м").length,
    0,
  );
  assertEquals(
    buildVisibleRequestContract("Нужен товар для монтажа на высоте 6 м").length,
    0,
  );
  assertEquals(buildVisibleRequestContract("удлинитель на 4 м").length, 1);
});

Deno.test("route length is application context while product length stays visible", () => {
  assertEquals(
    buildVisibleRequestContract(
      "Система аналоговая, улица, длина трассы 30 м",
    ).length,
    0,
  );
  assertEquals(
    buildVisibleRequestContract("расстояние до камеры 30 метров").length,
    0,
  );
  assertEquals(buildVisibleRequestContract("кабель 30 м").length, 1);
});

Deno.test("explicit place count and double socket stay visible", () => {
  const places = buildVisibleRequestContract("удлинитель на 3 места");
  assertEquals(titleSupportsVisibleRequestContract("Удлинитель У03 3 места", places), true);
  assertEquals(titleSupportsVisibleRequestContract("Удлинитель 4 гн.", places), false);

  const doubleSocket = buildVisibleRequestContract("двойные черные розетки электрические");
  assertEquals(
    doubleSocket.map(({ kind, label, op, value }) => ({ kind, label, op, value })),
    [{ kind: "count", label: "двойная розетка", op: "eq", value: 2 }],
  );
  assertEquals(titleSupportsVisibleRequestContract("Розетка двойная, цвет черный", doubleSocket), true);
  assertEquals(titleSupportsVisibleRequestContract("Розетка одинарная, цвет черный", doubleSocket), false);
  assertEquals(
    buildVisibleRequestContract("несколько двойных черных электрических розеток")
      .map(({ kind, value }) => ({ kind, value })),
    [{ kind: "count", value: 2 }],
  );
  assertEquals(buildVisibleRequestContract("двойная рамка для розетки").length, 0);
});

Deno.test("structured catalog traits prove a card attribute omitted from its title", () => {
  const contract = buildVisibleRequestContract("удлинитель на 3 места", {
    productClass: "удлинитель",
    candidateTitles: ["Удлинитель серии A"],
  });
  assertEquals(
    productSupportsVisibleRequestContract({
      pagetitle: "Удлинитель серии A",
      short_traits: ["Количество розеток: 3"],
    }, contract),
    true,
  );
  assertEquals(
    productSupportsVisibleRequestContract({
      pagetitle: "Удлинитель серии B",
      short_traits: ["Количество розеток: 4"],
    }, contract),
    false,
  );
});

Deno.test("structured outlet count proves a double socket without title wording", () => {
  const contract = buildVisibleRequestContract("двойные розетки", {
    productClass: "розетки",
    candidateTitles: ["Розетка серии G"],
  });
  assertEquals(
    productSupportsVisibleRequestContract({
      pagetitle: "Розетка серии G",
      short_traits: ["Количество разъемов: 2"],
    }, contract),
    true,
  );
  assertEquals(
    productSupportsVisibleRequestContract({
      pagetitle: "Розетка серии G",
      short_traits: ["Количество разъемов: 1"],
    }, contract),
    false,
  );
});

Deno.test("directional measurements remain visible and preserve their bound", () => {
  const contract = buildVisibleRequestContract("Покажите прожекторы мощностью от 100 Вт");
  assertEquals(titleSupportsVisibleRequestContract("Прожектор LED 150W", contract), true);
  assertEquals(titleSupportsVisibleRequestContract("Прожектор LED 100Вт", contract), true);
  assertEquals(titleSupportsVisibleRequestContract("Прожектор LED 70W", contract), false);
  assertEquals(titleSupportsVisibleRequestContract("Прожектор модель 06-150", contract), false);
});

Deno.test("strict directional measurements do not accept their boundary", () => {
  const contract = buildVisibleRequestContract("Нужен товар больше 10 А");
  assertEquals(titleSupportsVisibleRequestContract("Товар 16A", contract), true);
  assertEquals(titleSupportsVisibleRequestContract("Товар 10 А", contract), false);
});

Deno.test("currency ceilings stay in the structured price guard, not the title contract", () => {
  const contract = buildVisibleRequestContract(
    "Найди автомат до 1000 тенге 1 полюсной, 16 А характеристика C",
    {
      productClass: "автоматический выключатель",
      candidateTitles: ["Автомат 1Р 16 А х-ка С"],
    },
  );
  assertEquals(contract.some((requirement) => requirement.label.includes("1000")), false);
  assertEquals(
    titleSupportsVisibleRequestContract("Автомат 1Р 16 А х-ка С", contract),
    true,
  );
});

Deno.test("a live literal class modifier survives a later mixed recovery pool", () => {
  const contract = buildVisibleRequestContract(
    "Покажите светодиодные прожекторы мощностью от 100 Вт",
    {
      productClass: "светодиодные прожекторы",
      candidateTitles: [
        "Прожектор светодиодный 70W",
        "Прожектор ИО 150Вт",
        "Прожектор светодиодный 150Вт",
      ],
    },
  );
  assertEquals(titleSupportsVisibleRequestContract("Прожектор светодиодный 150Вт", contract), true);
  assertEquals(titleSupportsVisibleRequestContract("Прожектор светодиодный 70W", contract), false);
  assertEquals(titleSupportsVisibleRequestContract("Прожектор ИО 150Вт", contract), false);
});

Deno.test("a complete class proven by live taxonomy is not duplicated as a title modifier", () => {
  const contract = buildVisibleRequestContract(
    "подбери термоусадочную трубку для кабеля диаметром 12 мм",
    {
      productClass: "термоусадочная трубка",
      taxonomyClass: "Трубки термоусаживаемые",
      candidateTitles: ["Трубка ТТУ 16/8 мм", "Трубка термоусаживаемая 16/8 мм"],
    },
  );
  assertEquals(contract.map((requirement) => requirement.label), []);
  assertEquals(titleSupportsVisibleRequestContract("Трубка ТТУ 16/8 мм", contract), true);
});

Deno.test("a refinement absent from live taxonomy remains a visible title modifier", () => {
  const contract = buildVisibleRequestContract(
    "покажи светодиодные прожекторы мощностью от 100 Вт",
    {
      productClass: "светодиодные прожекторы",
      taxonomyClass: "Прожекторы",
      candidateTitles: ["Прожектор светодиодный 150Вт", "Прожектор ИО 150Вт"],
    },
  );
  assertEquals(contract.map((requirement) => requirement.label), ["от 100 Вт", "светодиодные"]);
});

Deno.test("a validated semantic facet mapping replaces only the duplicate literal spelling gate", () => {
  const contract = buildVisibleRequestContract(
    "покажи люминесцентные приборы мощностью от 100 Вт",
    {
      productClass: "приборы",
      taxonomyClass: "Приборы",
      candidateTitles: ["Прибор люминесцентный 150 Вт", "Прибор LX 150 Вт"],
      semanticallyMappedCustomerPhrases: ["люминесцентные"],
    },
  );
  assertEquals(contract.map((requirement) => requirement.label), ["от 100 Вт"]);
  assertEquals(titleSupportsVisibleRequestContract("Прибор LX 150 Вт", contract), true);
});

Deno.test("only the complete customer-owned live facet and frozen exact option grant spelling reconciliation", () => {
  const source = "Нужен светильник с датчиком движения";
  const valid = frozenMotionProofs(source);
  assertEquals(valid, [{
    facetKey: motionFacet.key,
    facetCaption: motionFacet.caption,
    value: "да",
  }]);
  assertEquals(frozenMotionProofs("Нужен светильник с датчиком звука"), []);
  assertEquals(deriveCustomerOwnedVisibleFacetProofs(
    source,
    [motionFacet],
    [{ key: motionFacet.caption, op: "eq", value: "да", evidence: "model_assumption" }],
    [{ key: motionFacet.key, value: "да" }],
  ), []);
  assertEquals(deriveCustomerOwnedVisibleFacetProofs(
    source,
    [motionFacet],
    [{ key: motionFacet.caption, op: "eq", value: "да", evidence: "user_explicit" }],
    [{ key: motionFacet.key, value: "нет" }],
  ), []);
  assertEquals(deriveCustomerOwnedVisibleFacetProofs(
    source,
    [motionFacet],
    [{ key: motionFacet.caption, op: "eq", value: "да", evidence: "user_explicit" }],
    [{ key: "motion_sensor_neighbor_key", value: "да" }],
  ), []);
});

Deno.test("successful exact filtered pool proves only its returned IDs and preserves raw contradictions", () => {
  const proof = frozenMotionProofs("Нужен светильник с датчиком движения");
  const lineage = new Map<string, Record<string, string[]>>();
  const criterion = [{ key: motionFacet.caption, op: "eq" as const,
    value: "да", level: "A" as const, evidence: "user_explicit" as const }];
  const exact = { mode: "by_filter", options: { [motionFacet.key]: ["да"] } };
  assertEquals(recordVerifiedCustomerFacetFilterEvidence(
    lineage, ["gauss"], exact, criterion, proof,
  ), 1);
  assertEquals(recordVerifiedCustomerFacetFilterEvidence(
    lineage, ["query-id"], {
      mode: "by_query", query: "светильник",
      options: { [motionFacet.key]: ["да"] },
    }, criterion, proof,
  ), 1);
  assertEquals(lineage.get("query-id"), { [motionFacet.key]: ["да"] });
  assertEquals(lineage.has("sibling"), false);
  assertEquals(withVerifiedCustomerFacetEvidence({
    id: "gauss", pagetitle: "Светильник Gauss с микроволновым сенсором",
  }, lineage).facet_values, { [motionFacet.key]: ["да"] });
  assertEquals(withVerifiedCustomerFacetEvidence({
    id: "gauss", pagetitle: "Светильник Gauss с микроволновым сенсором",
    facet_values: { [motionFacet.key]: ["нет"] },
  }, lineage).facet_values, { [motionFacet.key]: ["нет", "да"] });
  for (const [query, proven] of [
    [{ mode: "by_filter", options: { [motionFacet.key]: ["да", "нет"] } }, criterion],
    [{ mode: "by_filter", options: { [motionFacet.key]: ["нет"] } }, criterion],
    [{ mode: "by_filter", options: { neighbor: ["да"] } }, criterion],
    [{ mode: "by_query", query: "светильник" }, criterion],
    [exact, []],
  ] as const) {
    assertEquals(recordVerifiedCustomerFacetFilterEvidence(
      lineage, ["sibling"], query, [...proven], proof,
    ), 0);
    assertEquals(lineage.has("sibling"), false);
  }
});

Deno.test("exact motion-sensor facet proves a differently worded product per card, but not acoustic or negative evidence", () => {
  const source = "Нужен светильник с датчиком движения";
  const contract = buildVisibleRequestContract(source, {
    productClass: "Светильники",
    candidateTitles: [
      "Светильник с датчиком движения",
      "Светильник Gauss с микроволновым сенсором",
    ],
    customerOwnedFacetProofs: frozenMotionProofs(source),
  });
  assertEquals(contract.map((requirement) => requirement.label), ["датчиком"]);
  assertEquals(productSupportsVisibleRequestContract({
    pagetitle: "Светильник Gauss с микроволновым сенсором",
    short_traits: [],
    facet_values: { [motionFacet.key]: ["да"] },
  }, contract), true);
  assertEquals(productSupportsVisibleRequestRequirement({
    pagetitle: "Светильник Gauss с микроволновым сенсором",
    short_traits: [],
    facet_values: { [motionFacet.key]: ["да"] },
  }, contract[0]), true);
  assertEquals(productSupportsVisibleRequestContract({
    pagetitle: "Светильник с акустическим датчиком",
    short_traits: [],
    facet_values: { [motionFacet.key]: ["да"] },
  }, contract), false);
  assertEquals(productSupportsVisibleRequestContract({
    pagetitle: "Светильник Gauss с микроволновым сенсором",
    short_traits: [],
    facet_values: { [motionFacet.key]: ["нет"] },
  }, contract), false);
  assertEquals(productSupportsVisibleRequestContract({
    pagetitle: "Светильник Gauss с микроволновым сенсором",
    short_traits: [],
    facet_values: { motion_sensor_neighbor_key: ["да"] },
  }, contract), false);
  assertEquals(productSupportsVisibleRequestContract({
    pagetitle: "Светильник Gauss с микроволновым сенсором",
    short_traits: [],
  }, contract), false);
  assertEquals(productSupportsVisibleRequestContract({
    pagetitle: "Светильник Gauss с микроволновым сенсором",
    description_excerpt:
      "Сенсор автоматически включает прибор при появлении движущихся объектов.",
  }, contract), true);
  assertEquals(productSupportsVisibleRequestContract({
    pagetitle: "Светильник Gauss с микроволновым сенсором",
    description_excerpt:
      "Сенсор автоматически включает прибор при появлении движущихся объектов.",
    short_traits: ["С датчиком движения: нет"],
  }, contract), false);
  assertEquals(productSupportsVisibleRequestContract({
    pagetitle: "Светильник Gauss",
    description_excerpt: "Совместим с датчиком движения",
  }, contract), false);
  assertEquals(productSupportsVisibleRequestContract({
    pagetitle: "Светильник с датчиком движения",
  }, contract), true);
  assertEquals(productSupportsVisibleRequestContract({
    pagetitle: "Светильник с датчиком движения",
    short_traits: ["С датчиком движения: нет"],
  }, contract), false);
});

Deno.test("other literal qualifiers remain mandatory when a separate exact facet has alternate title wording", () => {
  const source = "Нужен светодиодный светильник с датчиком движения";
  const contract = buildVisibleRequestContract(source, {
    productClass: "Светильники",
    candidateTitles: [
      "Светильник светодиодный с датчиком движения",
      "Светильник обычный с микроволновым сенсором",
    ],
    customerOwnedFacetProofs: frozenMotionProofs(source),
  });
  assertEquals(contract.map((requirement) => requirement.label), ["светодиодный", "датчиком"]);
  assertEquals(productSupportsVisibleRequestContract({
    pagetitle: "Светильник обычный с микроволновым сенсором",
    facet_values: { [motionFacet.key]: ["да"] },
  }, contract), false);
  assertEquals(productSupportsVisibleRequestContract({
    pagetitle: "Светильник светодиодный с микроволновым сенсором",
    facet_values: { [motionFacet.key]: ["да"] },
  }, contract), true);
});

Deno.test("cross-category live facet proof is per-product and cannot erase a sibling class modifier", () => {
  const source = "Нужна бытовая розетка с крышкой";
  const coverFacet = {
    key: "cover_option",
    caption: "С крышкой",
    unit: null,
    values: [{ value: "да" }, { value: "нет" }],
  };
  const proofs = deriveCustomerOwnedVisibleFacetProofs(
    source,
    [coverFacet],
    [{ key: "С крышкой", op: "eq", value: "да", evidence: "user_explicit" }],
    [{ key: "cover_option", value: "да" }],
  );
  const contract = buildVisibleRequestContract(source, {
    productClass: "Розетки",
    candidateTitles: [
      "Бытовая розетка с крышкой",
      "Розетка для ЖКХ с защитным колпачком",
    ],
    customerOwnedFacetProofs: proofs,
  });
  assertEquals(contract.map((requirement) => requirement.label), ["бытовая", "крышкой"]);
  assertEquals(productSupportsVisibleRequestContract({
    pagetitle: "Бытовая розетка с защитным колпачком",
    facet_values: { cover_option: ["да"] },
  }, contract), true);
  assertEquals(productSupportsVisibleRequestContract({
    pagetitle: "Розетка для ЖКХ с защитным колпачком",
    facet_values: { cover_option: ["да"] },
  }, contract), false);
});

Deno.test("a measurement descriptor is not duplicated as a literal title modifier", () => {
  const contract = buildVisibleRequestContract(
    "Покажите светодиодные прожекторы мощностью от 100 Вт",
    {
      productClass: "Прожекторы",
      candidateTitles: [
        "Прожектор светодиодный мощностью 70W",
        "Прожектор светодиодный MFL 01-150 150W",
      ],
    },
  );
  assertEquals(contract.map((requirement) => requirement.label), ["от 100 Вт", "светодиодные"]);
  assertEquals(
    titleSupportsVisibleRequestContract("Прожектор светодиодный MFL 01-150 150W", contract),
    true,
  );
});

Deno.test("a modifier absent from live titles is not guessed as catalog vocabulary", () => {
  const contract = buildVisibleRequestContract(
    "Покажите умные контроллеры",
    { productClass: "Контроллеры", candidateTitles: ["Контроллер ALPHA"] },
  );
  assertEquals(titleSupportsVisibleRequestContract("Контроллер ALPHA", contract), true);
});

Deno.test("a non-empty rejected leaf permits one grounded full-text recovery", () => {
  assertEquals(shouldExpandVisibleRecoverySearch(true, 0), true);
  assertEquals(shouldExpandVisibleRecoverySearch(true, 1), false);
  assertEquals(shouldExpandVisibleRecoverySearch(false, 0), false);
});

Deno.test("visible recovery pagination is bounded and stops after confirmation", () => {
  assertEquals(shouldContinueVisibleRecoveryPage({ page: 1, pageSize: 50, total: 145, confirmedCount: 0, maxPages: 4 }), true);
  assertEquals(shouldContinueVisibleRecoveryPage({ page: 2, pageSize: 50, total: 145, confirmedCount: 2, maxPages: 4 }), false);
  assertEquals(shouldContinueVisibleRecoveryPage({ page: 3, pageSize: 50, total: 145, confirmedCount: 0, maxPages: 4 }), false);
  assertEquals(shouldContinueVisibleRecoveryPage({ page: 4, pageSize: 50, total: 500, confirmedCount: 0, maxPages: 4 }), false);
});

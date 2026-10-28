import {
  type ActiveNamedSeriesSectionScope,
  type ActiveSelectionScopeLog,
  activeSelectionScopeLookupCreatedAfter,
  classifyActivePrepositionalRefinement,
  explicitlyChangesActiveSelectionEntity,
  isIndependentNominalRequestOutsideActiveScope,
  isSameSectionNominalRefinement,
  isShortAttributeSelectionFollowup,
  isVerifiedFreeformReadinessAnswer,
  isVerifiedReadinessScopeReply,
  mayBeActivePrepositionalRefinement,
  mayBeNominalRefinement,
  productMatchesActiveSection,
  requiresProvenProductContext,
  scopeFromCompletedServerLog,
  stripClientActiveSelectionScope,
  trustedActiveSelectionScope,
} from "./active-selection-scope.ts";
import { filterProductIdsByNamedSeries } from "./category-reasoning-guard.ts";

function assertEquals(actual: unknown, expected: unknown, label = "value") {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `${label}: expected ${JSON.stringify(expected)}, got ${
        JSON.stringify(actual)
      }`,
    );
  }
}

const now = Date.parse("2026-10-12T07:00:00.000Z");
const scope: ActiveNamedSeriesSectionScope = {
  kind: "named_series_section",
  entity: "Gallant",
  leaf: "Розетки",
  source_slot_id: "gallant-catalog-chip",
};

function completedLog(
  overrides: Partial<ActiveSelectionScopeLog> = {},
): ActiveSelectionScopeLog {
  return {
    session_id: "session_gallant",
    created_at: "2026-10-12T06:59:00.000Z",
    error: null,
    response_events: [
      { type: "diagnostic", phase: "start", log_id: "chip-log" },
      { type: "products_block", count: 5 },
      { type: "active_selection_scope", scope },
      { type: "diagnostic", phase: "complete", products_count: 5 },
      { type: "done" },
    ],
    ...overrides,
  };
}

Deno.test("completed chip scope survives a widget reload and a later same-section refinement", () => {
  // The third browser request may have no pending slot at all. The only
  // authority here is the immediately previous completed server response.
  const afterChip = scopeFromCompletedServerLog(
    completedLog(),
    "session_gallant",
    now,
  );
  assertEquals(afterChip, scope);
  assertEquals(
    isSameSectionNominalRefinement("двойные электрические розетки", afterChip!),
    true,
  );
  assertEquals(
    trustedActiveSelectionScope({ __server_active_selection_scope: afterChip }),
    scope,
  );

  // A completed continuation reissues the identical verified scope, so a
  // second narrowing turn does not depend on the spent quick-reply slot.
  const nextLog = completedLog({
    response_events: [
      { type: "diagnostic", phase: "start", log_id: "refinement-log" },
      { type: "active_selection_scope", scope: afterChip },
      { type: "diagnostic", phase: "complete", products_count: 4 },
      { type: "done" },
    ],
  });
  assertEquals(
    scopeFromCompletedServerLog(nextLog, "session_gallant", now),
    scope,
  );
  assertEquals(productMatchesActiveSection("Розетки", scope), true);
  assertEquals(productMatchesActiveSection("Выключатели", scope), false);
});

Deno.test("the active scope is never inferred from an unfinished, stale, foreign or failed log", () => {
  assertEquals(
    scopeFromCompletedServerLog(completedLog(), "session_other", now),
    null,
  );
  assertEquals(
    scopeFromCompletedServerLog(
      completedLog({ error: "request_timeout" }),
      "session_gallant",
      now,
    ),
    null,
  );
  assertEquals(
    scopeFromCompletedServerLog(
      completedLog({ created_at: "2026-10-12T06:20:00.000Z" }),
      "session_gallant",
      now,
    ),
    null,
  );
  assertEquals(
    scopeFromCompletedServerLog(
      completedLog({
        response_events: [
          { type: "active_selection_scope", scope },
          { type: "diagnostic", phase: "complete" },
        ],
      }),
      "session_gallant",
      now,
    ),
    null,
  );
  assertEquals(
    scopeFromCompletedServerLog(
      completedLog({
        response_events: [
          { type: "active_selection_scope", scope },
          { type: "diagnostic", phase: "complete", error: "internal_error" },
          { type: "done" },
        ],
      }),
      "session_gallant",
      now,
    ),
    null,
  );
  assertEquals(
    scopeFromCompletedServerLog(
      completedLog({
        response_events: [
          { type: "diagnostic", phase: "complete" },
          { type: "done" },
        ],
      }),
      "session_gallant",
      now,
    ),
    null,
  );
});

Deno.test("scope lookup is bounded to the scope TTL, independently of browser history", () => {
  assertEquals(
    activeSelectionScopeLookupCreatedAfter(now),
    "2026-10-12T06:30:00.000Z",
  );
});

Deno.test("a server-issued readiness chip carries the active identity through a short reply", () => {
  const issuedSlot = {
    status: "pending",
    slot_id: "ready-1",
    facet_key: "socket_color",
    options: [
      { value: "Чёрный", label: "Чёрный" },
      { value: "Графит", label: "Графит" },
    ],
    scope: { kind: "selection_readiness", token: "двойные розетки" },
  };
  const afterReadiness = completedLog({
    response_events: [
      { type: "active_selection_scope", scope },
      { type: "slot_update", slots: { pending_clarification: issuedSlot } },
      { type: "diagnostic", phase: "complete", products_count: 0 },
      { type: "done" },
    ],
  });
  assertEquals(
    scopeFromCompletedServerLog(afterReadiness, "session_gallant", now),
    scope,
  );
  assertEquals(isVerifiedReadinessScopeReply("Графит", issuedSlot, false), true);
  assertEquals(isVerifiedReadinessScopeReply("Чёрный", issuedSlot, false), true);
  assertEquals(isVerifiedReadinessScopeReply("Люстра", issuedSlot, false), false);
  assertEquals(
    isVerifiedReadinessScopeReply("Найди графитовые люстры", issuedSlot, false),
    false,
  );
  assertEquals(isVerifiedReadinessScopeReply("Графит", issuedSlot, true), false);
});

Deno.test("free-form readiness answer carries scope but a fresh command does not", () => {
  const slot = {
    status: "pending",
    slot_id: "ready-freeform-1",
    options: [],
    scope: { kind: "selection_readiness", token: "розетки Gallant" },
  };
  assertEquals(isVerifiedReadinessScopeReply("с заземлением", slot, false), true);
  assertEquals(isVerifiedReadinessScopeReply("12 м², высота 4 м", slot, false), true);
  assertEquals(isVerifiedReadinessScopeReply("Нужно 5кВт", slot, false), true);
  assertEquals(isVerifiedReadinessScopeReply("Найди кабель ВВГ", slot, false), false);
  assertEquals(isVerifiedReadinessScopeReply("Новая тема: кабель", slot, false), false);
});

Deno.test("only an answer to the verified free-form question suppresses a nominal class boundary", () => {
  const freeformSlot = (question: string, facet_key: string) => ({
    status: "pending",
    slot_id: `readiness-${facet_key}`,
    question,
    facet_key,
    options: [],
    scope: { kind: "selection_readiness", token: "проверенный выбор" },
  });
  const conductorSlot = freeformSlot("Сколько жил нужно для кабеля?", "conductor_count");
  for (const message of [
    "Нужны 3 жилы",
    "Мне нужны 3 жилы",
    "3 жилы",
    "Нужны 3 жилы, 16 А",
  ]) {
    assertEquals(
      isVerifiedFreeformReadinessAnswer(message, conductorSlot),
      true,
      message,
    );
  }
  assertEquals(
    isVerifiedFreeformReadinessAnswer("Нужны 3 прожектора", conductorSlot),
    false,
    "a different product class with the same count is a new request",
  );
  assertEquals(
    isVerifiedFreeformReadinessAnswer("Нужны 3 прожектора и 16 А", conductorSlot),
    false,
    "an unrelated product head cannot be hidden in a composite specification",
  );
  for (const message of [
    "Нужны 3 жилы, а ещё прожектор",
    "Нужны 3 жилы и новый прожектор",
  ]) {
    assertEquals(
      isVerifiedFreeformReadinessAnswer(message, conductorSlot),
      false,
      `another product request must not be absorbed as ${message}`,
    );
  }
  assertEquals(
    isVerifiedFreeformReadinessAnswer("Нужны 3 жилы", {
      ...conductorSlot,
      scope: {
        kind: "selection_readiness",
        token: "Кабель в землю: сколько жил нужно?",
      },
    }),
    true,
    "the original request may mention the same attribute later asked in the verified question",
  );
  assertEquals(
    isVerifiedFreeformReadinessAnswer("Нужны 120 м²", freeformSlot(
      "Какая площадь освещаемой части двора в м²?",
      "illuminated_area",
    )),
    true,
  );
  assertEquals(
    isVerifiedFreeformReadinessAnswer("Нужны 120 м² и высота 4 м", freeformSlot(
      "Какая площадь освещаемой части двора в м²?",
      "illuminated_area",
    )),
    true,
  );
  assertEquals(
    isVerifiedFreeformReadinessAnswer("16 А", freeformSlot(
      "Какой номинальный ток нужен в амперах?",
      "rated_current",
    )),
    true,
  );
  const earthingSlot = freeformSlot("Нужно ли заземление?", "earthing");
  const useLocationSlot = freeformSlot(
    "Где будет использоваться розетка?",
    "use_location",
  );
  assertEquals(
    isVerifiedFreeformReadinessAnswer("Нужны с заземлением", earthingSlot),
    true,
  );
  assertEquals(
    isVerifiedFreeformReadinessAnswer("с заземлением", earthingSlot),
    true,
  );
  assertEquals(
    isVerifiedFreeformReadinessAnswer("Нужны для кухни", useLocationSlot),
    true,
  );
  assertEquals(
    isVerifiedFreeformReadinessAnswer("Нужны для новой кухни", useLocationSlot),
    true,
    "an adjective modifying the destination is not a second product request",
  );
  assertEquals(
    isVerifiedFreeformReadinessAnswer(
      "Нужны для новой линии",
      freeformSlot("Для какой линии нужен кабель?", "line_purpose"),
    ),
    true,
    "a new installation line remains an answer to the verified purpose question",
  );
  for (const [message, slot] of [
    ["Нужны для кухни и новые светильники", useLocationSlot],
    ["Нужны с заземлением и новые светильники", earthingSlot],
    ["Нужны для кухни 3 светильника", useLocationSlot],
  ] as const) {
    assertEquals(
      isVerifiedFreeformReadinessAnswer(message, slot),
      false,
      `an independent product request must not hide after ${message}`,
    );
  }
});

Deno.test("free-form answer protection needs a genuine pending question and never overrides explicit new tasks or chips", () => {
  const slot = {
    status: "pending",
    slot_id: "readiness-conductor-count",
    question: "Сколько жил нужно для кабеля?",
    facet_key: "conductor_count",
    options: [],
    scope: { kind: "selection_readiness", token: "кабель" },
  };
  for (const message of [
    "Новая тема: нужны 3 жилы",
    "Новый вопрос: 3 жилы",
    "Найди 3-жильный кабель другого бренда",
  ]) {
    assertEquals(isVerifiedFreeformReadinessAnswer(message, slot), false, message);
  }
  assertEquals(isVerifiedFreeformReadinessAnswer("3 жилы", null), false);
  assertEquals(
    isVerifiedFreeformReadinessAnswer("3 жилы", {
      ...slot,
      scope: { kind: "catalog_section", token: "кабель" },
    }),
    false,
    "a different scope kind cannot authorize a readiness answer",
  );
  assertEquals(
    isVerifiedFreeformReadinessAnswer("3 жилы", { ...slot, question: "" }),
    false,
    "a fabricated question-less slot cannot authorize a readiness answer",
  );
  assertEquals(
    isVerifiedFreeformReadinessAnswer("3 жилы", {
      ...slot,
      options: [{ value: "3 жилы", label: "3 жилы" }],
    }),
    false,
    "issued chips are handled by exact chip matching, not free-form suppression",
  );
});

Deno.test("grounding facts continue only the server-verified free-form PE question", () => {
  const slot = {
    status: "pending",
    slot_id: "server-grounding-1",
    question: "Укажите наличие защитной жилы/заземления конкретным значением.",
    facet_key: "grounding_presence",
    options: [],
    scope: {
      kind: "selection_readiness",
      token: "Какой кабель подойдет для прокладки в земле?",
    },
  };
  for (const message of [
    "Да, одна из трёх жил — защитная PE",
    "Заземление есть",
    "Заземления нет",
    "Без PE",
  ]) {
    assertEquals(isVerifiedFreeformReadinessAnswer(message, slot), true, message);
  }
  for (const message of [
    "Заземление есть?",
    "Не знаю, есть ли заземление",
    "Заземление есть, найди прожектор",
    "Новая тема: заземление есть",
  ]) {
    assertEquals(isVerifiedFreeformReadinessAnswer(message, slot), false, message);
  }
  assertEquals(isVerifiedFreeformReadinessAnswer("Заземление есть", null), false);
  assertEquals(isVerifiedFreeformReadinessAnswer("Заземление есть", {
    ...slot,
    options: [{ label: "Да", value: "Да" }],
  }), false);
  assertEquals(isVerifiedFreeformReadinessAnswer("Заземление есть", {
    ...slot,
    facet_key: "core_count",
  }), false);
});

Deno.test("a verified free-form answer bypasses stale-card hints, not actual references or unverified slots", () => {
  const signals = {
    renderedReferenceRequested: false,
    browserHasRenderedCard: false,
    staleCachePresent: true,
    localFollowupReference: true,
    ellipticalAttributeFollowup: false,
    verifiedFreeformReadinessAnswer: true,
  };
  assertEquals(requiresProvenProductContext(signals), false);
  assertEquals(requiresProvenProductContext({
    ...signals,
    verifiedFreeformReadinessAnswer: false,
  }), true);
  assertEquals(requiresProvenProductContext({
    ...signals,
    renderedReferenceRequested: true,
  }), true);
  assertEquals(requiresProvenProductContext({
    ...signals,
    verifiedFreeformReadinessAnswer: false,
    staleCachePresent: false,
    localFollowupReference: false,
    ellipticalAttributeFollowup: true,
  }), true);
});

Deno.test("a progressive multi-facet question accepts a partial conductor answer without changing product class", () => {
  const slot = {
    status: "pending",
    slot_id: "readiness-core-and-section",
    question:
      "Осталось уточнить: назначение и подключаемое оборудование; сечение и число жил. Укажите сечение и число жил конкретным значением — без этих данных подбор кабеля будет неточным.",
    facet_key: "core_and_section",
    options: [],
    scope: { kind: "selection_readiness", token: "кабель КГ для подключения" },
  };
  for (const message of [
    "Нужны 3 жилы",
    "Нужны 3 жилы и 1,5 мм²",
    "Нужны 3 жилы и сечение 1,5 мм²",
    "Мне нужны 3 жилы и сечение 1,5 мм²",
    "3х1,5 мм²",
    "Нужны 3х1,5 мм²",
    "А, мне нужны 3х1,5 мм²",
    "Ну, нужны 3х1,5 мм²",
    "Тогда 3х1,5 мм²",
  ]) {
    assertEquals(isVerifiedFreeformReadinessAnswer(message, slot), true, message);
  }
  assertEquals(
    isVerifiedFreeformReadinessAnswer("Нужны 3 прожектора", slot),
    false,
    "a different product class must not inherit the cable clarification",
  );
  assertEquals(
    isVerifiedFreeformReadinessAnswer("3х1,5 мм² и прожектор", slot),
    false,
    "a second product cannot be hidden after a compact cable specification",
  );
  assertEquals(
    isVerifiedFreeformReadinessAnswer("Новая тема: 3х1,5 мм²", slot),
    false,
    "an explicit topic boundary remains authoritative despite matching dimensions",
  );
});

Deno.test("a verified line-length question accepts quantitative modifiers but not a new product", () => {
  const slot = {
    status: "pending",
    slot_id: "readiness-line-length",
    question: "Какая длина линии от источника питания до насоса?",
    facet_key: "line_length",
    options: [],
    scope: { kind: "selection_readiness", token: "кабель питания насоса" },
  };
  for (const message of [
    "Нужно около 30 м",
    "Примерно 30 м",
    "Нужны до 30 м",
    "Нужны не более 30 м",
    "От 10 до 20 м",
  ]) {
    assertEquals(isVerifiedFreeformReadinessAnswer(message, slot), true, message);
  }
  for (const message of [
    "Около 30 прожекторов",
    "Нужны около 30 м и прожектор",
  ]) {
    assertEquals(isVerifiedFreeformReadinessAnswer(message, slot), false, message);
  }
});

Deno.test("a short numeric readiness answer does not become a new product selection", () => {
  assertEquals(isSameSectionNominalRefinement("Нужно 5кВт", scope), false);
  assertEquals(
    isIndependentNominalRequestOutsideActiveScope("Нужно 5кВт", scope),
    false,
  );
  assertEquals(
    explicitlyChangesActiveSelectionEntity("Нужно 5кВт", scope),
    false,
  );
});

Deno.test("a same-section refinement inherits Gallant with or without a selection command", () => {
  assertEquals(mayBeNominalRefinement("двойные электрические розетки"), true);
  assertEquals(
    mayBeNominalRefinement("Найди двойные электрические розетки"),
    true,
  );
  for (
    const message of [
      "двойные электрические розетки",
      "Найди двойные электрические розетки",
      "Покажи двойные розетки",
      "Покажи ассортимент двойных розеток",
      "А подбери кухонные двойные розетки",
      "Покажи розетки двойные",
      "А есть чёрные двойные розетки?",
      "другие двойные розетки",
      "двойные розетки Gallant",
      "найди двойные розетки Галлант",
    ]
  ) {
    assertEquals(isSameSectionNominalRefinement(message, scope), true, message);
  }
});

Deno.test("generic request prefaces are recognized as same-section refinements", () => {
  for (
    const message of [
      "Нужны двойные чёрные розетки",
      "А нужны двойные чёрные розетки",
      "Ну нужны двойные чёрные розетки",
      "Мне нужны двойные чёрные розетки",
      "Хочу купить двойные чёрные розетки",
      "Покажите мне двойные чёрные розетки",
      "Подберите мне двойные чёрные розетки",
      "Найдите нам двойные чёрные розетки",
    ]
  ) {
    assertEquals(mayBeNominalRefinement(message), true, message);
    assertEquals(
      isSameSectionNominalRefinement(message, scope),
      true,
      message,
    );
    assertEquals(
      explicitlyChangesActiveSelectionEntity(message, scope),
      false,
      message,
    );
    assertEquals(
      isIndependentNominalRequestOutsideActiveScope(message, scope),
      false,
      message,
    );
  }
});

Deno.test("request prefaces do not carry scope into a different section, entity or explicit topic", () => {
  for (
    const message of [
      "Нужны прожекторы",
      "А нужны прожекторы",
      "Нужен кабель",
      "Ну нужен кабель",
      "Нужны двойные выключатели",
      "Хочу купить двойные выключатели",
      "Покажите мне двойные выключатели",
      "Подберите мне двойные выключатели",
    ]
  ) {
    assertEquals(
      isSameSectionNominalRefinement(message, scope),
      false,
      message,
    );
    assertEquals(
      isIndependentNominalRequestOutsideActiveScope(message, scope),
      true,
      message,
    );
  }
  for (
    const message of [
      "Нужны двойные розетки Legrand",
      "А нужны двойные розетки Legrand",
      "Хочу купить двойные розетки Legrand",
      "Покажите мне двойные розетки Legrand",
      "Подберите мне двойные розетки без Gallant",
      "Ну нужны двойные розетки без Gallant",
      "Новая тема: нужны двойные чёрные розетки",
    ]
  ) {
    assertEquals(
      isSameSectionNominalRefinement(message, scope),
      false,
      message,
    );
  }
  assertEquals(
    explicitlyChangesActiveSelectionEntity(
      "Нужны двойные розетки Legrand",
      scope,
    ),
    true,
  );
  assertEquals(
    explicitlyChangesActiveSelectionEntity(
      "А нужны двойные розетки Legrand",
      scope,
    ),
    true,
  );
  assertEquals(
    explicitlyChangesActiveSelectionEntity(
      "Подберите мне двойные розетки без Gallant",
      scope,
    ),
    true,
  );
});

Deno.test("a short adjectival follow-up may refine a verified scope without inventing a new noun", () => {
  for (
    const message of [
      "а есть черные?",
      "Покажи белые",
      "двойные",
      "Нужны двойные",
      "А мне нужны двойные?",
      "Хочу двойные",
      "Хочу купить двойные",
      "Покажи двойные",
      "Подбери двойные",
      "Ну покажите более дорогие",
    ]
  ) {
    assertEquals(isShortAttributeSelectionFollowup(message), true, message);
    assertEquals(
      isIndependentNominalRequestOutsideActiveScope(message, scope),
      false,
      `an adjectival ellipsis must not change the verified product class: ${message}`,
    );
  }
  for (
    const message of [
      "а есть черные светильники?",
      "покажи кабели",
      "найди люстру",
      "нужны двойные выключатели",
      "хочу двойные розетки Legrand",
      "покажи двойные розетки без Gallant",
      "Новая тема: нужны двойные",
      "новая тема: розетки",
      "для кухни",
    ]
  ) {
    assertEquals(isShortAttributeSelectionFollowup(message), false, message);
  }
  assertEquals(
    isIndependentNominalRequestOutsideActiveScope(
      "нужны двойные выключатели",
      scope,
    ),
    true,
    "a new product class still breaks the old server scope",
  );
  assertEquals(
    explicitlyChangesActiveSelectionEntity(
      "хочу двойные розетки Legrand",
      scope,
    ),
    true,
    "a named replacement still breaks the old server scope",
  );
  const noScope = scopeFromCompletedServerLog(
    completedLog({
      response_events: [
        { type: "diagnostic", phase: "complete" },
        { type: "done" },
      ],
    }),
    "session_gallant",
    now,
  );
  assertEquals(noScope, null);
  assertEquals(
    Boolean(noScope && isShortAttributeSelectionFollowup("нужны двойные")),
    false,
    "syntax alone never supplies an unverified product identity",
  );
  assertEquals(
    isIndependentNominalRequestOutsideActiveScope(
      "нужны накладные",
      {
        kind: "named_series_section",
        entity: "Example",
        leaf: "Светильники",
        source_slot_id: "other_verified_slot",
      },
    ),
    false,
    "the same short-refinement grammar must work beyond sockets",
  );
});

Deno.test("short relation phrases continue only the server-verified Gallant leaf", () => {
  for (
    const message of [
      "для кухни",
      "с заземлением",
      "розетки с заземлением",
      "двойные розетки для кухни",
      "Найди двойные розетки для кухни",
      "А подбери двойные розетки для кухни",
      "Нужны двойные розетки для кухни",
    ]
  ) {
    assertEquals(mayBeActivePrepositionalRefinement(message), true, message);
    assertEquals(
      classifyActivePrepositionalRefinement(message, scope),
      "continue",
      message,
    );
  }
});

Deno.test("a dependent phrase naming another brand asks for clarification rather than unscoped cards", () => {
  for (
    const message of [
      "для Legrand",
      "для легранд",
      "розетки для Legrand",
      "двойные розетки для Legrand",
      "для серии Legrand",
      "для другого бренда",
    ]
  ) {
    assertEquals(mayBeActivePrepositionalRefinement(message), true, message);
    assertEquals(
      classifyActivePrepositionalRefinement(message, scope),
      "ambiguous",
      message,
    );
  }
});

Deno.test("an independent product noun, named replacement, or explicit new topic never becomes a relation continuation", () => {
  for (
    const message of [
      "найди двойные выключатели",
      "найди двойные выключатели для кухни",
      "найди двойные розетки Legrand",
      "Новая тема: найди двойные розетки для кухни",
    ]
  ) {
    assertEquals(
      classifyActivePrepositionalRefinement(message, scope),
      "not_applicable",
      message,
    );
  }
  assertEquals(
    isIndependentNominalRequestOutsideActiveScope(
      "найди двойные выключатели для кухни",
      scope,
    ),
    true,
  );
});

Deno.test("selection commands do not inherit Gallant without a product refinement or across a new topic", () => {
  for (
    const message of [
      "Новая тема: подбери кабель ВВГ 3×1,5",
      "Новая тема: найди двойные розетки",
      "Найди розетки",
      "Покажи розетки Gallant",
      "Покажи ассортимент розеток",
      "двойные электрические выключатели",
      "Найди двойные выключатели",
      "двойные розетки Schneider Electric",
      "Найди двойные розетки Legrand",
      "Покажи двойные розетки Легранд",
      "найди двойные розетки легранд",
      "найди легранд двойные розетки",
      "найди двойные розетки не Gallant",
      "найди двойные розетки не галлант",
      "найди не галант двойные розетки",
      "двойные розетки серии Schneider",
      "Найди двойные розетки другой марки",
      "двойные розетки без Gallant",
      "А подбери двойные розетки для кухни",
    ]
  ) {
    assertEquals(
      isSameSectionNominalRefinement(message, scope),
      false,
      message,
    );
  }
});

Deno.test("a new named entity defeats stale readiness context without a brand dictionary", () => {
  for (
    const message of [
      "найди двойные розетки Legrand",
      "найди двойные розетки легранд",
      "найди легранд двойные розетки",
      "найди двойные розетки не Gallant",
      "найди двойные розетки не галант",
      "двойные розетки серии Schneider",
      "покажи серию Schneider",
    ]
  ) {
    assertEquals(
      explicitlyChangesActiveSelectionEntity(message, scope),
      true,
      message,
    );
  }
  for (
    const message of [
      "двойные розетки Gallant",
      "найди двойные розетки Галлант",
      "двойные розетки для кухни",
      "розетки с заземлением",
      "двойные розетки IP44",
      "найди кабель ВВГ",
    ]
  ) {
    assertEquals(
      explicitlyChangesActiveSelectionEntity(message, scope),
      false,
      message,
    );
  }
});

Deno.test("a new product noun breaks stale readiness while the same Gallant leaf and chips continue", () => {
  for (
    const message of [
      "найди двойные выключатели",
      "двойные электрические выключатели",
      "найди кабель ВВГ",
      "найди двойные розетки Legrand",
    ]
  ) {
    assertEquals(
      isIndependentNominalRequestOutsideActiveScope(message, scope),
      true,
      message,
    );
  }
  for (
    const message of [
      "найди двойные розетки",
      "двойные электрические розетки",
      "А есть чёрные двойные розетки?",
      "покажи другие варианты",
      "для кухни",
      "розетки с заземлением",
      "Новая тема: найди двойные выключатели",
      "Розетки",
    ]
  ) {
    assertEquals(
      isIndependentNominalRequestOutsideActiveScope(message, scope),
      false,
      message,
    );
  }
});

Deno.test("a boundary-rotated session may read only its own completed server event", () => {
  const rotated = completedLog({
    session_id: "session_transport_before_boundary",
    response_events: [
      {
        type: "conversation_boundary",
        mode: "new_task",
        session_id: "session_gallant",
      },
      { type: "active_selection_scope", scope },
      { type: "diagnostic", phase: "complete" },
      { type: "done" },
    ],
  });
  assertEquals(
    scopeFromCompletedServerLog(rotated, "session_gallant", now),
    scope,
  );
  assertEquals(
    scopeFromCompletedServerLog(rotated, "session_unrelated", now),
    null,
  );
});

Deno.test("a browser-carried internal scope key is stripped before routing", () => {
  const browserSlots = {
    __server_active_selection_scope: scope,
    pending_clarification: { status: "pending", facet_key: "color" },
  };
  const clean = stripClientActiveSelectionScope(browserSlots);
  assertEquals(trustedActiveSelectionScope(clean), null);
  assertEquals(clean.pending_clarification, browserSlots.pending_clarification);
  assertEquals(browserSlots.__server_active_selection_scope, scope);
});

Deno.test("the final card proof intersects active leaf and entity even with a conflicting named token", () => {
  const products = new Map([
    ["gallant-socket", {
      leaf_category: "Розетки",
      pagetitle: "Розетка двойная Gallant",
    }],
    ["other-socket", {
      leaf_category: "Розетки",
      pagetitle: "Розетка двойная Schneider",
    }],
    ["gallant-switch", {
      leaf_category: "Выключатели",
      pagetitle: "Выключатель Gallant",
    }],
  ]);
  const leafSafe = [...products.keys()].filter((id) =>
    productMatchesActiveSection(products.get(id)?.leaf_category, scope)
  );
  const scopeSafe = filterProductIdsByNamedSeries(
    leafSafe,
    products,
    scope.entity,
  );
  assertEquals(scopeSafe, ["gallant-socket"]);
  assertEquals(
    filterProductIdsByNamedSeries(scopeSafe, products, "Schneider"),
    [],
  );
});

import {
  type ActiveNamedSeriesSectionScope,
  type ActiveSelectionScopeLog,
  activeSelectionScopeLookupCreatedAfter,
  classifyActivePrepositionalRefinement,
  explicitlyChangesActiveSelectionEntity,
  isIndependentNominalRequestOutsideActiveScope,
  isSameSectionNominalRefinement,
  isShortAttributeSelectionFollowup,
  isVerifiedReadinessScopeReply,
  mayBeActivePrepositionalRefinement,
  mayBeNominalRefinement,
  productMatchesActiveSection,
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
  for (const message of ["а есть черные?", "Покажи белые", "двойные"]) {
    assertEquals(isShortAttributeSelectionFollowup(message), true, message);
  }
  for (
    const message of [
      "а есть черные светильники?",
      "покажи кабели",
      "найди люстру",
      "новая тема: розетки",
      "для кухни",
    ]
  ) {
    assertEquals(isShortAttributeSelectionFollowup(message), false, message);
  }
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

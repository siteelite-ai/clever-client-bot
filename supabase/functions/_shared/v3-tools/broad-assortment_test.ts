import {
  assert,
  assertEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  broadAssortmentNeedsClarification,
  buildBroadAssortmentClarification,
  collectVerifiedBroadAssortmentProducts,
  extractBroadAssortmentScope,
  filterVerifiedBroadAssortmentProducts,
  isBroadAssortmentRequest,
  isPlainBroadAssortmentRequest,
  rehydrateVerifiedBroadAssortmentProducts,
  resolveBroadAssortmentChoiceAfterReadRace,
  resolvePendingBroadAssortmentScope,
  resolveServerIssuedBroadAssortmentChoice,
  resolveServerIssuedBroadAssortmentPending,
  shouldResetUnverifiedBroadAssortmentTask,
} from "./broad-assortment.ts";
import type { DiscoverCategoryOk, ProductRef } from "./types.ts";
import {
  classifyConversationBoundary,
  shouldStartNewConversation,
} from "./conversation-boundary.ts";

const discover: DiscoverCategoryOk = {
  ok: true,
  category: { id: 1, pagetitle: "Gallant", total_products: 84 },
  facets: [],
  leaf_categories: [
    { id: 2, pagetitle: "Розетки" },
    { id: 3, pagetitle: "Выключатели" },
  ],
};

Deno.test("broad assortment is structural and does not capture an exact all-items filter", () => {
  assert(isBroadAssortmentRequest("покажи ассортимент Gallant на сайте"));
  assertEquals(
    isBroadAssortmentRequest("покажи все позиции ВВГнг 3×1,5"),
    false,
  );
  assert(broadAssortmentNeedsClarification(true, discover, 3));
  assert(buildBroadAssortmentClarification(discover).includes("Розетки"));
});

Deno.test("broad assortment scope is extracted structurally without a brand dictionary", () => {
  assertEquals(
    extractBroadAssortmentScope("покажи ассортимент Gallant на сайте"),
    "Gallant",
  );
  assertEquals(
    extractBroadAssortmentScope(
      "Покажи ассортимент бренда Schneider Electric в каталоге",
    ),
    "Schneider Electric",
  );
  assertEquals(
    extractBroadAssortmentScope("покажи весь модельный ряд «Atlas Design»"),
    "Atlas Design",
  );
  assertEquals(
    extractBroadAssortmentScope("покажи ассортимент на сайте"),
    null,
  );
});

Deno.test("pending broad scope is accepted only when customer history proves it", () => {
  const slots = {
    pending_clarification: {
      question: "Какой раздел?",
      options: ["Розетки", "Выключатели"],
      scope: { kind: "broad_assortment", token: "Gallant" },
    },
  };
  assertEquals(
    resolvePendingBroadAssortmentScope(slots, [
      { role: "user", content: "покажи ассортимент Gallant на сайте" },
      { role: "assistant", content: "Какой раздел?" },
    ]),
    "Gallant",
  );
  assertEquals(
    resolvePendingBroadAssortmentScope(slots, [
      { role: "user", content: "покажи ассортимент другой марки" },
    ]),
    null,
  );
});

function completedChoiceLog(
  entity: string,
  options = ["Розетки", "Выключатели"],
  slotId = "server-slot-1",
) {
  return {
    session_id: "session-A",
    user_query: `покажи ассортимент ${entity} на сайте`,
    error: null,
    response_events: [
      {
        type: "slot_update",
        slots: {
          pending_clarification: {
            status: "pending",
            slot_id: slotId,
            facet_key: "catalog_section",
            question: "Какой раздел?",
            options: options.map((value) => ({ value, label: value })),
            scope: { kind: "broad_assortment", token: entity },
          },
        },
      },
      { type: "diagnostic", phase: "complete", error: null },
      { type: "done" },
    ],
  };
}

function product(id: string, title: string, leaf: string): ProductRef {
  return {
    id,
    pagetitle: title,
    leaf_category: leaf,
    vendor: null,
    price: 100,
    stock: "in_stock",
    short_traits: [],
  };
}

Deno.test("server-issued section choice binds generic entity and exact leaf", () => {
  const log = completedChoiceLog("Atlas", ["Раздел X", "Раздел Y"]);
  const choice = resolveServerIssuedBroadAssortmentChoice(
    {
      pending_clarification: {
        slot_id: "server-slot-1",
        facet_key: "catalog_section",
      },
    },
    log,
    "Раздел X",
    "session-A",
  );
  assertEquals(choice?.entity, "Atlas");
  assertEquals(choice?.leaf, "Раздел X");
  assertEquals(choice?.exact, true);
  assertEquals(
    filterVerifiedBroadAssortmentProducts([
      product("1", "Atlas model 1", "Раздел X"),
      product("2", "Atlas model 2", "Раздел Y"),
      product("3", "Other model", "Раздел X"),
    ], choice!),
    [product("1", "Atlas model 1", "Раздел X")],
  );
});

Deno.test("plain broad request alone may use the bounded exact-chip route", () => {
  assert(isPlainBroadAssortmentRequest(
    "покажи ассортимент Gallant на сайте",
    "Gallant",
  ));
  // Multiword names cannot be separated from added attributes by syntax
  // alone; the ordinary criteria-aware route handles them instead.
  assertEquals(
    isPlainBroadAssortmentRequest(
      "покажи весь модельный ряд «Atlas Design»",
      "Atlas Design",
    ),
    false,
  );
  assertEquals(
    isPlainBroadAssortmentRequest(
      "покажи ассортимент бренда Schneider Electric в каталоге",
      "Schneider Electric",
    ),
    false,
  );
});

Deno.test("original broad-turn constraints block the exact-chip shortcut but keep its verified continuation", async () => {
  const slots = {
    pending_clarification: {
      slot_id: "server-slot-1",
      facet_key: "catalog_section",
    },
  };
  const cases = [
    ["Gallant", "покажи ассортимент Gallant на сайте, только в наличии"],
    ["Gallant до 1000", "покажи ассортимент Gallant до 1000 тенге"],
    ["Gallant черные", "покажи ассортимент Gallant черные"],
    ["Gallant без рамок", "покажи ассортимент Gallant без рамок"],
    [
      "Gallant",
      "покажи ассортимент Gallant для совместимости с механизмом W507",
    ],
    ["Schneider Electric", "покажи ассортимент Schneider Electric на сайте"],
  ] as const;
  for (const [entity, userQuery] of cases) {
    const log = { ...completedChoiceLog(entity), user_query: userQuery };
    const resolved = await resolveBroadAssortmentChoiceAfterReadRace(
      slots,
      "Розетки",
      "session-A",
      async () => ({ row: log, error: false }),
    );
    assertEquals(resolved.choice, null, userQuery);
    assertEquals(resolved.matchedIssuedOption, true, userQuery);
    assertEquals(resolved.verifiedSlot?.scope, {
      kind: "broad_assortment",
      token: entity,
    }, userQuery);
  }
});

Deno.test("a rotated new-topic session binds the chip without changing replay transport session", () => {
  // Turn 1 used session-A for an unrelated product. Turn 2 is a new broad
  // Gallant task: its durable log stays under session-A for replay, while its
  // response rotates the widget to session-B. Turn 3 sends the chip under B.
  const original = completedChoiceLog("Gallant");
  const log = {
    ...original,
    response_events: [{
      type: "conversation_boundary",
      mode: "new_task",
      session_id: "session-B",
    }, ...original.response_events],
  };
  const slots = { pending_clarification: { slot_id: "server-slot-1" } };
  assertEquals(log.session_id, "session-A");
  assertEquals(
    resolveServerIssuedBroadAssortmentChoice(
      slots,
      log,
      "Розетки",
      "session-B",
    )?.leaf,
    "Розетки",
  );
  assertEquals(
    resolveServerIssuedBroadAssortmentChoice(
      slots,
      log,
      "Розетки",
      "session-C",
    ),
    null,
  );
  // Original request replay still compares against session-A, untouched.
  assertEquals(log.session_id, "session-A");
});

Deno.test("established series proof accepts Cyrillic request and Latin title without relaxing leaf", () => {
  const choice = { entity: "Галант", leaf: "Розетки" };
  assertEquals(
    filterVerifiedBroadAssortmentProducts([
      product("1", "Розетка Gallant/W507", "Розетки"),
      product("2", "Выключатель Gallant/W508", "Выключатели"),
      product("3", "Розетка другой серии", "Розетки"),
    ], choice).map((entry) => entry.id),
    ["1"],
  );
});

Deno.test("final rendering rehydrates current cache before exact-axis verification", () => {
  const choice = { entity: "Atlas", leaf: "Розетки" };
  const selected = product("1", "Atlas socket", "Розетки");
  const cache = new Map<string, ProductRef>([["1", selected]]);
  cache.set("1", product("1", "Atlas switch", "Выключатели"));
  assertEquals(
    rehydrateVerifiedBroadAssortmentProducts(
      [selected],
      cache,
      choice,
    ),
    [],
  );
});

Deno.test("late unfiltered query cannot erase previously verified leaf provenance from cache", async () => {
  const choice = {
    entity: "Atlas",
    leaf: "Розетки",
    exact: true,
    slot_id: "server-slot-1",
    issued_slot: {},
  };
  type CachedProduct = ProductRef & { url: string };
  const socket: CachedProduct = {
    ...product("1", "Atlas socket", "Розетки"),
    url: "https://220volt.kz/catalog/elektrika/rozetki/atlas-socket/",
  };
  const cache = new Map<string, CachedProduct>();
  const requests: string[] = [];
  const result = await collectVerifiedBroadAssortmentProducts(
    choice,
    async ({ mode, page, category }) => {
      requests.push(`${mode}:${page}:${category ?? "none"}`);
      if (mode === "by_query" && category === "Розетки") {
        cache.set(socket.id, socket);
        return { ok: true as const, total: 1, results: [socket] };
      }
      if (mode === "by_query" && !category) {
        // executeSearchCatalog materializes this same id again, but its broad
        // API row omits the leaf object and overwrites the request cache.
        cache.set(socket.id, { ...socket, leaf_category: null });
        return {
          ok: true as const,
          total: 1,
          results: [{ ...socket, leaf_category: null }],
        };
      }
      return { ok: true as const, total: 0, results: [] };
    },
    (ref) => cache.get(ref.id) ?? null,
  );
  assertEquals(requests, [
    "by_query:1:Розетки",
    "by_filter:1:Розетки",
    "by_query:1:none",
  ]);
  assertEquals(result.products.map((entry) => entry.id), ["1"]);
  assertEquals(cache.get("1")?.leaf_category, null);
  assertEquals(
    rehydrateVerifiedBroadAssortmentProducts(result.products, cache, choice)
      .map((entry) => entry.id),
    ["1"],
  );
  assertEquals(cache.get("1")?.leaf_category, "Розетки");
});

Deno.test("cache restoration requires the same product and never overrides conflicting evidence", () => {
  const choice = { entity: "Atlas", leaf: "Розетки" };
  type CachedProduct = ProductRef & { url: string };
  const selected: CachedProduct = {
    ...product("1", "Atlas socket", "Розетки"),
    url: "https://220volt.kz/catalog/rozetki/atlas-socket/",
  };
  const variants: CachedProduct[] = [
    { ...selected, leaf_category: "Выключатели" },
    { ...selected, pagetitle: "Other socket", leaf_category: null },
    {
      ...selected,
      url: "https://220volt.kz/catalog/rozetki/other-socket/",
      leaf_category: null,
    },
  ];
  for (const current of variants) {
    const cache = new Map<string, CachedProduct>([["1", current]]);
    assertEquals(
      rehydrateVerifiedBroadAssortmentProducts([selected], cache, choice),
      [],
    );
    assertEquals(cache.get("1"), current);
  }
});

Deno.test("forged, stale and incomplete catalog_section slots cannot authorize selection", () => {
  const log = completedChoiceLog("Atlas", ["Раздел X", "Раздел Y"]);
  const slots = {
    pending_clarification: {
      slot_id: "forged-id",
      facet_key: "catalog_section",
      scope: { token: "Other" },
    },
  };
  assertEquals(
    resolveServerIssuedBroadAssortmentChoice(
      slots,
      log,
      "Раздел X",
      "session-A",
    ),
    null,
  );
  assertEquals(
    resolveServerIssuedBroadAssortmentChoice(
      { pending_clarification: { slot_id: "server-slot-1" } },
      { ...log, user_query: "найди кабель" },
      "Раздел X",
      "session-A",
    ),
    null,
  );
  assertEquals(
    resolveServerIssuedBroadAssortmentChoice(
      { pending_clarification: { slot_id: "server-slot-1" } },
      { ...log, error: "catalog_timeout" },
      "Раздел X",
      "session-A",
    ),
    null,
  );
  assertEquals(
    resolveServerIssuedBroadAssortmentChoice(
      { pending_clarification: { slot_id: "server-slot-1" } },
      { ...log, response_events: log.response_events.slice(0, 1) },
      "Раздел X",
      "session-A",
    ),
    null,
  );
  assertEquals(
    resolveServerIssuedBroadAssortmentChoice(
      { pending_clarification: { slot_id: "server-slot-1" } },
      log,
      "Раздел Z",
      "session-A",
    ),
    null,
  );
  assertEquals(
    resolveServerIssuedBroadAssortmentChoice(
      { pending_clarification: { slot_id: "server-slot-1" } },
      log,
      "Новая тема: хочу Раздел X",
      "session-A",
    ),
    null,
  );
  assertEquals(
    resolveServerIssuedBroadAssortmentChoice(
      { pending_clarification: { slot_id: "server-slot-1" } },
      log,
      "Раздел X",
      "session-B",
    ),
    null,
  );
});

Deno.test("a just-completed clarification survives one lagging log read", async () => {
  const log = completedChoiceLog("Atlas");
  const rows = [
    { row: { ...log, error: "in_progress" }, error: false },
    { row: log, error: false },
  ];
  let reads = 0;
  let waits = 0;
  const outcome = await resolveBroadAssortmentChoiceAfterReadRace(
    { pending_clarification: { slot_id: "server-slot-1" } },
    "Розетки",
    "session-A",
    async () => rows[Math.min(reads++, rows.length - 1)],
    async () => {
      waits++;
    },
  );
  assertEquals(outcome.choice?.leaf, "Розетки");
  assertEquals(outcome.verifiedSlot?.slot_id, "server-slot-1");
  assertEquals(outcome.lookupFailed, false);
  assertEquals(reads, 2);
  assertEquals(waits, 1);
});

Deno.test("server-issued free-form scope with one leaf keeps the existing generic route", async () => {
  const outcome = await resolveBroadAssortmentChoiceAfterReadRace(
    {
      pending_clarification: {
        slot_id: "server-slot-1",
        facet_key: "catalog_section",
      },
    },
    "Нужны черные",
    "session-A",
    async () => ({
      row: completedChoiceLog("Atlas", ["Розетки"]),
      error: false,
    }),
  );
  assertEquals(outcome.choice, null);
  assertEquals(outcome.verifiedSlot?.scope, {
    kind: "broad_assortment",
    token: "Atlas",
  });
  assertEquals(outcome.lookupFailed, false);
});

Deno.test("typed refinements never enter the exact-chip shortcut", () => {
  const slots = { pending_clarification: { slot_id: "server-slot-1" } };
  const log = completedChoiceLog("Atlas");
  for (
    const message of [
      "Мне нужны черные Розетки",
      "Розетки до 1000 ₸",
      "двойные розетки",
      "без розеток",
      "Найди кабель ВВГ 3х1,5",
      "Найди другие розетки",
    ]
  ) {
    assertEquals(
      resolveServerIssuedBroadAssortmentChoice(
        slots,
        log,
        message,
        "session-A",
      ),
      null,
      message,
    );
  }
  assertEquals(
    resolveServerIssuedBroadAssortmentChoice(
      slots,
      completedChoiceLog("Atlas", ["Розетки", "Розетки с заземлением"]),
      "Розетки с заземлением",
      "session-A",
    )?.leaf,
    "Розетки с заземлением",
  );
});

Deno.test("a self-contained unrelated request cannot inherit the server-issued entity", () => {
  const slots = { pending_clarification: { slot_id: "server-slot-1" } };
  const log = completedChoiceLog("Gallant");
  assertEquals(
    resolveServerIssuedBroadAssortmentPending(
      slots,
      log,
      "Найди кабель ВВГ 3х1,5",
      "session-A",
    ),
    null,
  );
  assertEquals(
    resolveServerIssuedBroadAssortmentPending(
      slots,
      log,
      "Найди другие светильники на улицу",
      "session-A",
    ),
    null,
  );
  assertEquals(
    resolveServerIssuedBroadAssortmentPending(
      slots,
      log,
      "Розетки до 1000 ₸",
      "session-A",
    )?.entity,
    "Gallant",
  );
  assertEquals(
    resolveServerIssuedBroadAssortmentPending(
      slots,
      log,
      "Мне нужны черные Розетки",
      "session-A",
    )?.entity,
    "Gallant",
  );
});

Deno.test("short independent requests do not restore Gallant even when the classifier fails", async () => {
  const slots = { pending_clarification: { slot_id: "server-slot-1" } };
  const log = completedChoiceLog("Gallant");
  const priorHistory = [{
    role: "user" as const,
    content: "покажи ассортимент Gallant на сайте",
  }];
  for (
    const message of [
      "Посоветуй кабель",
      "Есть ли кабель ВВГ?",
      "Подскажи прожектор",
      "У вас есть кабель ВВГ?",
      "Посоветуй розетки Schneider",
      "Посоветуй черные розетки Schneider",
      "Посоветуй розетки черные Schneider",
      "Посоветуй черные розетки Шнайдер",
      "Посоветуй розетки бренда IEK",
    ]
  ) {
    const verified = await resolveBroadAssortmentChoiceAfterReadRace(
      slots,
      message,
      "session-A",
      async () => ({ row: log, error: false }),
    );
    assertEquals(verified.verifiedSlot, null, message);
    assertEquals(verified.choice, null, message);
    const boundary = await classifyConversationBoundary(
      message,
      priorHistory,
      {},
      {
        apiKey: "unused",
        model: "unused",
        fetchImpl: (() =>
          Promise.reject(
            new DOMException("conversation_boundary_timeout", "TimeoutError"),
          )) as typeof fetch,
      },
    );
    // Mirror the handler route: on classifier failure, a complete unrelated
    // task must bypass both stale scope and the invalid-chip response.
    const startsNewTask = shouldStartNewConversation(boundary) ||
      shouldResetUnverifiedBroadAssortmentTask(
        message,
        true,
        verified.verifiedSlot,
      );
    const invalidChipReply = !verified.verifiedSlot && !startsNewTask;
    const effectiveSlots = startsNewTask ? {} : slots;
    const effectiveHistory = startsNewTask ? [] : priorHistory;
    assertEquals(startsNewTask, true, message);
    if (boundary.source === "fallback") {
      assertEquals(boundary.reason, "classifier_TimeoutError", message);
    }
    assertEquals(invalidChipReply, false, message);
    assertEquals(effectiveSlots, {}, message);
    assertEquals(effectiveHistory, [], message);
  }
  for (
    const message of [
      "Розетки до 1000 ₸",
      "Посоветуй черные Розетки",
      "Посоветуй черные розетки",
      "Посоветуй розетки USB",
      "Посоветуй розетки в Астане",
    ]
  ) {
    assertEquals(
      resolveServerIssuedBroadAssortmentPending(
        slots,
        log,
        message,
        "session-A",
      )
        ?.entity,
      "Gallant",
      message,
    );
    assertEquals(
      shouldResetUnverifiedBroadAssortmentTask(message, true, {}),
      false,
      message,
    );
  }
  assertEquals(
    shouldResetUnverifiedBroadAssortmentTask(
      "Посоветуй этот кабель",
      true,
      null,
    ),
    false,
  );
});

Deno.test("lookup failure does not turn an attribute-and-leaf continuation into a new task", async () => {
  const slots = { pending_clarification: { slot_id: "server-slot-1" } };
  const message = "Посоветуй черные розетки";
  const verified = await resolveBroadAssortmentChoiceAfterReadRace(
    slots,
    message,
    "session-A",
    async () => ({ row: null, error: true }),
    async () => {},
  );
  assertEquals(verified.lookupFailed, true);
  assertEquals(verified.verifiedSlot, null);
  const boundary = await classifyConversationBoundary(
    message,
    [{ role: "user", content: "покажи ассортимент Gallant на сайте" }],
    {},
    {
      apiKey: "unused",
      model: "unused",
      fetchImpl: (() =>
        Promise.reject(
          new DOMException("conversation_boundary_timeout", "TimeoutError"),
        )) as typeof fetch,
    },
  );
  assertEquals(boundary.mode, "continuation");
  assertEquals(boundary.source, "fallback");
  assertEquals(boundary.reason, "classifier_TimeoutError");
  assertEquals(
    shouldStartNewConversation(boundary) ||
      shouldResetUnverifiedBroadAssortmentTask(
        message,
        true,
        verified.verifiedSlot,
      ),
    false,
  );
  // A distinct named entity remains a high-confidence independent task.
  assertEquals(
    shouldResetUnverifiedBroadAssortmentTask(
      "Посоветуй розетки Schneider",
      true,
      verified.verifiedSlot,
    ),
    true,
  );
});

Deno.test("empty first page recovers from second page without changing entity or section", async () => {
  const choice = resolveServerIssuedBroadAssortmentChoice(
    { pending_clarification: { slot_id: "server-slot-1" } },
    completedChoiceLog("Atlas"),
    "Розетки",
    "session-A",
  )!;
  const requests: string[] = [];
  const result = await collectVerifiedBroadAssortmentProducts(
    choice,
    async ({ mode, page, category }) => {
      requests.push(`${mode}:${page}:${category ?? "none"}`);
      return page === 1 ? { ok: true as const, total: 100, results: [] } : {
        ok: true as const,
        total: 100,
        results: [
          product("1", "Atlas socket", "Розетки"),
          product("3", "Atlas socket A", "Розетки"),
          product("4", "Atlas socket B", "Розетки"),
          product("2", "Atlas switch", "Выключатели"),
        ],
      };
    },
    (ref) => ref,
  );
  assertEquals(requests, ["by_query:1:Розетки", "by_query:2:Розетки"]);
  assertEquals(result.products.map((entry) => entry.id), ["1", "3", "4"]);
  assertEquals(result.catalog_error, null);
});

Deno.test("one matching card does not stop a bounded search for real choice", async () => {
  const choice = resolveServerIssuedBroadAssortmentChoice(
    { pending_clarification: { slot_id: "server-slot-1" } },
    completedChoiceLog("Atlas"),
    "Розетки",
    "session-A",
  )!;
  const requests: string[] = [];
  const result = await collectVerifiedBroadAssortmentProducts(
    choice,
    async ({ mode, category }) => {
      requests.push(`${mode}:${category ?? "none"}`);
      return mode === "by_filter"
        ? {
          ok: true as const,
          total: 3,
          results: [
            product("1", "Atlas socket", "Розетки"),
            product("2", "Atlas socket B", "Розетки"),
            product("3", "Atlas socket C", "Розетки"),
          ],
        }
        : {
          ok: true as const,
          total: 1,
          results: [
            product("1", "Atlas socket", "Розетки"),
          ],
        };
    },
    (ref) => ref,
  );
  assertEquals(requests, ["by_query:Розетки", "by_filter:Розетки"]);
  assertEquals(result.products.map((entry) => entry.id), ["1", "2", "3"]);
});

Deno.test("a broad exact chip renders at most five unique verified products", async () => {
  const choice = resolveServerIssuedBroadAssortmentChoice(
    { pending_clarification: { slot_id: "server-slot-1" } },
    completedChoiceLog("Atlas"),
    "Розетки",
    "session-A",
  )!;
  const products = Array.from(
    { length: 9 },
    (_, index) =>
      product(String(index + 1), `Atlas socket ${index + 1}`, "Розетки"),
  );
  const result = await collectVerifiedBroadAssortmentProducts(
    choice,
    async () => ({
      ok: true as const,
      total: 10,
      results: [
        ...products,
        products[0],
        product("10", "Atlas switch", "Выключатели"),
      ],
    }),
    (ref) => ref,
  );
  assertEquals(result.completed_searches, 1);
  assertEquals(result.products.length, 9);
  const cache = new Map(result.products.map((entry) => [entry.id, entry]));
  const final = rehydrateVerifiedBroadAssortmentProducts(
    result.products,
    cache,
    choice,
  );
  assertEquals(final.map((entry) => entry.id), ["1", "2", "3", "4", "5"]);
  assertEquals(new Set(final.map((entry) => entry.id)).size, 5);
});

Deno.test("five-card cap applies after live-cache proof, not before it", () => {
  const choice = { entity: "Atlas", leaf: "Розетки" };
  const selected = Array.from(
    { length: 9 },
    (_, index) =>
      product(String(index + 1), `Atlas socket ${index + 1}`, "Розетки"),
  );
  const cache = new Map(selected.map((entry) => [entry.id, entry]));
  for (const entry of selected.slice(0, 4)) {
    cache.set(entry.id, { ...entry, leaf_category: "Выключатели" });
  }
  assertEquals(
    rehydrateVerifiedBroadAssortmentProducts(selected, cache, choice).map(
      (entry) => entry.id,
    ),
    ["5", "6", "7", "8", "9"],
  );
});

Deno.test("catalog failure is not reported as an honest empty intersection", async () => {
  const choice = resolveServerIssuedBroadAssortmentChoice(
    { pending_clarification: { slot_id: "server-slot-1" } },
    completedChoiceLog("Atlas"),
    "Розетки",
    "session-A",
  )!;
  const failed = await collectVerifiedBroadAssortmentProducts(
    choice,
    async () => ({ ok: false as const, error_code: "catalog_timeout" }),
    () => null,
  );
  assertEquals(failed.products, []);
  assertEquals(failed.catalog_error, "catalog_timeout");
  const trulyEmpty = await collectVerifiedBroadAssortmentProducts(
    choice,
    async () => ({ ok: true as const, total: 0, results: [] }),
    () => null,
  );
  assertEquals(trulyEmpty.products, []);
  assertEquals(trulyEmpty.catalog_error, null);
  assertEquals(trulyEmpty.coverage_incomplete, false);
});

Deno.test("large unscanned result set is partial, not an exhaustive empty", async () => {
  const choice = resolveServerIssuedBroadAssortmentChoice(
    { pending_clarification: { slot_id: "server-slot-1" } },
    completedChoiceLog("Atlas"),
    "Розетки",
    "session-A",
  )!;
  const result = await collectVerifiedBroadAssortmentProducts(
    choice,
    async () => ({ ok: true as const, total: 640, results: [] }),
    () => null,
  );
  assertEquals(result.products, []);
  assertEquals(result.catalog_error, null);
  assertEquals(result.coverage_incomplete, true);
});

Deno.test("shared lookup deadline stops additional catalog calls", async () => {
  const choice = resolveServerIssuedBroadAssortmentChoice(
    { pending_clarification: { slot_id: "server-slot-1" } },
    completedChoiceLog("Atlas"),
    "Розетки",
    "session-A",
  )!;
  let calls = 0;
  const result = await collectVerifiedBroadAssortmentProducts(
    choice,
    async () => {
      calls++;
      return { ok: true as const, total: 640, results: [] };
    },
    () => null,
    () => calls === 0,
  );
  assertEquals(calls, 1);
  assertEquals(result.catalog_error, "catalog_deadline");
  assertEquals(result.coverage_incomplete, true);
});

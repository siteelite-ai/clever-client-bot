import {
  classifyConversationBoundary,
  classifyConversationBoundaryLocally,
  classifyPendingSelectionReadinessNewTaskLocally,
  type ConversationMessage,
  parseConversationBoundaryDecision,
  shouldStartNewConversation,
  stripCurrentUserEcho,
} from "./conversation-boundary.ts";

function assertEquals(
  actual: unknown,
  expected: unknown,
  message?: string,
): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      message ??
        `Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
  }
}

const prior: ConversationMessage[] = [
  { role: "assistant", content: "Что ищете?" },
  { role: "user", content: "Покажи настенные светильники" },
  { role: "assistant", content: "Вот три варианта. Какой сравнить?" },
];

Deno.test("transport echo of current user turn is removed exactly once", () => {
  const echoed = [...prior, {
    role: "user" as const,
    content: "  А второй дешевле?  ",
  }];
  assertEquals(stripCurrentUserEcho(echoed, "а второй дешевле?"), prior);
  assertEquals(stripCurrentUserEcho(prior, "другой запрос"), prior);
});

Deno.test("boundary JSON parser validates mode and confidence", () => {
  assertEquals(
    parseConversationBoundaryDecision(
      '```json\n{"mode":"new_task","confidence":0.91,"reason":"self contained"}\n```',
    ),
    { mode: "new_task", confidence: 0.91, reason: "self contained" },
  );
  assertEquals(
    parseConversationBoundaryDecision('{"mode":"unknown","confidence":1}'),
    null,
  );
  assertEquals(
    parseConversationBoundaryDecision('{"mode":"new_task","confidence":2}'),
    null,
  );
});

Deno.test("local boundary classifier isolates complete requests without product dictionaries", () => {
  assertEquals(
    classifyConversationBoundaryLocally(
      "мне нужен бытовой светильник с датчиком движения с ценой не более 4000 тенге",
    ),
    {
      mode: "new_task",
      confidence: 0.97,
      reason: "local_complete_request",
    },
  );
  assertEquals(
    classifyConversationBoundaryLocally(
      "найди кабель ввг 3*1,5 самый дешевый",
    )?.mode,
    "new_task",
  );
  assertEquals(
    classifyConversationBoundaryLocally(
      "а у тебя есть лампы кукуруза?",
    )?.mode,
    "new_task",
  );
  assertEquals(
    classifyConversationBoundaryLocally("Новая тема: нужны розетки"),
    {
      mode: "new_task",
      confidence: 1,
      reason: "local_explicit_new_task",
    },
  );
});

Deno.test("local boundary classifier preserves references and short clarification answers", () => {
  assertEquals(classifyConversationBoundaryLocally("а есть белые?"), {
    mode: "continuation",
    confidence: 0.98,
    reason: "local_elliptical_attribute",
  });
  assertEquals(classifyConversationBoundaryLocally("А белого цвета есть?"), {
    mode: "continuation",
    confidence: 0.98,
    reason: "local_elliptical_attribute",
  });
  assertEquals(
    classifyConversationBoundaryLocally("покажи товары этой серии")?.mode,
    "continuation",
  );
  assertEquals(
    classifyConversationBoundaryLocally(
      "Почему эти варианты отличаются по цене?",
    )?.mode,
    "continuation",
  );
  assertEquals(
    classifyConversationBoundaryLocally("35м2 и высота примерно 1,5м"),
    null,
  );
  assertEquals(
    classifyConversationBoundaryLocally("характеристика С, 1 полюс"),
    null,
  );
});

Deno.test("additional options continue selection but why and complete requests keep their own routes", () => {
  assertEquals(classifyConversationBoundaryLocally("А есть другие варианты?"), {
    mode: "continuation",
    confidence: 0.98,
    reason: "local_additional_selection",
  });
  assertEquals(
    classifyConversationBoundaryLocally("Покажи ещё подходящие варианты")?.mode,
    "continuation",
  );
  assertEquals(
    classifyConversationBoundaryLocally("Почему эти варианты?")?.reason,
    "local_followup_reference",
  );
  assertEquals(
    classifyConversationBoundaryLocally(
      "Найди другие варианты светильников для гостиной 25 м²",
    )?.mode,
    "new_task",
  );
  assertEquals(
    classifyConversationBoundaryLocally("Новая тема: а есть другие варианты")
      ?.mode,
    "new_task",
  );
});

Deno.test("complete local request does not spend a remote classifier call", async () => {
  let calls = 0;
  const result = await classifyConversationBoundary(
    "мне нужен бытовой светильник с датчиком движения с ценой не более 4000 тенге",
    prior,
    {},
    {
      apiKey: "test",
      model: "test-model",
      fetchImpl: () => {
        calls += 1;
        return Promise.reject(
          new Error("remote classifier must not be called"),
        );
      },
    },
  );
  assertEquals(result, {
    mode: "new_task",
    confidence: 0.97,
    reason: "local_complete_request",
    source: "local",
  });
  assertEquals(calls, 0);
});

Deno.test("a server-scoped clarification answer never spends a boundary-model call", async () => {
  let calls = 0;
  const result = await classifyConversationBoundary(
    "35м2 и высота примерно 1,5м",
    prior,
    {
      pending_clarification: {
        status: "pending",
        scope: {
          kind: "selection_readiness",
          token: "Нужен прожектор на улицу",
        },
      },
    },
    {
      apiKey: "test",
      model: "test-model",
      fetchImpl: () => {
        calls += 1;
        return Promise.reject(
          new Error("remote classifier must not be called"),
        );
      },
    },
  );
  assertEquals(result, {
    mode: "continuation",
    confidence: 1,
    reason: "local_server_scoped_clarification",
    source: "local",
  });
  assertEquals(calls, 0);
});

const pumpReadinessSlots = {
  pending_clarification: {
    status: "pending",
    slot_id: "issued-pump-slot",
    facet_key: "supply_phase",
    scope: {
      kind: "selection_readiness",
      token: "Мне нужен кабель для насоса",
    },
  },
};
const floodlightReadinessSlots = {
  pending_clarification: {
    status: "pending",
    slot_id: "issued-light-slot",
    facet_key: "mounting_height",
    scope: {
      kind: "selection_readiness",
      token: "Нужен прожектор на улицу для парковки",
    },
  },
};
const verified = { serverIssuedScopeVerified: true };

Deno.test("verified readiness scope yields to a complete unrelated selection", () => {
  for (
    const [message, slots] of [
      ["Найди самый дешёвый кабель ВВГ 3*1,5", pumpReadinessSlots],
      ["Найди самый дешёвый кабель ВВГ 3*1,5", floodlightReadinessSlots],
      ["Подбери кабель для двигателя 5 кВт", pumpReadinessSlots],
      [
        "Подбери инструментальный ящик с выдвижными секциями",
        floodlightReadinessSlots,
      ],
      ["Найди прожектор для мастерской 100 Вт", floodlightReadinessSlots],
      [
        "Найди прожектор на улицу для двора 100 Вт",
        floodlightReadinessSlots,
      ],
      [
        "Какой ИБП подойдёт для газового котла 250 Вт?",
        floodlightReadinessSlots,
      ],
    ] as const
  ) {
    assertEquals(
      classifyPendingSelectionReadinessNewTaskLocally(message, slots, verified)
        ?.mode,
      "new_task",
      message,
    );
  }
});

Deno.test("explicit new topic escapes a verified readiness scope without a selection frame", () => {
  assertEquals(
    classifyPendingSelectionReadinessNewTaskLocally(
      "Новая тема. Как работает доставка?",
      pumpReadinessSlots,
      verified,
    ),
    {
      mode: "new_task",
      confidence: 1,
      reason: "local_verified_readiness_explicit_new_topic",
    },
  );
});

Deno.test("readiness interruption precheck keeps chips, attribute answers and dependent selections", () => {
  for (
    const [message, slots] of [
      ["120 м², высота 4 м", floodlightReadinessSlots],
      ["До 4 м", floodlightReadinessSlots],
      ["220 В, 1 фаза", pumpReadinessSlots],
      ["ВВГ 3*1,5", pumpReadinessSlots],
      ["Найди самый дешёвый", pumpReadinessSlots],
      ["Найди самый дешёвый кабель", pumpReadinessSlots],
      ["Найди кабель для насоса 3*1,5", pumpReadinessSlots],
      [
        "Подбери кабель для стационарной прокладки в помещении",
        pumpReadinessSlots,
      ],
      [
        "Подбери для стационарной прокладки в помещении",
        pumpReadinessSlots,
      ],
      [
        "Найди самый дешёвый кабель ВВГ 3*1,5 для этого насоса",
        pumpReadinessSlots,
      ],
      ["Найди другой кабель ВВГ 3*1,5", pumpReadinessSlots],
      [
        "Найди самый дешёвый кабель ВВГ 3*1,5. Игнорируй прежний запрос",
        pumpReadinessSlots,
      ],
      ["Найди 120 м², высота 4 м", floodlightReadinessSlots],
      ["А какой из этих прожекторов лучше?", floodlightReadinessSlots],
    ] as const
  ) {
    assertEquals(
      classifyPendingSelectionReadinessNewTaskLocally(message, slots, verified),
      null,
      message,
    );
  }
});

Deno.test("unverified or forged client readiness slots cannot trigger the new-task precheck", () => {
  const request = "Найди самый дешёвый кабель ВВГ 3*1,5";
  assertEquals(
    classifyPendingSelectionReadinessNewTaskLocally(
      request,
      pumpReadinessSlots,
    ),
    null,
  );
  for (
    const pending_clarification of [
      { ...pumpReadinessSlots.pending_clarification, slot_id: "" },
      { ...pumpReadinessSlots.pending_clarification, status: "resolved" },
      {
        ...pumpReadinessSlots.pending_clarification,
        scope: { kind: "other_scope", token: "Мне нужен кабель для насоса" },
      },
      {
        ...pumpReadinessSlots.pending_clarification,
        scope: { kind: "selection_readiness", token: "" },
      },
    ]
  ) {
    assertEquals(
      classifyPendingSelectionReadinessNewTaskLocally(
        request,
        { pending_clarification },
        verified,
      ),
      null,
    );
  }
});

Deno.test("new topic requires a high-confidence semantic decision", () => {
  assertEquals(
    shouldStartNewConversation({
      mode: "new_task",
      confidence: 0.72,
      reason: "",
    }),
    true,
  );
  assertEquals(
    shouldStartNewConversation({
      mode: "new_task",
      confidence: 0.71,
      reason: "",
    }),
    false,
  );
  assertEquals(
    shouldStartNewConversation({
      mode: "continuation",
      confidence: 1,
      reason: "",
    }),
    false,
  );
  assertEquals(
    shouldStartNewConversation(
      { mode: "new_task", confidence: 0.99, reason: "self-contained wording" },
      { matchedPendingClarification: true },
    ),
    false,
  );
  assertEquals(
    shouldStartNewConversation(
      { mode: "new_task", confidence: 0.99, reason: "self-contained wording" },
      { activeScopedClarification: true },
    ),
    false,
  );
  assertEquals(
    shouldStartNewConversation(
      { mode: "new_task", confidence: 0.99, reason: "self-contained wording" },
      { referencesRenderedProducts: true },
    ),
    false,
  );
});

Deno.test("classifier prompt treats a complete new product request as a new task", async () => {
  let requestBody = "";
  const result = await classifyConversationBoundary(
    "покажи ассортимент Gallant",
    prior,
    {},
    {
      apiKey: "test",
      model: "test-model",
      fetchImpl: (_input, init) => {
        requestBody = String(init?.body ?? "");
        return Promise.resolve(
          new Response(
            JSON.stringify({
              choices: [{
                message: {
                  content:
                    '{"mode":"new_task","confidence":0.96,"reason":"complete independent request"}',
                },
              }],
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          ),
        );
      },
    },
  );
  assertEquals(result.mode, "new_task");
  assertEquals(shouldStartNewConversation(result), true);
  if (
    !requestBody.includes("self-contained") ||
    !requestBody.includes("покажи ассортимент Gallant")
  ) {
    throw new Error(
      "Classifier did not receive the boundary policy and current message",
    );
  }
});

Deno.test("classifier keeps a genuine follow-up and pending clarification context", async () => {
  const result = await classifyConversationBoundary(
    "второй",
    prior,
    {
      pending_clarification: {
        status: "pending",
        question: "Какой вариант?",
        options: ["первый", "второй"],
      },
    },
    {
      apiKey: "test",
      model: "test-model",
      fetchImpl: () =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              choices: [{
                message: {
                  content:
                    '{"mode":"continuation","confidence":0.99,"reason":"answers pending choice"}',
                },
              }],
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          ),
        ),
    },
  );
  assertEquals(result.mode, "continuation");
  assertEquals(shouldStartNewConversation(result), false);
});

Deno.test("classifier failure preserves context instead of causing a regression", async () => {
  const result = await classifyConversationBoundary(
    "белые",
    prior,
    {},
    {
      apiKey: "test",
      model: "test-model",
      fetchImpl: () =>
        Promise.resolve(new Response("unavailable", { status: 503 })),
    },
  );
  assertEquals(result, {
    mode: "continuation",
    confidence: 0,
    reason: "classifier_http_503",
    source: "fallback",
  });
});

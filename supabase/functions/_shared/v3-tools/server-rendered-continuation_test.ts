import {
  isNeutralAcknowledgement,
  resolveServerRenderedSelectionBase,
  resolveServerRenderedSelectionProof,
  type ServerRenderedSelectionLogRow,
} from "./server-rendered-continuation.ts";

function assertEquals(actual: unknown, expected: unknown, label: string) {
  if (actual !== expected) {
    throw new Error(
      `${label}: expected ${String(expected)}, got ${String(actual)}`,
    );
  }
}

const now = Date.parse("2026-10-21T12:00:00.000Z");
const sessionId = "session-new";
const base = "Хочу заменить люстру в гостиной 30 м². Покажи варианты";
const card =
  "- **[Люстра для гостиной](https://220volt.kz/catalog/svetotexnika/lyustry/lustra-1/)**\n  Цена: *9 500* ₸";

Deno.test("neutral acknowledgement excludes short clarification answers", () => {
  assertEquals(isNeutralAcknowledgement("Спасибо!"), true, "gratitude");
  assertEquals(isNeutralAcknowledgement("Да"), false, "choice reply");
  assertEquals(
    isNeutralAcknowledgement("Хорошо, возьму второй"),
    false,
    "selection reply",
  );
});

function minutesAgo(value: number): string {
  return new Date(now - value * 60_000).toISOString();
}

function successfulSelection(
  overrides: Partial<ServerRenderedSelectionLogRow> = {},
): ServerRenderedSelectionLogRow {
  return {
    id: "original-selection",
    session_id: sessionId,
    user_query: base,
    error: null,
    final_products_count: 1,
    created_at: minutesAgo(3),
    response_events: [
      { type: "diagnostic", phase: "start", log_id: "original-selection" },
      { type: "products_block", markdown: card, count: 1 },
      {
        type: "diagnostic",
        phase: "complete",
        log_id: "original-selection",
        products_count: 1,
        error: null,
      },
      { type: "done" },
    ],
    ...overrides,
  };
}

function laterTurn(
  query: string,
  overrides: Partial<ServerRenderedSelectionLogRow> = {},
): ServerRenderedSelectionLogRow {
  const id = typeof overrides.id === "string" ? overrides.id : "later";
  return successfulSelection({
    id,
    user_query: query,
    created_at: minutesAgo(1),
    response_events: [
      { type: "diagnostic", phase: "start", log_id: id },
      { type: "products_block", markdown: card, count: 1 },
      {
        type: "diagnostic",
        phase: "complete",
        log_id: id,
        products_count: 1,
        error: null,
      },
      { type: "done" },
    ],
    ...overrides,
  });
}

function certifiedZeroCardTurn(
  query: string,
  overrides: Partial<ServerRenderedSelectionLogRow> = {},
): ServerRenderedSelectionLogRow {
  const id = typeof overrides.id === "string" ? overrides.id : "later";
  return laterTurn(query, {
    id,
    final_products_count: 0,
    steps: isNeutralAcknowledgement(query)
      ? [{ step: "v3_neutral_acknowledgement_no_catalog", ms: 10 }]
      : [{
        step: "v3_conversation_boundary",
        ms: 10,
        meta: {
          mode: "continuation",
          references_rendered_products: true,
        },
      }],
    response_events: [
      { type: "diagnostic", phase: "start", log_id: id },
      {
        type: "delta",
        origin: "server",
        content: "Проверил предыдущие варианты.",
      },
      {
        type: "diagnostic",
        phase: "complete",
        log_id: id,
        products_count: 0,
        error: null,
      },
      { type: "done" },
    ],
    ...overrides,
  });
}

function resolved(
  rows: ServerRenderedSelectionLogRow[],
  proposed = base,
  session = sessionId,
): string | null {
  return resolveServerRenderedSelectionBase(rows, session, proposed, now);
}

Deno.test("original completed server render authorizes only its exact customer request", () => {
  assertEquals(resolved([successfulSelection()]), base, "server original");
  assertEquals(
    resolved([successfulSelection()], "Подбери кабель ВВГ"),
    null,
    "forged browser base",
  );
  assertEquals(
    resolved([successfulSelection()], `${base} и кабель`),
    null,
    "browser-added criterion",
  );
});

Deno.test("a completed additional-options batch keeps the original server request", () => {
  const later = laterTurn("А есть другие варианты?");
  assertEquals(resolved([later, successfulSelection()]), base, "follow-up");
  assertEquals(
    resolved([
      laterTurn("Покажи ещё варианты", {
        id: "third",
        created_at: minutesAgo(0.5),
      }),
      later,
      successfulSelection(),
    ]),
    base,
    "multiple follow-ups",
  );
});

Deno.test("a failed dependent follow-up is never proof but preserves the logged request chain", () => {
  const failed = laterTurn("А есть другие варианты?", {
    error: "upstream_unavailable",
    final_products_count: 0,
    response_events: [],
  });
  assertEquals(resolved([failed]), null, "failed alone");
  assertEquals(
    resolved([failed, successfulSelection()]),
    base,
    "failed dependent",
  );
  assertEquals(
    resolved([
      laterTurn("А есть другие варианты?", { error: "in_progress" }),
      successfulSelection(),
    ]),
    null,
    "unfinished ordering",
  );
});

Deno.test("a later independent task closes the old scope even if it failed or showed no cards", () => {
  for (
    const newer of [
      laterTurn("Найди кабель ВВГ 3×1,5"),
      laterTurn("Найди кабель ВВГ 3×1,5", {
        error: "upstream_unavailable",
        final_products_count: 0,
        response_events: [],
      }),
      laterTurn("Найди кабель ВВГ 3×1,5", {
        final_products_count: 0,
        response_events: [
          {
            type: "diagnostic",
            phase: "complete",
            log_id: "later",
            products_count: 0,
            error: null,
          },
          { type: "done" },
        ],
      }),
    ]
  ) {
    assertEquals(resolved([newer, successfulSelection()]), null, "new task");
  }
});

Deno.test("active batch identity is independent of current wording but never skips a newer turn", () => {
  const latest = laterTurn("А есть другие варианты?", {
    response_events: [
      {
        type: "products_block",
        markdown:
          "- **[Вторая люстра](https://220volt.kz/catalog/svetotexnika/lyustry/lustra-2/)**",
        count: 1,
      },
      {
        type: "diagnostic",
        phase: "complete",
        log_id: "later",
        products_count: 1,
        error: null,
      },
      { type: "done" },
    ],
  });
  const active = resolveServerRenderedSelectionProof(
    [latest, successfulSelection()],
    sessionId,
    null,
    null,
    now,
  );
  assertEquals(
    active?.recentShownProductCards[0].url,
    "https://220volt.kz/catalog/svetotexnika/lyustry/lustra-2/",
    "latest completed server identity",
  );
  assertEquals(
    resolveServerRenderedSelectionProof(
      [
        laterTurn("Спасибо", {
          id: "newest",
          created_at: minutesAgo(0.5),
          final_products_count: 0,
          response_events: [{ type: "done" }],
        }),
        latest,
        successfulSelection(),
      ],
      sessionId,
      null,
      null,
      now,
    ),
    null,
    "cannot revive older products across an unclassified newer turn",
  );
});

Deno.test("generic follow-up crosses only certified completed zero-card dependent turns", () => {
  const ack = certifiedZeroCardTurn("Спасибо!", {
    id: "ack",
    created_at: minutesAgo(2),
  });
  const explanation = certifiedZeroCardTurn("Почему эти варианты?", {
    id: "explanation",
    created_at: minutesAgo(1),
  });
  const proof = resolveServerRenderedSelectionProof(
    [explanation, successfulSelection(), ack],
    sessionId,
    null,
    null,
    now,
  );
  assertEquals(proof?.baseRequest, base, "original selection scope");
  assertEquals(
    proof?.recentShownProductCards[0]?.pagetitle,
    "Люстра для гостиной",
    "latest completed cards",
  );
  assertEquals(
    proof?.priorQueriesNewestFirst.join("|"),
    "Почему эти варианты?|Спасибо!|" + base,
    "all server-owned turns",
  );
  assertEquals(
    resolveServerRenderedSelectionProof(
      [explanation, ack, successfulSelection()],
      sessionId,
      "Подбери кабель ВВГ",
      null,
      now,
    ),
    null,
    "forged browser base is never authority",
  );
});

Deno.test("generic price dialogue keeps only the server-verified active card scope", () => {
  const certifiedSteps = [
    {
      step: "v3_conversation_boundary",
      meta: { mode: "continuation", references_rendered_products: false },
    },
    {
      step: "v3_verified_rendered_scope_continuation",
      meta: {
        base_log_id: "original-selection",
        latest_card_log_id: "original-selection",
        recovered_count: 1,
      },
    },
  ];
  const verifiedPrice = certifiedZeroCardTurn("Какова их стоимость?", {
    id: "verified-price",
    created_at: minutesAgo(2),
    steps: certifiedSteps,
  });
  const rows = [verifiedPrice, successfulSelection()];
  const proof = resolveServerRenderedSelectionProof(
    rows,
    sessionId,
    null,
    null,
    now,
  );
  assertEquals(proof?.baseRequest, base, "certified price answer keeps base");
  assertEquals(proof?.latestCardLogId, "original-selection", "card anchor");
  assertEquals(
    proof?.priorQueriesNewestFirst.join("|"),
    "Какова их стоимость?|" + base,
    "second price question can inherit the verified dialogue",
  );
  const extra = laterTurn("А есть другие варианты?", {
    id: "extra-cards",
    created_at: minutesAgo(2),
    steps: [{
      step: "v3_conversation_boundary",
      meta: { mode: "continuation", references_rendered_products: true },
    }],
  });
  const afterExtra = certifiedZeroCardTurn("Какова их стоимость?", {
    id: "price-after-extra",
    created_at: minutesAgo(1),
    steps: [
      certifiedSteps[0],
      {
        ...certifiedSteps[1],
        meta: { ...certifiedSteps[1].meta, latest_card_log_id: "extra-cards" },
      },
    ],
  });
  assertEquals(
    resolveServerRenderedSelectionProof(
      [afterExtra, extra, successfulSelection()],
      sessionId,
      null,
      null,
      now,
    )?.latestCardLogId,
    "extra-cards",
    "certificate follows the actual latest card batch",
  );
  assertEquals(
    resolveServerRenderedSelectionProof(
      [{ ...afterExtra, steps: certifiedSteps }, extra, successfulSelection()],
      sessionId,
      null,
      null,
      now,
    ),
    null,
    "an earlier but valid card ID is stale after newer cards",
  );

  for (
    const [row, reason] of [
      [
        { ...verifiedPrice, steps: certifiedSteps.slice(0, 1) },
        "missing active-proof certificate",
      ],
      [
        {
          ...verifiedPrice,
          steps: certifiedSteps.map((step) =>
            step.step ===
                "v3_verified_rendered_scope_continuation"
              ? {
                ...step,
                meta: {
                  base_log_id: "another-selection",
                  latest_card_log_id: "original-selection",
                  recovered_count: 1,
                },
              }
              : step
          ),
        },
        "stale base certificate",
      ],
      [
        { ...verifiedPrice, response_events: [{ type: "done" }] },
        "partial SSE stream",
      ],
      [
        { ...verifiedPrice, user_query: "Какова их стоимость для кухни?" },
        "new product criterion",
      ],
    ] as const
  ) {
    assertEquals(
      resolveServerRenderedSelectionProof(
        [row, successfulSelection()],
        sessionId,
        null,
        null,
        now,
      ),
      null,
      reason,
    );
  }
});

Deno.test("generic follow-up retains original criteria after certified extra cards and zero-card explanation", () => {
  const extra = laterTurn("А есть другие варианты?", {
    id: "extra",
    created_at: minutesAgo(2),
    steps: [{
      step: "v3_conversation_boundary",
      ms: 10,
      meta: { mode: "continuation", references_rendered_products: true },
    }],
    response_events: [
      {
        type: "products_block",
        markdown:
          "- **[Вторая люстра](https://220volt.kz/catalog/svetotexnika/lyustry/lustra-2/)**",
        count: 1,
      },
      {
        type: "diagnostic",
        phase: "complete",
        log_id: "extra",
        products_count: 1,
        error: null,
      },
      { type: "done" },
    ],
  });
  const explanation = certifiedZeroCardTurn(
    "Почему эти варианты?",
    {
      id: "explanation",
      created_at: minutesAgo(1),
    },
  );
  const proof = resolveServerRenderedSelectionProof(
    [explanation, extra, successfulSelection()],
    sessionId,
    null,
    null,
    now,
  );
  assertEquals(proof?.baseRequest, base, "original, not extra-options wording");
  assertEquals(
    proof?.recentShownProductCards[0]?.pagetitle,
    "Вторая люстра",
    "last rendered batch",
  );
  assertEquals(proof?.shownProductUrls.length, 2, "both verified batches only");
});

Deno.test("generic scope certificate rejects changed task, unclassified zero-card, errors, and partial responses", () => {
  const original = successfulSelection();
  const plain = certifiedZeroCardTurn("Спасибо!", { steps: undefined });
  const changed = certifiedZeroCardTurn("Найди кабель ВВГ 3×1,5", {
    steps: [{
      step: "v3_conversation_boundary",
      ms: 10,
      meta: { mode: "new_task", references_rendered_products: false },
    }],
    response_events: [
      {
        type: "conversation_boundary",
        mode: "new_task",
        session_id: sessionId,
      },
      {
        type: "diagnostic",
        phase: "complete",
        log_id: "later",
        products_count: 0,
        error: null,
      },
      { type: "done" },
    ],
  });
  const malformed = certifiedZeroCardTurn("Почему эти варианты?", {
    response_events: [{ type: "delta", content: "Ещё проверяю" }],
  });
  const ambiguous = certifiedZeroCardTurn("Почему эти варианты?", {
    steps: [{ step: "v3_active_selection_prepositional_ambiguous", ms: 10 }],
  });
  const changedCriterion = certifiedZeroCardTurn(
    "Они точно подходят для кухни?",
    {
      steps: [{
        step: "v3_conversation_boundary",
        ms: 10,
        meta: { mode: "continuation", references_rendered_products: true },
      }],
    },
  );
  for (
    const [row, reason] of [
      [plain, "missing certificate"],
      [changed, "explicit new task"],
      [malformed, "partial stream"],
      [ambiguous, "ambiguous boundary"],
      [changedCriterion, "changed criterion"],
      [
        certifiedZeroCardTurn("Почему эти варианты?", {
          response_events: [
            { type: "diagnostic", phase: "start", log_id: "later" },
            {
              type: "slot_update",
              slots: { pending_clarification: { question: "Уточните" } },
            },
            {
              type: "diagnostic",
              phase: "complete",
              log_id: "later",
              products_count: 0,
              error: null,
            },
            { type: "done" },
          ],
        }),
        "new pending interaction",
      ],
      [
        certifiedZeroCardTurn("Почему эти варианты?", {
          response_events: [
            { type: "diagnostic", phase: "start", log_id: "later" },
            {
              type: "delta",
              content:
                "https://220volt.kz/catalog/svetotexnika/lyustry/lustra-3/",
            },
            {
              type: "diagnostic",
              phase: "complete",
              log_id: "later",
              products_count: 0,
              error: null,
            },
            { type: "done" },
          ],
        }),
        "unaccounted catalog link",
      ],
      [
        certifiedZeroCardTurn("Почему эти варианты?", {
          response_events: [
            { type: "delta", content: "Готово" },
            {
              type: "diagnostic",
              phase: "complete",
              log_id: "later",
              products_count: 0,
              error: null,
            },
            { type: "done" },
          ],
        }),
        "missing start marker",
      ],
      [
        certifiedZeroCardTurn("Почему эти варианты?", {
          error: "upstream_unavailable",
        }),
        "error",
      ],
    ] as const
  ) {
    assertEquals(
      resolveServerRenderedSelectionProof(
        [row, original],
        sessionId,
        null,
        null,
        now,
      ),
      null,
      reason,
    );
  }
});

Deno.test("count without valid controlled cards, complete marker, or durable agreement is no proof", () => {
  const valid = successfulSelection();
  for (
    const malformed of [
      { ...valid, response_events: [] },
      {
        ...valid,
        response_events: [
          { type: "products_block", markdown: card, count: 1 },
          { type: "done" },
        ],
      },
      {
        ...valid,
        response_events: [
          { type: "products_block", markdown: card, count: 1 },
          {
            type: "diagnostic",
            phase: "complete",
            log_id: valid.id,
            products_count: 1,
            error: null,
          },
        ],
      },
      {
        ...valid,
        response_events: (valid.response_events as unknown[]).map((event) =>
          (event as { type: string }).type === "products_block"
            ? {
              type: "products_block",
              count: 1,
              markdown: "- **[Подмена](https://evil.example/catalog/lamp/)**",
            }
            : event
        ),
      },
      {
        ...valid,
        response_events: (valid.response_events as unknown[]).map((event) =>
          (event as { type: string }).type === "products_block"
            ? { type: "products_block", count: 0, markdown: card }
            : event
        ),
      },
      {
        ...valid,
        response_events: (valid.response_events as unknown[]).map((event) =>
          (event as { type: string }).type === "products_block"
            ? { type: "products_block", count: 2, markdown: card }
            : event
        ),
      },
      { ...valid, final_products_count: 0 },
      { ...valid, error: "upstream_unavailable" },
      {
        ...valid,
        response_events: (valid.response_events as unknown[]).map((event) =>
          (event as { phase?: string }).phase === "complete"
            ? {
              type: "diagnostic",
              phase: "complete",
              log_id: "different",
              products_count: 1,
              error: null,
            }
            : event
        ),
      },
      {
        ...valid,
        response_events: (valid.response_events as unknown[]).map((event) =>
          (event as { phase?: string }).phase === "complete"
            ? {
              type: "diagnostic",
              phase: "complete",
              log_id: valid.id,
              products_count: 1,
              error: "connection_failed",
            }
            : event
        ),
      },
    ]
  ) {
    assertEquals(resolved([malformed]), null, "malformed proof");
  }
});

Deno.test("session boundary must be issued by the same completed server response", () => {
  const rotated = successfulSelection({
    session_id: "session-old",
    response_events: [
      {
        type: "conversation_boundary",
        mode: "new_task",
        session_id: sessionId,
      },
      ...(successfulSelection().response_events as unknown[]),
    ],
  });
  assertEquals(resolved([rotated]), base, "verified rotation");
  assertEquals(
    resolved([successfulSelection({ session_id: "session-old" })]),
    null,
    "foreign session",
  );
  assertEquals(
    resolved([rotated], base, "session-unrelated"),
    null,
    "boundary for another session",
  );
});

Deno.test("stale, future, conflicting, and unbounded logs fail closed", () => {
  assertEquals(
    resolved([successfulSelection({ created_at: minutesAgo(31) })]),
    null,
    "expired",
  );
  assertEquals(
    resolved([
      successfulSelection({
        created_at: new Date(now + 6 * 60_000).toISOString(),
      }),
    ]),
    null,
    "future",
  );
  assertEquals(
    resolved([successfulSelection(), laterTurn("А есть другие варианты?")]),
    base,
    "combined DB queries may be out of order",
  );
  assertEquals(
    resolved([successfulSelection(), successfulSelection()]),
    base,
    "identical boundary duplicate",
  );
  assertEquals(
    resolved([
      laterTurn("А есть другие варианты?"),
      laterTurn("Покажи ещё варианты"),
    ]),
    null,
    "conflicting duplicate IDs",
  );
  assertEquals(
    resolved(
      Array.from(
        { length: 10 },
        (_, index) =>
          laterTurn("А есть другие варианты?", {
            id: `turn-${index}`,
            created_at: minutesAgo(index),
          }),
      ),
    ),
    null,
    "unbounded",
  );
});

Deno.test("generic continuation preserves non-area and multi-criterion original requests", () => {
  const requests = [
    "Нужен двойной выключатель Gallant, чёрный с хромом. Что есть?",
    "Нужна люстра в гостиную 30 м², мощность не менее 20 Вт и бюджет до 15 000 тенге.",
  ];
  for (const request of requests) {
    const original = successfulSelection({ user_query: request });
    const proof = resolveServerRenderedSelectionProof(
      [laterTurn("Чем отличается первый от второго?"), original],
      sessionId,
      request,
      "А есть другие варианты?",
      now,
    );
    assertEquals(proof?.baseRequest, request, "original request");
    assertEquals(
      proof?.priorQueriesNewestFirst[0],
      "Чем отличается первый от второго?",
      "prior comparison",
    );
    assertEquals(proof?.priorQueriesNewestFirst[1], request, "prior base");
    assertEquals(
      resolveServerRenderedSelectionProof(
        [laterTurn("Покажи их"), original],
        sessionId,
        request,
        "А есть другие варианты?",
        now,
      )?.baseRequest,
      request,
      "read-only show follow-up",
    );
  }
});

Deno.test("same-area reaffirmation and read-only comparison preserve completed selection", () => {
  const request =
    "Хочу заменить люстру в зале 30 квадратов, мощность от 20 Вт. Покажи варианты";
  const original = successfulSelection({ user_query: request });
  const reaffirmation = laterTurn(
    "Они точно подходят для освещения 30 квадратных метров?",
    { id: "reaffirmation", created_at: minutesAgo(2) },
  );
  const comparison = laterTurn(
    "Почему варианты отличаются по цене? Сравни подтверждённые характеристики.",
    { id: "comparison", created_at: minutesAgo(1) },
  );
  const proof = resolveServerRenderedSelectionProof(
    [comparison, original, reaffirmation],
    sessionId,
    request,
    "А есть другие варианты?",
    now,
  );
  assertEquals(proof?.baseRequest, request, "verified base");
  assertEquals(proof?.priorQueriesNewestFirst.length, 3, "bounded chain");
});

Deno.test("a prior same-area reaffirmation is independent of the current read-only question", () => {
  const request =
    "Хочу заменить люстру в зале 30 квадратов, мощность от 20 Вт. Покажи варианты";
  const original = successfulSelection({ user_query: request });
  const reaffirmation = certifiedZeroCardTurn(
    "Они точно подходят для освещения 30 квадратных метров?",
    { id: "reaffirmation", created_at: minutesAgo(2) },
  );

  for (
    const question of [
      "А есть другие варианты?",
      "Почему эти варианты отличаются по цене?",
      "Почему варианты отличаются по цене? Сравни подтверждённые характеристики.",
      "Сколько стоят эти товары?",
      "Какой из этих вариантов самый дешёвый?",
    ]
  ) {
    const proof = resolveServerRenderedSelectionProof(
      [reaffirmation, original],
      sessionId,
      request,
      question,
      now,
    );
    assertEquals(proof?.baseRequest, request, `base for ${question}`);
    assertEquals(
      proof?.priorQueriesNewestFirst.join("|"),
      `${reaffirmation.user_query}|${request}`,
      `verified chain for ${question}`,
    );
  }
});

Deno.test("a current read-only question cannot validate a changed prior criterion", () => {
  const request =
    "Хочу заменить люстру в зале 30 квадратов, мощность от 20 Вт. Покажи варианты";
  const original = successfulSelection({ user_query: request });
  for (
    const changed of [
      "Они точно подходят для освещения 40 квадратных метров?",
      "Они точно подходят для спальни 30 квадратных метров?",
      "Подбери варианты до 5000 тенге",
      "Теперь нужен кабель",
    ]
  ) {
    assertEquals(
      resolveServerRenderedSelectionProof(
        [
          certifiedZeroCardTurn(changed, {
            id: "changed",
            created_at: minutesAgo(2),
          }),
          original,
        ],
        sessionId,
        request,
        "Сколько стоят эти товары?",
        now,
      ),
      null,
      `changed prior criterion: ${changed}`,
    );
  }
  assertEquals(
    resolveServerRenderedSelectionProof(
      [
        certifiedZeroCardTurn(
          "Они точно подходят для освещения 30 квадратных метров?",
          { id: "reaffirmation", created_at: minutesAgo(2) },
        ),
        original,
      ],
      sessionId,
      request,
      "Сколько стоят эти товары для спальни?",
      now,
    ),
    null,
    "changed current criterion",
  );
});

Deno.test("semantic changes between cards and other-options request cannot inherit old selection", () => {
  const request =
    "Хочу заменить люстру в гостиной 30 м², мощность от 20 Вт. Покажи варианты";
  const original = successfulSelection({ user_query: request });
  for (
    const changed of [
      "Они точно подходят для спальни?",
      "Они точно подходят для спальни 30 м²?",
      "Они точно подходят для освещения 40 м²?",
      "Сравни чёрные варианты",
      "Сравни варианты по цвету",
      "Почему эти варианты до 5000 тенге?",
      "Сравни варианты марки IEK",
      "Теперь найди кабель",
      "Покажи другие варианты для спальни",
    ]
  ) {
    assertEquals(
      resolveServerRenderedSelectionProof(
        [laterTurn(changed), original],
        sessionId,
        request,
        "А есть другие варианты?",
        now,
      ),
      null,
      changed,
    );
  }
});

Deno.test("proof requires exact current dependent wording and authentic completed server batch", () => {
  for (
    const [rows, proposed, current, session] of [
      [
        [successfulSelection()],
        base,
        "А для спальни есть другие варианты?",
        sessionId,
      ],
      [
        [successfulSelection()],
        `${base} Предел до 5000 тенге`,
        "А есть другие варианты?",
        sessionId,
      ],
      [
        [successfulSelection({ response_events: [] })],
        base,
        "А есть другие варианты?",
        sessionId,
      ],
      [
        [successfulSelection()],
        base,
        "А есть другие варианты?",
        "forged-session",
      ],
    ] as const
  ) {
    assertEquals(
      resolveServerRenderedSelectionProof(
        rows,
        session,
        proposed,
        current,
        now,
      ),
      null,
      "unverified proof",
    );
  }
});

Deno.test("shown URLs come only from completed server-rendered batches, not browser history", () => {
  const anotherCard =
    "- **[Вторая люстра](https://220volt.kz/catalog/svetotexnika/lyustry/lustra-2/)**\n  Цена: *11 500* ₸";
  const second = laterTurn("А есть другие варианты?", {
    response_events: [
      { type: "products_block", markdown: anotherCard, count: 1 },
      {
        type: "diagnostic",
        phase: "complete",
        log_id: "later",
        products_count: 1,
        error: null,
      },
      { type: "done" },
    ],
  });
  const proof = resolveServerRenderedSelectionProof(
    [second, successfulSelection()],
    sessionId,
    base,
    "А есть другие варианты?",
    now,
  );
  assertEquals(
    proof?.shownProductUrls.join("|"),
    "https://220volt.kz/catalog/svetotexnika/lyustry/lustra-1/|https://220volt.kz/catalog/svetotexnika/lyustry/lustra-2/",
    "only completed server URLs",
  );
  assertEquals(
    JSON.stringify(proof?.recentShownProductCards),
    JSON.stringify([{
      pagetitle: "Вторая люстра",
      url: "https://220volt.kz/catalog/svetotexnika/lyustry/lustra-2/",
    }]),
    "recovery title and URL are both from the latest completed server block",
  );
  for (
    const broken of [
      laterTurn("А есть другие варианты?", {
        response_events: [
          { type: "products_block", markdown: anotherCard, count: 1 },
          { type: "done" },
        ],
      }),
      laterTurn("А есть другие варианты?", {
        error: "upstream_unavailable",
        response_events: [
          { type: "products_block", markdown: anotherCard, count: 1 },
        ],
      }),
      laterTurn("А есть другие варианты?", {
        error: "upstream_unavailable",
        final_products_count: 1,
        response_events: [],
      }),
      laterTurn("А есть другие варианты?", {
        final_products_count: 2,
        response_events: [
          { type: "products_block", markdown: anotherCard, count: 2 },
          {
            type: "diagnostic",
            phase: "complete",
            log_id: "later",
            products_count: 2,
            error: null,
          },
          { type: "done" },
        ],
      }),
    ]
  ) {
    assertEquals(
      resolveServerRenderedSelectionProof(
        [broken, successfulSelection()],
        sessionId,
        base,
        "А есть другие варианты?",
        now,
      ),
      null,
      "partial or inconsistent dependent batch",
    );
  }
});

Deno.test("read-only evidence and price references require unchanged completed server scope", () => {
  const original = successfulSelection();
  for (
    const question of [
      "Почему эти варианты?",
      "Сколько стоят эти товары?",
      "Какие остатки у этих товаров?",
      "Они точно подходят для освещения 30 м²?",
      "Покажи их",
      "Какой из этих вариантов самый дешёвый?",
    ]
  ) {
    const proof = resolveServerRenderedSelectionProof(
      [original],
      sessionId,
      base,
      question,
      now,
    );
    assertEquals(
      proof?.recentShownProductCards[0]?.pagetitle,
      "Люстра для гостиной",
      question,
    );
  }
  for (
    const changed of [
      "Они точно подходят для спальни 30 м²?",
      "Они точно подходят для освещения 40 м²?",
      "Сколько стоят эти товары для кухни?",
      "Какие остатки у этих товаров в Алматы?",
      "Какой из этих вариантов до 5000 тенге самый дешёвый?",
    ]
  ) {
    assertEquals(
      resolveServerRenderedSelectionProof(
        [original],
        sessionId,
        base,
        changed,
        now,
      ),
      null,
      changed,
    );
  }
  const noBrowserCard = resolveServerRenderedSelectionProof(
    [original],
    sessionId,
    null,
    "Сколько стоят эти товары?",
    now,
  );
  assertEquals(
    noBrowserCard?.recentShownProductCards[0]?.pagetitle,
    "Люстра для гостиной",
    "server-only active card when browser omitted Markdown",
  );
  assertEquals(
    resolveServerRenderedSelectionProof(
      [
        laterTurn("Подбери кабель", {
          error: "upstream_unavailable",
          final_products_count: 0,
          response_events: [],
        }),
        original,
      ],
      sessionId,
      null,
      "Сколько стоят эти товары?",
      now,
    ),
    null,
    "later standalone request closes server-only scope",
  );
});

Deno.test("server card proof retains real formatted titles and canonicalizes controlled URLs", () => {
  const title = "LIGHTING Светильник 1011 40Вт 4000К 1200*54*58мм, белый ИЭК";
  const url =
    "https://220volt.kz/catalog/svetotexnika/svetilniki/lighting-1011-1200*54*58mm/?utm_source=widget";
  const formatted = successfulSelection({
    response_events: [
      {
        type: "products_block",
        count: 1,
        markdown: `- **[${title}](${url})**\n  Цена: *17 667* ₸`,
      },
      {
        type: "diagnostic",
        phase: "complete",
        log_id: "original-selection",
        products_count: 1,
        error: null,
      },
      { type: "done" },
    ],
  });
  const proof = resolveServerRenderedSelectionProof(
    [formatted],
    sessionId,
    base,
    "Почему эти варианты?",
    now,
  );
  assertEquals(proof?.recentShownProductCards[0]?.pagetitle, title, "title");
  assertEquals(
    proof?.recentShownProductCards[0]?.url,
    "https://220volt.kz/catalog/svetotexnika/svetilniki/lighting-1011-1200*54*58mm/",
    "canonical URL",
  );
});

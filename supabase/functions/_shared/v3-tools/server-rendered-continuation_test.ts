import {
  resolveServerRenderedSelectionBase,
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
  return successfulSelection({
    id: "later",
    user_query: query,
    created_at: minutesAgo(1),
    response_events: [
      { type: "diagnostic", phase: "start", log_id: "later" },
      { type: "products_block", markdown: card, count: 1 },
      {
        type: "diagnostic",
        phase: "complete",
        log_id: "later",
        products_count: 1,
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

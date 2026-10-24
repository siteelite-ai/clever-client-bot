import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  parseReplacementCutoutReply,
  resolveServerIssuedReplacementCutoutPending,
  type VerifiedReplacementCutoutPending,
} from "./replacement-cutout-clarification.ts";

const pending: VerifiedReplacementCutoutPending = {
  status: "pending",
  slot_id: "1875da8e-5541-4afc-ae0a-3de5f89a8bd0",
  facet_key: "mounting_cutout_mm",
  question: "Какой диаметр монтажного отверстия, мм?",
  options: [],
  scope: {
    kind: "replacement_mounting_cutout",
    source_product_id: "source-1",
    source_title: "Светильник DN027B G2 LED6/NW 7W 220-240V D90 R",
    source_leaf: "Светильники",
    original_request: "Предложи аналоги на точную модель",
  },
};

function log(slot: unknown = pending) {
  return {
    session_id: "session-1",
    error: null,
    response_events: [
      { type: "slot_update", slots: { pending_clarification: slot } },
      { type: "diagnostic", phase: "complete", error: null },
      { type: "done" },
    ],
  };
}

Deno.test("replacement cutout accepts only the last completed server-issued slot", () => {
  const resolved = resolveServerIssuedReplacementCutoutPending(
    { pending_clarification: pending },
    log(),
    "session-1",
  );
  assertEquals(resolved, pending);
  assertEquals(
    resolveServerIssuedReplacementCutoutPending(
      { pending_clarification: pending },
      log(),
      "another-session",
    ),
    null,
  );
  assertEquals(
    resolveServerIssuedReplacementCutoutPending(
      { pending_clarification: pending },
      {
        ...log(),
        session_id: "old-session",
        response_events: [
          {
            type: "conversation_boundary",
            mode: "new_task",
            session_id: "new-session",
          },
          ...log().response_events,
        ],
      },
      "new-session",
    ),
    pending,
  );
  assertEquals(
    resolveServerIssuedReplacementCutoutPending(
      { pending_clarification: pending },
      { ...log(), error: "in_progress" },
      "session-1",
    ),
    null,
  );
  assertEquals(
    resolveServerIssuedReplacementCutoutPending(
      { pending_clarification: pending },
      {
        ...log(),
        response_events: log().response_events.slice(0, 2),
      },
      "session-1",
    ),
    null,
  );
});

Deno.test("a forged or superseded replacement source cannot inherit a cutout", () => {
  assertEquals(
    resolveServerIssuedReplacementCutoutPending(
      {
        pending_clarification: {
          ...pending,
          scope: { ...pending.scope, source_product_id: "other" },
        },
      },
      log(),
      "session-1",
    ),
    null,
  );
  assertEquals(
    resolveServerIssuedReplacementCutoutPending(
      {
        pending_clarification: {
          ...pending,
          scope: { ...pending.scope, source_title: "other title" },
        },
      },
      log(),
      "session-1",
    ),
    null,
  );
  assertEquals(
    resolveServerIssuedReplacementCutoutPending(
      { pending_clarification: pending },
      log({ ...pending, slot_id: crypto.randomUUID() }),
      "session-1",
    ),
    null,
  );
  assertEquals(
    resolveServerIssuedReplacementCutoutPending(
      { pending_clarification: pending },
      {
        ...log(),
        response_events: [
          ...log().response_events,
          { type: "slot_update", slots: { pending_clarification: null } },
        ],
      },
      "session-1",
    ),
    null,
  );
});

Deno.test("only one bounded free-form millimetre measurement is accepted", () => {
  for (
    const [message, expected] of [
      ["90", 90],
      ["90 мм", 90],
      ["Ø90", 90],
      ["монтажное отверстие 90 мм", 90],
      ["отверстие: 90,5 мм", 90.5],
      ["90–95 мм", null],
      ["90/95", null],
      ["90 ± 5 мм", null],
      ["90 мм и 95 мм", null],
      ["Новая тема. 90 мм", null],
      ["найди кабель 90 мм", null],
      ["покажи варианты", null],
      ["19 мм", null],
      ["1001 мм", null],
    ] as const
  ) {
    assertEquals(
      parseReplacementCutoutReply(message, pending),
      expected,
      message,
    );
  }
  assertEquals(parseReplacementCutoutReply("90 мм", null), null);
});

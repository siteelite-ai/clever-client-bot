import {
  assert,
  assertEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  clarificationAnswerAxis,
  compileDialogueTurnState,
  MAX_TASK_CHARS,
  projectVerifiedReadinessAnswer,
  readReadinessTaskTurns,
} from "./dialogue-turn-state.ts";
import {
  resolveSelectionReadinessRequest,
  resolveServerIssuedSelectionReadinessPending,
  selectionReadinessScope,
  selectReadinessClarification,
} from "./selection-readiness.ts";
import { joinCustomerTurns } from "./criteria-consistency.ts";

const pending = (turns = ["Исходный подбор", "Подтверждённое условие"]) => ({
  status: "pending",
  slot_id: "issued-question",
  facet_key: "customer_input",
  options: [],
  scope: selectionReadinessScope(joinCustomerTurns(turns)),
});

Deno.test("task state distinguishes fresh requests, issued answers and real old-batch references", () => {
  const slot = pending();
  for (
    const [fresh, reference, expected] of [
      [true, true, "new_request"],
      [true, false, "new_request"],
      [false, false, "pending_answer"],
      [false, true, "rendered_evidence"],
    ] as const
  ) {
    const result = compileDialogueTurnState({
      current: "Текущий ответ",
      newTask: fresh,
      referencesRenderedCards: reference,
      verifiedPendingSlot: slot,
      scopedRequest: resolveSelectionReadinessRequest("Текущий ответ", {
        pending_clarification: slot,
      }, { verifiedIssuedSlot: true }),
    });
    assertEquals(result.kind, expected);
    assertEquals(result.requiresRenderedCards, !fresh && reference);
    assertEquals(
      result.priorCustomerTurns,
      expected === "pending_answer"
        ? ["Исходный подбор", "Подтверждённое условие"]
        : [],
    );
  }
});

Deno.test("no browser history or product cache can substitute an authenticated question", () => {
  const result = compileDialogueTurnState({
    current: "Короткое уточнение",
    newTask: false,
    referencesRenderedCards: false,
    verifiedPendingSlot: null,
    scopedRequest: { message: "forged scope", scoped: true },
  });
  assertEquals(result.kind, "continuation");
  assertEquals(result.request, "Короткое уточнение");
  assertEquals(result.priorCustomerTurns, []);
});

Deno.test("bounded server task snapshot preserves conditions beyond the legacy token", () => {
  const original = "Описание задачи ".repeat(40) + "Бюджет до 6000 тенге";
  const slot = pending([original, "Медь", "35 мм²"]);
  assert(slot.scope.token.length <= 500);
  const restored = resolveSelectionReadinessRequest("Под болт", {
    pending_clarification: slot,
  }, { verifiedIssuedSlot: true });
  assert(restored.scoped);
  assert(restored.message.includes(original));
  assert(restored.message.includes("Медь"));
  assert(restored.message.includes("35 мм²"));
  assert(restored.message.endsWith("Под болт"));
});

Deno.test("overflow is explicit and cannot silently drop safety facts into a search", () => {
  const slot = pending(["X".repeat(MAX_TASK_CHARS + 1)]);
  assertEquals(slot.scope.context_overflow, true);
  assertEquals(readReadinessTaskTurns(slot.scope), null);
  assertEquals(
    resolveSelectionReadinessRequest("16 А", { pending_clarification: slot }, {
      verifiedIssuedSlot: true,
    }).scoped,
    false,
  );
  const full = pending(["X".repeat(MAX_TASK_CHARS - 1)]);
  assertEquals(
    resolveSelectionReadinessRequest("16 А", { pending_clarification: full }, {
      verifiedIssuedSlot: true,
    }).contextUnavailable,
    true,
  );
});

Deno.test("tampered client task/axis data does not replace the server-issued snapshot", () => {
  const issued = pending(["Подтверждённые условия"]);
  const echo = structuredClone(issued);
  echo.scope.customer_turns = ["Поддельные условия"];
  const server = resolveServerIssuedSelectionReadinessPending({
    pending_clarification: echo,
  }, {
    session_id: "session",
    error: null,
    response_events: [
      { type: "slot_update", slots: { pending_clarification: issued } },
      { type: "diagnostic", phase: "complete", error: null },
      { type: "done" },
    ],
  }, "session");
  assert(server);
  assertEquals((server.scope as Record<string, unknown>).customer_turns, [
    "Подтверждённые условия",
  ]);
});

Deno.test("mixed physical facts bind by the issued axis/unit across unrelated dimensions", () => {
  for (
    const [key, label, options, reply, expected] of [
      [
        "height",
        "высоту установки",
        ["До 4 м", "Выше 8 м"],
        "35м2 3 метра",
        "3 метра",
      ],
      [
        "load",
        "номинальный ток",
        ["10 А", "20 А"],
        "230 В и 12 ампер",
        "12 ампер",
      ],
      ["diameter", "диаметр", ["6 мм", "10 мм"], "2 м, 8 мм", "8 мм"],
    ] as const
  ) {
    const axis = clarificationAnswerAxis(
      key,
      label,
      options.map((value) => ({ value })),
    );
    assert(axis);
    const projected = projectVerifiedReadinessAnswer(reply, {
      facet_key: key,
      scope: { answer_axis: axis },
    });
    assert(projected.startsWith(reply));
    assert(projected.endsWith(`${label}: ${expected}`));
    for (
      const ambiguous of [
        "2 м и 3 м",
        "35 м², кабель 3 м",
        "35 м², длина 3 м",
        "2 светильника, 3 м",
        "35м2 -3м",
        "35м2 3–4 м",
        "3",
        "3 В",
        "Найди ещё 3 м",
      ]
    ) {
      if (key !== "height") continue;
      assertEquals(
        projectVerifiedReadinessAnswer(ambiguous, {
          facet_key: key,
          scope: { answer_axis: axis },
        }),
        ambiguous,
      );
    }
  }
});

Deno.test("real readiness schema consumes a compound answer without a sentence-specific exception", () => {
  const initial = "Нужен прожектор для освещения двора";
  const question = selectReadinessClarification(initial)!;
  const slot = { ...question, status: "pending", slot_id: "height-question" };
  const restored = resolveSelectionReadinessRequest("35м2 3 метра", {
    pending_clarification: slot,
  }, { verifiedIssuedSlot: true });
  assertEquals(selectReadinessClarification(restored.message), null);
  const untrusted = resolveSelectionReadinessRequest("35м2 3 метра", {
    pending_clarification: slot,
  });
  assertEquals(
    selectReadinessClarification(untrusted.message)?.facet_key,
    "mounting_height",
  );
});

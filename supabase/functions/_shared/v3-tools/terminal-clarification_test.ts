import {
  assert,
  assertEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import { executeProposeClarification } from "./propose-clarification.ts";
import { replayableSseEvents } from "./sse-replay.ts";
import {
  auditTerminalClarificationProtocol,
  buildTerminalFreeformSlot,
  terminalCustomerAsk,
} from "./terminal-clarification.ts";

Deno.test("no-tool final answer keeps its prose and receives a free-form slot", () => {
  const events = [
    { type: "delta", content: "Для выбора важна фактическая нагрузка. " },
    { type: "delta", content: "Какая мощность у вашего котла?" },
  ];
  const addition = auditTerminalClarificationProtocol(events, "server-slot-1");
  assertEquals(addition, {
    type: "slot_update",
    slots: {
      pending_clarification: {
        status: "pending",
        slot_id: "server-slot-1",
        facet_key: "terminal_followup",
        question: "Какая мощность у вашего котла?",
        options: [],
      },
    },
  });
  assertEquals(
    events.map((event) => event.content).join(""),
    "Для выбора важна фактическая нагрузка. Какая мощность у вашего котла?",
  );
});

Deno.test("broad assortment without a series has a non-scoped free-form slot", () => {
  const answer =
    "Уточните, пожалуйста, какой раздел или тип товара показать: широкий ассортимент нельзя честно представить несколькими случайными карточками.";
  const slot = buildTerminalFreeformSlot(answer, "server-slot-2");
  assertEquals(slot.facet_key, "terminal_followup");
  assertEquals(slot.options, []);
  assertEquals("scope" in slot, false);
  assertEquals(
    auditTerminalClarificationProtocol([
      { type: "delta", content: answer },
      { type: "slot_update", slots: { pending_clarification: slot } },
    ], "unneeded-slot"),
    null,
  );
});

Deno.test("clarification slot precedes completion and survives replay in order", () => {
  const events = [{ type: "delta", content: "Какой бюджет вам удобен?" }];
  const addition = auditTerminalClarificationProtocol(events, "server-slot-3");
  assert(addition);
  const closed = [
    ...events,
    addition,
    { type: "diagnostic", log_id: "request-1", phase: "complete" },
    { type: "done" },
  ];
  assertEquals(closed.map((event) => event.type), [
    "delta",
    "slot_update",
    "diagnostic",
    "done",
  ]);
  assertEquals(replayableSseEvents(closed), closed);
});

Deno.test("an embedded, quoted, FAQ, or rhetorical question is not a final ask", () => {
  for (
    const content of [
      "Что вам нужно? Ниже перечислены подходящие варианты.",
      "Пример вопроса: «Какой бюджет вам удобен?»",
      "FAQ: Какой бюджет вам удобен?",
      "> Какой бюджет вам удобен?",
      "Почему это важно?",
      "Что такое серия Gallant?",
    ]
  ) {
    assertEquals(terminalCustomerAsk([{ type: "delta", content }]), null);
  }
  assertEquals(
    terminalCustomerAsk([
      { type: "delta", content: "Какой бюджет вам удобен?" },
      { type: "assistant_turn_break", reason: "tool_pending" },
    ]),
    null,
  );
});

Deno.test("an honest shortage followed by a direct clarification still retains a free-form answer", () => {
  const question = "Уточните нужный раздел или точный артикул.";
  const events = [{
    type: "delta",
    content: `Не удалось подтвердить все карточки по каталогу. ${question}`,
  }];
  assertEquals(
    auditTerminalClarificationProtocol(events, "server-slot-shortage")?.slots
      .pending_clarification.question,
    question,
  );
});

Deno.test("source-like technical clarification questions get free-form slots", () => {
  for (
    const question of [
      "Какую площадь освещать?",
      "Какую длину линии нужно покрыть?",
      "Какой ток нужен?",
      "Какой тип сети у вас?",
    ]
  ) {
    assertEquals(
      auditTerminalClarificationProtocol(
        [{ type: "delta", content: question }],
        "server-slot-tech",
      )?.slots.pending_clarification.question,
      question,
    );
  }
});

Deno.test("existing valid chip and slot pair is not replaced by invented freeform", () => {
  const question = "Какой раздел показать?";
  const clarification = executeProposeClarification({
    question,
    facet_key: "catalog_section",
    options: [
      { value: "Розетки" },
      { value: "Выключатели" },
    ],
  });
  assert(clarification.ok);
  const events = [
    { type: "delta", content: question },
    ...(clarification.side_effects ?? []),
  ];
  assertEquals(
    auditTerminalClarificationProtocol(events, "unneeded-slot"),
    null,
  );
  assertEquals(events[1].type, "quick_replies");
  assertEquals(events[2].type, "slot_update");
});

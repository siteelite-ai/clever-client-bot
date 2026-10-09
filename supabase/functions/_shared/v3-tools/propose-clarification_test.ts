import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  acceptedClarificationDelivery,
  classifyClarificationToolBatch,
  executeProposeClarification,
  priorVisibleQuestionMayDuplicateClarification,
} from "./propose-clarification.ts";

const valid = {
  question: "Какой вариант нужен?",
  facet_key: "installation_method",
  options: [
    { value: "На улице", label: "На улице" },
    { value: "В помещении", label: "В помещении" },
  ],
};

Deno.test("clarification emits widget-compatible replies paired with its slot", () => {
  const result = executeProposeClarification(valid);
  assertEquals(result.ok, true);
  if (!result.ok) return;
  const sideEffects = result.side_effects ?? [];
  const replies = sideEffects.find((event) => event.type === "quick_replies");
  const slot = sideEffects.find((event) => event.type === "slot_update");
  assertEquals(replies?.type, "quick_replies");
  assertEquals(slot?.type, "slot_update");
  if (replies?.type === "quick_replies" && slot?.type === "slot_update") {
    assertEquals(
      (slot.slots.pending_clarification as { options: unknown }).options,
      replies.replies,
    );
  }
});

Deno.test("clarification rejects options the embed widget would silently discard", () => {
  for (
    const options of [
      [{ value: "A" }, { value: "A" }],
      [{ value: " A" }, { value: "B" }],
      [{ value: "A", label: " " }, { value: "B" }],
      [{ value: "A", label: "x".repeat(161) }, { value: "B" }],
      [{ value: "A".repeat(2001) }, { value: "B" }],
      [{ value: "A" }, { value: "" }],
    ]
  ) {
    assertEquals(
      executeProposeClarification({ ...valid, options }).ok,
      false,
      JSON.stringify(options).slice(0, 80),
    );
  }
  assertEquals(
    executeProposeClarification({ ...valid, facet_key: "x".repeat(129) }).ok,
    false,
  );
});

Deno.test("clarification is an exclusive terminal tool call", () => {
  assertEquals(classifyClarificationToolBatch([]), "none");
  assertEquals(classifyClarificationToolBatch(["render_products"]), "none");
  assertEquals(
    classifyClarificationToolBatch(["propose_clarification"]),
    "single",
  );
  for (
    const names of [
      ["propose_clarification", "render_products"],
      ["render_products", "propose_clarification"],
      ["propose_clarification", "propose_clarification"],
      ["search_catalog", "propose_clarification"],
      ["propose_clarification", "lookup_contacts"],
    ]
  ) {
    assertEquals(
      classifyClarificationToolBatch(names),
      "conflict",
      names.join(","),
    );
  }
});

Deno.test("accepted clarification delivery is one normalized server question paired with chips and slot", () => {
  const result = executeProposeClarification({
    ...valid,
    question: "  Какой вариант нужен?  ",
  });
  assertEquals(result.ok, true);
  if (!result.ok) return;
  const delivery = acceptedClarificationDelivery(result);
  assertEquals(delivery?.question, "Какой вариант нужен?");
  assertEquals(delivery?.side_effects.map((effect) => effect.type), [
    "quick_replies",
    "slot_update",
  ]);
  assertEquals(delivery?.side_effects, result.side_effects);
});

Deno.test("prior streamed intro question is explicitly detectable before a later clarification", () => {
  assertEquals(
    priorVisibleQuestionMayDuplicateClarification(
      "Какой тип установки вам нужен? Сейчас проверю варианты.",
    ),
    true,
  );
  assertEquals(
    priorVisibleQuestionMayDuplicateClarification(
      "Проверяю доступные варианты в каталоге.",
    ),
    false,
  );
});

Deno.test("clarification delivery fails closed on missing, duplicate, or mismatched side effects", () => {
  const result = executeProposeClarification(valid);
  assertEquals(result.ok, true);
  if (!result.ok) return;
  const effects = result.side_effects ?? [];
  const replies = effects[0];
  const slot = effects[1];
  assertEquals(replies.type, "quick_replies");
  assertEquals(slot.type, "slot_update");
  if (replies.type !== "quick_replies" || slot.type !== "slot_update") return;

  assertEquals(
    acceptedClarificationDelivery({ ...result, side_effects: [] }),
    null,
  );
  assertEquals(
    acceptedClarificationDelivery({
      ...result,
      side_effects: [replies, slot, replies],
    }),
    null,
  );
  assertEquals(
    acceptedClarificationDelivery({
      ...result,
      side_effects: [slot, replies],
    }),
    null,
  );
  assertEquals(
    acceptedClarificationDelivery({
      ...result,
      side_effects: [
        replies,
        {
          ...slot,
          slots: {
            ...slot.slots,
            pending_clarification: {
              ...(slot.slots.pending_clarification as Record<string, unknown>),
              facet_key: "other_facet",
            },
          },
        },
      ],
    }),
    null,
  );
});

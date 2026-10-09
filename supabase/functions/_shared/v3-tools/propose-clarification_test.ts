import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { executeProposeClarification } from "./propose-clarification.ts";

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
  const replies = sideEffects.find((event) =>
    event.type === "quick_replies"
  );
  const slot = sideEffects.find((event) =>
    event.type === "slot_update"
  );
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
  for (const options of [
    [{ value: "A" }, { value: "A" }],
    [{ value: " A" }, { value: "B" }],
    [{ value: "A", label: " " }, { value: "B" }],
    [{ value: "A", label: "x".repeat(161) }, { value: "B" }],
    [{ value: "A".repeat(2001) }, { value: "B" }],
    [{ value: "A" }, { value: "" }],
  ]) {
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

import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { executeProposeClarification } from "./propose-clarification.ts";

const basic = {
  question: "Какая полюсность нужна?",
  facet_key: "pole_count",
  options: [
    { value: "1P", label: "Один полюс" },
    { value: "2P", label: "Два полюса" },
  ],
};

Deno.test("clarification emits the same bounded options in chips and pending slot", () => {
  const result = executeProposeClarification(basic);
  assertEquals(result.ok, true);
  if (!result.ok) return;
  const replies = result.side_effects?.find((event) => event.type === "quick_replies");
  const update = result.side_effects?.find((event) => event.type === "slot_update");
  assertEquals(replies?.type, "quick_replies");
  assertEquals(update?.type, "slot_update");
  if (replies?.type !== "quick_replies" || update?.type !== "slot_update") return;
  const pending = update.slots.pending_clarification as Record<string, unknown>;
  assertEquals(pending.slot_id, result.slot_id);
  assertEquals(pending.options, replies.replies);
});

Deno.test("freeform clarification has a pending slot but no invented values", () => {
  const result = executeProposeClarification({
    question: "Какая площадь двора?",
    facet_key: "yard_area",
    options: [],
    freeform: true,
  });
  assertEquals(result.ok, true);
  if (!result.ok) return;
  assertEquals(result.side_effects?.map((event) => event.type), ["slot_update"]);
  const update = result.side_effects?.[0];
  if (update?.type !== "slot_update") return;
  assertEquals((update.slots.pending_clarification as { options: unknown }).options, []);
});

Deno.test("malformed options cannot create a hidden or ambiguous pending choice", () => {
  const invalid = [
    { ...basic, facet_key: "x".repeat(129) },
    { ...basic, question: "x".repeat(8_001) },
    { ...basic, options: [basic.options[0]] },
    { ...basic, options: Array.from({ length: 6 }, (_, n) => ({ value: `${n}` })) },
    { ...basic, options: [{ value: "1P ", label: "Один полюс" }, basic.options[1]] },
    { ...basic, options: [{ value: "1P", label: "Один полюс " }, basic.options[1]] },
    { ...basic, options: [{ value: "x".repeat(2_001), label: "Длинный" }, basic.options[1]] },
    { ...basic, options: [{ value: "1P", label: "x".repeat(161) }, basic.options[1]] },
    { ...basic, options: [basic.options[0], { value: "1P", label: "Два полюса" }] },
    { ...basic, options: [basic.options[0], { value: "2P", label: "Один полюс" }] },
    { ...basic, freeform: true },
    { ...basic, question: 42 },
    { ...basic, facet_key: null },
  ];
  for (const input of invalid) {
    const result = executeProposeClarification(input as typeof basic);
    assertEquals(result.ok, false);
    if (!result.ok) assertEquals("side_effects" in result, false);
  }
});

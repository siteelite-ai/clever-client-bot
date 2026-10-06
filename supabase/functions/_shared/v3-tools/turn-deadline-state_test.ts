import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  classifyTurnDeadline,
  publicTurnDeadlineOutcome,
} from "./turn-deadline-state.ts";

Deno.test("model-only wall-clock expiry is a generic turn timeout, not a catalog failure", () => {
  const state = {
    turnDeadlineAtMs: 32_000,
    catalogDeadlineExceeded: false,
    turnDeadlineExceeded: false,
  };
  assertEquals(classifyTurnDeadline(state, 31_999), null);
  assertEquals(classifyTurnDeadline(state, 32_000), "turn");
  state.turnDeadlineExceeded = true;
  const publicOutcome = publicTurnDeadlineOutcome(state, 0);
  assertEquals(publicOutcome?.code, "turn_deadline_exceeded");
  assertEquals(publicOutcome?.message.includes("проверку каталога"), false);
});

Deno.test("an actual catalog deadline remains distinct and marks verified partial output", () => {
  const state = {
    turnDeadlineAtMs: 32_000,
    catalogDeadlineExceeded: true,
    turnDeadlineExceeded: false,
  };
  assertEquals(classifyTurnDeadline(state, 32_001), "catalog");
  assertEquals(
    publicTurnDeadlineOutcome(state, 2)?.code,
    "catalog_deadline_partial",
  );
});

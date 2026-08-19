import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { rankSplitReplacementCandidates } from "./replacement-fallback.ts";

Deno.test("ordinary analogue fallback ranks shared-axis evidence and excludes the source", () => {
  assertEquals(rankSplitReplacementCandidates([
    { key: "power", ids: ["anchor", "both", "power-only"] },
    { key: "diameter", ids: ["anchor", "both", "diameter-only"] },
  ], new Set(["anchor"])), [
    { id: "both", matched_axis_keys: ["power", "diameter"] },
    { id: "power-only", matched_axis_keys: ["power"] },
    { id: "diameter-only", matched_axis_keys: ["diameter"] },
  ]);
});

Deno.test("three-axis fallback rejects a candidate supported by only one axis", () => {
  assertEquals(rankSplitReplacementCandidates([
    { key: "power", ids: ["one", "two"] },
    { key: "diameter", ids: ["two"] },
    { key: "voltage", ids: ["three"] },
  ], new Set()), [
    { id: "two", matched_axis_keys: ["power", "diameter"] },
  ]);
});

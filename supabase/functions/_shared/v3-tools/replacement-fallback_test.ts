import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  classifyNamedTraitEvidence,
  intersectReplacementAxisEvidence,
  rankSplitReplacementCandidates,
} from "./replacement-fallback.ts";

Deno.test("a named trait mismatch cannot be rescued by an unrelated equal number", () => {
  assertEquals(classifyNamedTraitEvidence(
    ["Номинальная мощность: 5", "Номинальный ток: 10"],
    "Номинальная мощность",
    (actual) => actual === "10",
  ), "contradicted");
  assertEquals(classifyNamedTraitEvidence(
    ["Номинальная мощность: 10", "Номинальный ток: 10"],
    "Номинальная мощность",
    (actual) => actual === "10",
  ), "proven");
});

Deno.test("strict replacement is non-empty only when one card proves every axis", () => {
  assertEquals(intersectReplacementAxisEvidence([
    { key: "power", ids: ["power-only", "exact"] },
    { key: "phase", ids: ["phase-only", "exact"] },
    { key: "type", ids: ["exact", "type-only"] },
  ]), ["exact"]);
  assertEquals(intersectReplacementAxisEvidence([
    { key: "power", ids: ["power-only"] },
    { key: "phase", ids: ["phase-only"] },
  ]), []);
});

Deno.test("ordinary analogue fallback ranks shared-axis evidence and excludes the source", () => {
  assertEquals(rankSplitReplacementCandidates([
    { key: "power", ids: ["anchor", "both", "power-only"], total: 33 },
    { key: "diameter", ids: ["anchor", "both", "diameter-only"], total: 2 },
  ], new Set(["anchor"])), [
    { id: "both", matched_axis_keys: ["power", "diameter"] },
    { id: "diameter-only", matched_axis_keys: ["diameter"] },
    { id: "power-only", matched_axis_keys: ["power"] },
  ]);
});

Deno.test("three-axis near analogue ranks selective one-axis evidence above a generic axis", () => {
  assertEquals(rankSplitReplacementCandidates([
    { key: "power", ids: ["power-only", "two"], total: 33 },
    { key: "diameter", ids: ["two"], total: 2 },
    { key: "led", ids: ["generic"], total: 1200 },
  ], new Set()), [
    { id: "two", matched_axis_keys: ["power", "diameter"] },
    { id: "power-only", matched_axis_keys: ["power"] },
    { id: "generic", matched_axis_keys: ["led"] },
  ]);
});

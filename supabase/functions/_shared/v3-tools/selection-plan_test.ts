import {
  assertEquals,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  buildReplacementSelectionPlan,
  selectionPlanSystemHint,
} from "./selection-plan.ts";

Deno.test("replacement plan separates source identity from portable literals", () => {
  assertEquals(
    buildReplacementSelectionPlan(
      "ДКУ-LED-03-100W предложи близкую замену",
      "anchor_missing",
    ),
    {
      mode: "replacement",
      anchor_state: "anchor_missing",
      source_identifiers: ["ДКУ-LED-03-100W"],
      portable_requirements: [{ value: "100W", source: "user_literal" }],
    },
  );
});

Deno.test("missing-anchor hint preserves reasoning and forbids repeated lookup", () => {
  const hint = selectionPlanSystemHint(
    buildReplacementSelectionPlan("Замена QX-900 16A", "anchor_missing"),
  );
  assertStringIncludes(hint, "Не повторяй поиск исходной модели");
  assertStringIncludes(hint, "собственное уже сформулированное рассуждение");
  assertStringIncludes(hint, "16A");
});

Deno.test("selection plan is silent for a resolved anchor", () => {
  assertEquals(
    selectionPlanSystemHint(
      buildReplacementSelectionPlan("Замена QX-900", "found"),
    ),
    "",
  );
});

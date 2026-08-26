import {
  assertEquals,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  buildReplacementSelectionPlan,
  compileReplacementReasoningContract,
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

Deno.test("replacement reasoning compiles portable live facets and drops source identity plus advice", () => {
  const contract = compileReplacementReasoningContract([
    { key: "poles", caption: "Количество полюсов", unit: null, values: [{ value: "1" }, { value: "3" }] },
    { key: "current", caption: "Номинальный ток", unit: "А", values: [{ value: "16" }, { value: "800" }] },
    { key: "curve", caption: "Характеристика срабатывания", unit: null, values: [{ value: "B" }, { value: "C" }] },
    { key: "kollekciya", caption: "Коллекция (серия)", unit: null, values: [{ value: "Acti9" }] },
  ],
  "Acti9 C16 — 1-полюсный скорее всего. Ключевые параметры: номинальный ток 16 А, характеристика срабатывания C.",
  "Подбери аналог Schneider Acti9 C16",
  "Подбери аналог Schneider Acti9 C16");

  assertEquals(contract.options, { current: ["16"], curve: ["C"] });
  assertEquals(contract.criteria.map((criterion) => criterion.key), [
    "Номинальный ток",
    "Характеристика срабатывания",
  ]);
  assertEquals(contract.demoted, ["Количество полюсов"]);
});

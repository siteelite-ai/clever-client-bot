import {
  assertEquals,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  buildReplacementSelectionPlan,
  compileReplacementReasoningContract,
  compileReplacementRenderTitleAxes,
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
    { key: "curve", caption: "Характеристика срабатывания", unit: null, values: [{ value: "Тип B" }, { value: "Тип C" }] },
    { key: "kollekciya", caption: "Коллекция (серия)", unit: null, values: [{ value: "Acti9" }] },
  ],
  "Acti9 C16 — 1-полюсный скорее всего. Ключевые параметры: номинальный ток 16 А, характеристика C.",
  "Подбери аналог Schneider Acti9 C16",
  "Подбери аналог Schneider Acti9 C16");

  assertEquals(contract.options, { current: ["16"], curve: ["Тип C"] });
  assertEquals(contract.criteria.map((criterion) => criterion.key), [
    "Номинальный ток",
    "Характеристика срабатывания",
  ]);
  assertEquals(contract.demoted, ["Количество полюсов"]);
  assertEquals(contract.axes.map((axis) => ({ caption: axis.caption, values: axis.values, unit: axis.unit })), [
    { caption: "Номинальный ток", values: ["16"], unit: "А" },
    { caption: "Характеристика срабатывания", values: ["Тип C"], unit: null },
  ]);
  assertEquals(contract.title_axes.length, 3);
});

Deno.test("a short followup compiles the prior replacement reasoning into the same live contract", () => {
  const contract = compileReplacementReasoningContract([
    { key: "current", caption: "Номинальный ток", unit: "А", values: [{ value: "16" }, { value: "32" }] },
    { key: "curve", caption: "Характеристика срабатывания", unit: null, values: [{ value: "B" }, { value: "C" }] },
  ],
  "покажи\nРанее определено: ключевые параметры аналога — номинальный ток 16 А, характеристика C.",
  "Подбери аналог Schneider Acti9 C16\nпокажи",
  "Подбери аналог Schneider Acti9 C16");

  assertEquals(contract.options, { current: ["16"], curve: ["C"] });
  assertEquals(contract.criteria.map((criterion) => criterion.key), [
    "Номинальный ток",
    "Характеристика срабатывания",
  ]);
  assertEquals(contract.axes.length, 2);
  assertEquals(contract.title_axes.length, 2);
});

Deno.test("advisory retrieval axes still preserve explicit compact title codes", () => {
  const contract = compileReplacementReasoningContract([
    { key: "current", caption: "Номинальный ток", unit: "А", values: [{ value: "16" }, { value: "32" }] },
    { key: "curve", caption: "Характеристика срабатывания", unit: null, values: [{ value: "B" }, { value: "C" }] },
  ],
  "Ищу замену: номинал 16 А и характеристика C выглядят подходящими вариантами.",
  "Подбери аналог Schneider Acti9 C16",
  "Подбери аналог Schneider Acti9 C16");

  assertEquals(contract.title_axes.map((axis) => axis.values), [["16"], ["C"]]);
});

Deno.test("final structured criteria supply title axes without restoring source identity", () => {
  const facets = [
    { key: "brand", caption: "Бренд", unit: null, values: [{ value: "Schneider" }] },
    { key: "series", caption: "Коллекция", unit: null, values: [{ value: "Acti9" }] },
    { key: "current", caption: "Номинальный ток", unit: null, values: [{ value: "10" }, { value: "16" }] },
    { key: "curve", caption: "Характеристика срабатывания", unit: null, values: [{ value: "B" }, { value: "C" }] },
  ];
  const axes = compileReplacementRenderTitleAxes(facets, [
    { key: "Бренд", op: "eq", value: "Schneider", level: "A" },
    { key: "Коллекция", op: "eq", value: "Acti9", level: "A" },
    { key: "Номинальный ток", op: "eq", value: "16", unit: "А", level: "B" },
    { key: "Характеристика срабатывания", op: "eq", value: "C", level: "B" },
  ], "Подбери аналог Schneider Acti9 C16");

  assertEquals(axes.map((axis) => ({ key: axis.key, values: axis.values })), [
    { key: "current", values: ["16"] },
    { key: "curve", values: ["C"] },
  ]);
});

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
  assertEquals(contract.title_axes.length, 2);
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

Deno.test("missing anchor does not promote characteristics guessed from a model identifier", () => {
  const contract = compileReplacementReasoningContract([
    { key: "power", caption: "Номинальная мощность, кВа", unit: "кВа", values: [{ value: "5" }, { value: "10" }] },
    { key: "stabilization", caption: "Тип стабилизации", unit: null, values: [{ value: "релейный" }, { value: "электронный" }] },
    { key: "mount", caption: "Исполнение", unit: null, values: [{ value: "напольный" }, { value: "настенный" }] },
  ],
  "ACH-10001-C, судя по обозначению, должен иметь параметры: Номинальная мощность, кВа: 10; Тип стабилизации: релейный; Исполнение: напольный. Это ключевые параметры аналога.",
  "подбери аналоги для Стабилизатора ACH-10001-C",
  "подбери аналоги для Стабилизатора ACH-10001-C");

  assertEquals(contract.criteria, []);
  assertEquals(contract.options, {});
  assertEquals(contract.axes, []);
  assertEquals(contract.title_axes, []);
  assertEquals(new Set(contract.demoted), new Set([
    "Номинальная мощность, кВа",
    "Тип стабилизации",
    "Исполнение",
  ]));
});

Deno.test("literal customer requirements remain hard without a source card", () => {
  const contract = compileReplacementReasoningContract([
    { key: "power", caption: "Номинальная мощность, кВа", unit: "кВа", values: [{ value: "5" }, { value: "10" }] },
    { key: "stabilization", caption: "Тип стабилизации", unit: null, values: [{ value: "релейный" }, { value: "электронный" }] },
  ],
  "Ключевые параметры: Номинальная мощность, кВа: 10; Тип стабилизации: релейный.",
  "Нужен аналог AX-900: обязательно 10 кВА и релейный.",
  "Нужен аналог AX-900: обязательно 10 кВА и релейный.");

  assertEquals(contract.options, { power: ["10"], stabilization: ["релейный"] });
  assertEquals(new Set(contract.criteria.map((criterion) => criterion.key)), new Set([
    "Номинальная мощность, кВа",
    "Тип стабилизации",
  ]));
});

Deno.test("a frozen literal measurement shapes missing-anchor retrieval", () => {
  const contract = compileReplacementReasoningContract([
    { key: "lamp_type", caption: "Тип лампы", unit: null, values: [{ value: "LED" }] },
    { key: "power", caption: "Мощность ламп, Вт", unit: "Вт", values: [{ value: "70" }, { value: "100" }] },
  ],
  "Ищу светильник с типом лампы LED.",
  "ДКУ-LED-03-100W предложи близкую замену",
  "ДКУ-LED-03-100W предложи близкую замену",
  [{ key: "Мощность ламп, Вт", op: "eq", value: "100", unit: "Вт", level: "A" }]);

  assertEquals(contract.options, { lamp_type: ["LED"], power: ["100"] });
  assertEquals(contract.criteria.map((criterion) => criterion.key), [
    "Тип лампы",
    "Мощность ламп, Вт",
  ]);
  assertEquals(contract.title_axes.map((axis) => axis.key), ["lamp_type", "power"]);
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

Deno.test("missing-anchor render axes require literal customer proof", () => {
  const facets = [
    { key: "power", caption: "Номинальная мощность, кВа", unit: "кВа", values: [{ value: "10" }] },
    { key: "stabilization", caption: "Тип стабилизации", unit: null, values: [{ value: "релейный" }] },
  ];
  const inferred = compileReplacementRenderTitleAxes(facets, [
    { key: "Номинальная мощность, кВа", op: "eq", value: "10", unit: "кВа", level: "A" },
    { key: "Тип стабилизации", op: "eq", value: "релейный", level: "A" },
  ], "подбери аналоги для Стабилизатора ACH-10001-C", true);
  assertEquals(inferred, []);

  const explicit = compileReplacementRenderTitleAxes(facets, [
    { key: "Номинальная мощность, кВа", op: "eq", value: "10", unit: "кВа", level: "A" },
    { key: "Тип стабилизации", op: "eq", value: "релейный", level: "A" },
  ], "Нужен аналог AX-900: 10 кВА, релейный", true);
  assertEquals(explicit.map((axis) => axis.key), ["power", "stabilization"]);
});

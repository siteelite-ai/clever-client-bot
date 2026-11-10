import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  type CriteriaFacet,
  type Criterion,
  extendSelectionCriteriaPlan,
  projectCriteriaFacetOptions,
} from "./criteria-gate.ts";
import {
  compileDialogueSelectionCriteria,
  enforceDialogueBudgetCriteria,
  enforceDialogueSelectionCriteria,
  readServerSelectionCriteria,
  resolveDialogueBudgetCap,
  updateDialogueSelectionCriteria,
} from "./dialogue-selection-state.ts";

const facets: CriteriaFacet[] = [
  {
    key: "color",
    caption: "Цвет",
    unit: null,
    values: ["черный", "серебристый", "белый"].map((value) => ({ value })),
  },
  {
    key: "mount",
    caption: "Тип монтажа",
    unit: null,
    values: ["скрытый", "открытый"].map((value) => ({ value })),
  },
  {
    key: "material",
    caption: "Материал",
    unit: null,
    values: ["медь", "алюминий"].map((value) => ({ value })),
  },
  {
    key: "load",
    caption: "Рабочий ток",
    unit: "А",
    values: ["6", "10"].map((value) => ({ value })),
  },
];
const criterion = (
  key: string,
  value: string | number | [number, number],
  op: Criterion["op"] = "eq",
): Criterion => ({ key, value, op, level: "A", evidence: "user_explicit" });
const old = [criterion("Цвет", "черный"), criterion("Тип монтажа", "скрытый")];

Deno.test("dialogue patch replaces an axis, not the full request or an OR union", () => {
  const next = updateDialogueSelectionCriteria(old, [
    criterion("color", "серебристый"),
  ], facets);
  assertEquals(next.map((x) => x.value), ["скрытый", "серебристый"]);
  assertEquals(old.map((x) => x.value), ["черный", "скрытый"]);
  assertEquals(projectCriteriaFacetOptions(next, facets).options, {
    mount: ["скрытый"],
    color: ["серебристый"],
  });
});
Deno.test("two alternatives in one new turn replace the entire old OR family", () => {
  const next = updateDialogueSelectionCriteria(old, [
    criterion("color", "серебристый"),
    criterion("Цвет", "белый"),
  ], facets);
  assertEquals(next.map((x) => x.value), ["скрытый", "серебристый", "белый"]);
});
Deno.test("independent facets and the other numeric bound survive a customer patch", () => {
  const prior = [
    ...old,
    criterion("Цена", 100, "min"),
    criterion("Вес", 5, "max"),
  ];
  const next = updateDialogueSelectionCriteria(prior, [
    criterion("Материал", "медь"),
  ], facets);
  assertEquals(next.length, 5);
  const replaced = updateDialogueSelectionCriteria(next, [
    criterion("Вес", [2, 4], "range"),
  ], facets);
  assertEquals(replaced.find((c) => c.key === "Вес")?.value, [2, 4]);
  assertEquals(replaced.find((c) => c.key === "Цена")?.value, 100);
});
Deno.test("unrelated same-unit facets are not the same axis", () => {
  const f = [{ key: "input", caption: "Входной ток", unit: "А", values: [] }, {
    key: "output",
    caption: "Выходной ток",
    unit: "А",
    values: [],
  }];
  assertEquals(
    updateDialogueSelectionCriteria([criterion("Входной ток", 6)], [
      criterion("Выходной ток", 10),
    ], f).length,
    2,
  );
});
Deno.test("model assumptions and advisory criteria cannot replace customer state", () => {
  assertEquals(
    updateDialogueSelectionCriteria(old, [{
      ...criterion("Цвет", "белый"),
      evidence: "model_assumption",
    }], facets),
    old,
  );
  assertEquals(
    updateDialogueSelectionCriteria(old, [{
      ...criterion("Цвет", "белый"),
      level: "B",
    }], facets),
    old,
  );
});
Deno.test("fallback cannot revive an old value or broaden the active OR family", () => {
  const state = updateDialogueSelectionCriteria(old, [
    criterion("color", "серебристый"),
  ], facets);
  const enforced = enforceDialogueSelectionCriteria(
    [...old, criterion("color", "белый")],
    state,
    facets,
  );
  assertEquals(enforced.map((c) => c.value), ["скрытый", "серебристый"]);
  const plan = extendSelectionCriteriaPlan(
    null,
    enforced,
    "reasoning_projection",
  );
  const recovered = extendSelectionCriteriaPlan(
    plan,
    enforceDialogueSelectionCriteria(old, state, facets),
    "guarded_search",
  );
  assertEquals(recovered.hash, plan.hash);
});
Deno.test("unknown or ambiguous facet aliases cannot erase other requirements", () => {
  const f = [...facets, {
    key: "other",
    caption: "Цвет",
    unit: null,
    values: [],
  }];
  assertEquals(
    updateDialogueSelectionCriteria([criterion("color", "черный")], [
      criterion("Цвет", "белый"),
    ], f).length,
    2,
  );
});
Deno.test("latest customer turn wins over a joined old description", () => {
  const state = compileDialogueSelectionCriteria({
    facets,
    priorQueriesNewestFirst: ["Розетки черные скрытого монтажа"],
    currentEvidence: "А есть серебристые?",
  });
  const options = projectCriteriaFacetOptions(state, facets).options;
  assertEquals(options.color, ["серебристый"]);
  assertEquals(options.mount, ["скрытый"]);
});
Deno.test("latest verified turn wins on each independent facet across three turns", () => {
  const state = compileDialogueSelectionCriteria({
    facets,
    priorQueriesNewestFirst: [
      "Нужен материал медь",
      "Цвет черный, тип монтажа скрытый",
    ],
    currentEvidence: "Цвет серебристый",
  });
  assertEquals(projectCriteriaFacetOptions(state, facets).options, {
    mount: ["скрытый"],
    material: ["медь"],
    color: ["серебристый"],
  });
});
Deno.test("more options restores server contract even when model omits its values", () => {
  const state = compileDialogueSelectionCriteria({
    facets,
    priorQueriesNewestFirst: ["Мне нужен бытовой вариант"],
    currentEvidence: "Покажи еще",
    priorCriteria: old,
  });
  assertEquals(state, old);
});
Deno.test("current override can change a persisted contract, but not independent measurements", () => {
  const state = compileDialogueSelectionCriteria({
    facets,
    priorQueriesNewestFirst: ["Цвет черный"],
    currentEvidence: "Цвет серебристый",
    priorCriteria: [...old, criterion("Рабочий ток", 6)],
  });
  assertEquals(state.some((c) => c.value === "черный"), false);
  assertEquals(state.find((c) => c.key === "Рабочий ток")?.value, 6);
});
Deno.test("an empty new-task seed does not inherit state from a caller history", () => {
  assertEquals(
    compileDialogueSelectionCriteria({
      facets,
      priorQueriesNewestFirst: [],
      currentEvidence: "Материал медь",
    }).map((c) => c.value),
    ["медь"],
  );
});
Deno.test("server contract reader rejects malformed or model-owned obligations", () => {
  const event = (
    criteria: unknown,
  ) => [{
    type: "products_block",
    selection_contract: { mandatory_criteria: criteria },
  }];
  assertEquals(readServerSelectionCriteria(event(old)), old);
  assertEquals(
    readServerSelectionCriteria(
      event([{ ...old[0], evidence: "catalog_verified" }]),
    ),
    [],
  );
  assertEquals(
    readServerSelectionCriteria(event([{ ...old[0], op: "whatever" }])),
    [],
  );
  assertEquals(
    readServerSelectionCriteria(
      event([{ ...old[0], value: [5, 1], op: "range" }]),
    ),
    [],
  );
  assertEquals(
    readServerSelectionCriteria(event([{ ...old[0], value: NaN }])),
    [],
  );
  assertEquals(
    readServerSelectionCriteria([{
      type: "delta",
      selection_contract: { mandatory_criteria: old },
    }]),
    [],
  );
});

Deno.test("a current literal temperature replaces an old numeric contract, not its other axes", () => {
  const temperatures: CriteriaFacet[] = [...facets, {
    key: "temperature",
    caption: "Цветовая температура",
    unit: "K",
    values: ["3000", "4000", "6500"].map((value) => ({ value })),
  }];
  const state = compileDialogueSelectionCriteria({
    facets: temperatures,
    priorQueriesNewestFirst: ["Нужны черные светильники 6500 K"],
    priorCriteria: [criterion("Цвет", "черный"), {
      ...criterion("Цветовая температура", 6500),
      unit: "K",
    }],
    currentEvidence: "Цветовая температура 4000 K",
  });
  assertEquals(
    state.filter((c) => c.key === "Цветовая температура").map((c) =>
      Number(c.value)
    ),
    [4000],
  );
  assertEquals(state.find((c) => c.key === "Цвет")?.value, "черный");
});

Deno.test("a new measured range replaces both old endpoints without using model numbers", () => {
  const lengths: CriteriaFacet[] = [{
    key: "length",
    caption: "Длина",
    unit: "мм",
    values: ["20", "40", "60", "80"].map((value) => ({ value })),
  }];
  const state = compileDialogueSelectionCriteria({
    facets: lengths,
    priorQueriesNewestFirst: ["Длина от 20 до 40 мм"],
    currentEvidence: "Длина от 60 до 80 мм",
  });
  assertEquals(state.map((c) => ({ op: c.op, value: c.value })), [{
    op: "range",
    value: [60, 80],
  }]);
});

Deno.test("budget replacement uses the latest customer cap, not the first cap in joined history", () => {
  const previous = [criterion("Стоимость", 4000, "max"), ...old];
  const state = compileDialogueSelectionCriteria({
    facets,
    priorQueriesNewestFirst: ["Розетки черные до 4000 тенге"],
    priorCriteria: previous,
    currentEvidence: "Серебристые, бюджет до 8000 тенге",
  });
  assertEquals(
    state.filter((c) => ["Цена", "Стоимость"].includes(c.key)).map((c) =>
      c.value
    ),
    [8000],
  );
  assertEquals(
    resolveDialogueBudgetCap(["до 4000 тенге"], "до 8000 тенге", previous),
    8000,
  );
  assertEquals(
    resolveDialogueBudgetCap(["до 4000 тенге"], "Есть еще?", previous),
    4000,
  );
  assertEquals(resolveDialogueBudgetCap([], "Новая тема. Кабель"), null);
});

Deno.test("budget correction preserves the dedicated price gate without fabricating a category facet", () => {
  assertEquals(enforceDialogueBudgetCriteria(old, 8000), old);
  const corrected = enforceDialogueBudgetCriteria([
    ...old,
    criterion("Стоимость", 4000, "max"),
  ], 8000);
  assertEquals(corrected.map((c) => c.value), ["черный", "скрытый", 8000]);
  assertEquals(enforceDialogueBudgetCriteria(old, null), old);
});

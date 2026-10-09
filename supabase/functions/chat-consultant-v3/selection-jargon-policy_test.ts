import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import type { Criterion } from "../_shared/v3-tools/criteria-gate.ts";
import type { CompatibilityFacet } from "../_shared/v3-tools/compatibility-contract.ts";
import type { ProductRef } from "../_shared/v3-tools/types.ts";
import { classifyOutdoorPoeIntent } from "../_shared/v3-tools/outdoor-poe-policy.ts";
import {
  admitDirectSelectionRoute,
  customerOwnedJargonModifiers,
  directProductProvesLiteralWords,
  enforceTerminalPairedFit,
  extractSchemaBackedMeasuredReference,
  isPureNamedSeriesBrowse,
  isPureRecentPriceFollowup,
  omitPairedObjectReferenceExactCriteria,
  shouldDeferQueuedLexicalSearch,
  terminalPairedFitDecision,
} from "./selection-jargon-policy.ts";

Deno.test("one direct-route admission rejects unproven compound, PoE and replacement obligations", () => {
  const marking = { first: 2, second: 1.5 };
  assertEquals(
    admitDirectSelectionRoute({
      route: "compound",
      userMessage: "найди кабель ВВГ 2×1,5 самый дешёвый",
      coveredCompound: marking,
    }),
    true,
  );
  for (
    const request of [
      "найди кабель ВВГ 2×1,5 16 А",
      "найди кабель ВВГ 2×1,5 до 1000 тенге",
      "найди кабель ВВГ 2×1,5 для комнаты",
    ]
  ) {
    assertEquals(
      admitDirectSelectionRoute({
        route: "compound",
        userMessage: request,
        coveredCompound: marking,
      }),
      false,
      request,
    );
  }
  assertEquals(
    admitDirectSelectionRoute({
      route: "compound",
      userMessage: "подбери трубку ТТУ 10×5",
      coveredCompound: { first: 10, second: 5 },
    }),
    true,
  );
  assertEquals(
    admitDirectSelectionRoute({
      route: "compound",
      userMessage: "подбери трубку ТТУ 10×5 для кабеля диаметром 10 мм",
      coveredCompound: { first: 10, second: 5 },
    }),
    false,
  );

  assertEquals(
    admitDirectSelectionRoute({
      route: "outdoor_poe",
      userMessage: "подбери кабель",
    }),
    true,
  );
  assertEquals(
    admitDirectSelectionRoute({
      route: "outdoor_poe",
      userMessage: "Тогда подбери подходящий кабель.",
    }),
    true,
  );
  for (
    const request of [
      "подбери кабель 305 м",
      "подбери кабель до 4000 тенге",
      "подбери кабель с четырьмя портами",
      "подбери чёрный кабель",
      "подбери кабель для камеры на 305 метров",
    ]
  ) {
    assertEquals(
      admitDirectSelectionRoute({
        route: "outdoor_poe",
        userMessage: request,
      }),
      false,
      request,
    );
  }

  assertEquals(
    admitDirectSelectionRoute({
      route: "replacement",
      userMessage: "предложи аналоги на Schneider Acti9 C16",
    }),
    true,
  );
  for (
    const request of [
      "предложи аналоги на Schneider Acti9 C16 для объекта 25 м²",
      "предложи аналоги на Schneider Acti9 C16 чёрные",
      "предложи аналоги на Schneider Acti9 C16 с наличием в Алматы",
      "предложи аналог C16 чёрный",
      "предложи аналог чёрный C16",
    ]
  ) {
    assertEquals(
      admitDirectSelectionRoute({
        route: "replacement",
        userMessage: request,
      }),
      false,
      request,
    );
  }
});

Deno.test("customer PoE continuation retains the safe direct route but new fit does not", () => {
  const history = [
    {
      role: "user" as const,
      content:
        "Я нашёл дешёвый кабель для камеры на охраняемой парковке: Кабель витая пара U/UTP кат. 5 CCA 4 пары, GENERICA. Подойдёт или нет?",
    },
    {
      role: "user" as const,
      content:
        "Да, PoE-камера, расстояние почти 100 метров, кабель будет идти на улице. Почему этот кабель нельзя использовать?",
    },
  ];
  const clean = "Тогда подбери подходящий кабель.";
  const addedFit =
    "Тогда подбери подходящий кабель с длиной 305 м до 4000 тенге.";
  assertEquals(classifyOutdoorPoeIntent(clean, history), "selection");
  assertEquals(
    admitDirectSelectionRoute({ route: "outdoor_poe", userMessage: clean }),
    true,
  );
  assertEquals(classifyOutdoorPoeIntent(addedFit, history), "selection");
  assertEquals(
    admitDirectSelectionRoute({ route: "outdoor_poe", userMessage: addedFit }),
    false,
  );
});

Deno.test("standalone customer PoE profile stays direct; added obligations reroute", () => {
  const baseline =
    "подбери кабель для наружной PoE-камеры вместо CCA/PVC около 100 м";
  assertEquals(classifyOutdoorPoeIntent(baseline, []), "selection");
  assertEquals(
    admitDirectSelectionRoute({ route: "outdoor_poe", userMessage: baseline }),
    true,
  );
  for (
    const request of [
      `${baseline} и длиной 305 м`,
      `${baseline} до 4000 тенге`,
      `${baseline} с четырьмя портами`,
      `${baseline} чёрного цвета`,
    ]
  ) {
    assertEquals(
      admitDirectSelectionRoute({ route: "outdoor_poe", userMessage: request }),
      false,
      request,
    );
  }
});

Deno.test("long DN027B source identity remains a pure replacement, not a customer fit", () => {
  const longSource =
    "Светильник DN027B G2 LED6/NW 7W 220-240V D90 R; 929002070102/871869967897500";
  const sourceFirst =
    "Светильник DN027B G2 LED6/NW 7W 220-240V D90 R — предложи равноценную замену";
  for (
    const request of [
      `предложи аналоги на ${longSource}`,
      sourceFirst,
    ]
  ) {
    assertEquals(
      admitDirectSelectionRoute({ route: "replacement", userMessage: request }),
      true,
      request,
    );
  }
  for (
    const request of [
      `предложи аналоги на ${longSource} для гостиной 25 м²`,
      `${sourceFirst} для гостиной 25 м²`,
      `${sourceFirst} с наличием в Алматы`,
    ]
  ) {
    assertEquals(
      admitDirectSelectionRoute({ route: "replacement", userMessage: request }),
      false,
      request,
    );
  }
});

Deno.test("direct marking and replacement cards prove every retained literal", () => {
  const cable = {
    pagetitle: "Кабель ВВГ 2×1,5",
    short_traits: ["Жила: медная"],
    description_excerpt: "",
  };
  assertEquals(
    directProductProvesLiteralWords("найди кабель ВВГ 2×1,5", cable),
    true,
  );
  assertEquals(
    directProductProvesLiteralWords("найди чёрный кабель ВВГ 2×1,5", cable),
    false,
  );
  assertEquals(
    directProductProvesLiteralWords("найди медную кабель ВВГ 2×1,5", cable),
    true,
  );
  assertEquals(
    directProductProvesLiteralWords(
      "Schneider Acti9 C16 чёрный",
      {
        pagetitle: "Автомат белый C16",
        short_traits: [],
        description_excerpt: "",
      },
      ["Schneider", "Acti9", "C16"],
    ),
    false,
  );
});

Deno.test("exact factual SKU inquiry stays direct, measured suitability does not", () => {
  assertEquals(
    admitDirectSelectionRoute({
      route: "exact_inquiry",
      userMessage: "какие характеристики у модели DN027B?",
    }),
    true,
  );
  assertEquals(
    admitDirectSelectionRoute({
      route: "exact_inquiry",
      userMessage: "подойдёт ли модель DN027B для комнаты 25 м²?",
    }),
    false,
  );
  assertEquals(
    admitDirectSelectionRoute({
      route: "exact_inquiry",
      userMessage: "хватит ли светильника DN027B для гостиной?",
    }),
    false,
  );
});

Deno.test("only an unqualified named-series browse can use direct identity cards", () => {
  for (
    const request of [
      "Покажи серию Gallant",
      "Покажи товары серии Gallant на сайте",
      "Покажи товары этой серии",
    ]
  ) assertEquals(isPureNamedSeriesBrowse(request, "Gallant"), true, request);
  for (
    const request of [
      "Найди двойные чёрные розетки серии Gallant",
      "Покажи товары серии Gallant до 5000 тенге",
      "Покажи только товары этой серии с наличием в Алматы",
      "Покажи товары серии Gallant для влажной комнаты",
    ]
  ) assertEquals(isPureNamedSeriesBrowse(request, "Gallant"), false, request);
});

Deno.test("only a price-only recent-batch follow-up can bypass expert criteria", () => {
  for (
    const request of [
      "Самый бюджетный, дай ссылку",
      "Покажи самый дорогой из этих вариантов",
      "Какой из них самый дешёвый?",
    ]
  ) assertEquals(isPureRecentPriceFollowup(request), true, request);
  for (
    const request of [
      "Самый дешёвый из этих вариантов, но чёрный",
      "Покажи самый бюджетный из них на 16 А",
      "Самый дешёвый из этих, который подойдёт для улицы",
      "Найди самый дешёвый кабель",
    ]
  ) assertEquals(isPureRecentPriceFollowup(request), false, request);
});

const criterion = (value: string, key = "Цоколь"): Criterion => ({
  key,
  op: "eq",
  value,
  level: "A",
  evidence: "user_explicit",
});

Deno.test("live taxonomy is never repeated as a literal jargon modifier", () => {
  const criteria: Criterion[] = [
    criterion("Трубки термоусаживаемые", "Тип товара"),
    criterion("E27"),
    criterion("черный", "Цвет"),
    {
      key: "Размер",
      op: "min",
      value: 10,
      unit: "мм",
      evidence: "derived_required",
    },
    { key: "Цена", op: "max", value: 1000, evidence: "user_explicit" },
    {
      key: "Марка",
      op: "eq",
      value: "модельная",
      evidence: "model_assumption",
    },
  ];
  assertEquals(
    customerOwnedJargonModifiers(
      criteria,
      ["Трубки термоусаживаемые"],
    ),
    ["E27", "черный"],
  );
  assertEquals(
    customerOwnedJargonModifiers(
      [criterion("E27")],
      ["Лампы"],
    ),
    ["E27"],
  );
});

Deno.test("pending derived reasoning preempts only the stale lexical queue", () => {
  assertEquals(
    shouldDeferQueuedLexicalSearch(true, "jargon_recover_catalog"),
    true,
  );
  assertEquals(shouldDeferQueuedLexicalSearch(true, "search_catalog"), false);
  assertEquals(
    shouldDeferQueuedLexicalSearch(false, "jargon_recover_catalog"),
    false,
  );
});

const pairedFacets: CompatibilityFacet[] = [
  {
    key: "diameter_before",
    caption: "Внутренний диаметр до изменения, мм",
    unit: "мм",
    values: [],
  },
  {
    key: "diameter_after",
    caption: "Внутренний диаметр после изменения, мм",
    unit: "мм",
    values: [],
  },
];
const item = (id: string, title: string): ProductRef => ({
  id,
  pagetitle: title,
  vendor: null,
  price: 100,
  stock: "in_stock",
  short_traits: [],
});

Deno.test("a customer cm dimension cannot silently bypass a live mm pair", () => {
  const reference = { value: 12, unit: "см" };
  const decision = terminalPairedFitDecision(
    reference,
    "подбери изделие для кабеля диаметром 12 см",
    "До изменения диаметр больше 12 см, после изменения диаметр меньше 12 см.",
    pairedFacets,
  );
  assertEquals(decision.state, "unproven");
  assertEquals(
    terminalPairedFitDecision(
      { value: 12, unit: "cm" },
      "подбери изделие для кабеля диаметром 12 cm",
      "",
      pairedFacets,
    ).state,
    "unproven",
  );
  assertEquals(
    enforceTerminalPairedFit(
      [item("wrong-scale", "Изделие 16/8")],
      decision,
      "",
    ),
    [],
  );
  assertEquals(
    terminalPairedFitDecision(
      reference,
      "подбери изделие для кабеля длиной 12 см",
      "",
      pairedFacets,
    ).state,
    "not_applicable",
  );
  assertEquals(
    terminalPairedFitDecision(
      { value: 12, unit: "А" },
      "подбери изделие для кабеля с током 12 А",
      "",
      pairedFacets,
    ).state,
    "not_applicable",
  );
});

Deno.test("schema-owned diameter survives a distinct length measurement", () => {
  const request = "подбери трубку для кабеля диаметром 12 мм длиной 1 м";
  const reference = extractSchemaBackedMeasuredReference(
    request,
    pairedFacets,
    "Трубки термоусаживаемые",
  );
  assertEquals(reference, { value: 12, unit: "мм" });
  const reasoning =
    "До изменения внутренний диаметр должен быть строго больше 12 мм, а после изменения внутренний диаметр должен быть строго меньше 12 мм.";
  const decision = terminalPairedFitDecision(
    reference,
    request,
    reasoning,
    pairedFacets,
    "Трубки термоусаживаемые",
  );
  assertEquals(decision.state, "required");
  assertEquals(
    enforceTerminalPairedFit(
      [item("equal", "Изделие 12/6"), item("fit", "Изделие 16/8")],
      decision,
      reasoning,
    ).map(({ id }) => id),
    ["fit"],
  );
  assertEquals(
    extractSchemaBackedMeasuredReference(
      "для кабеля диаметром 12 мм и другого кабеля диаметром 10 мм",
      pairedFacets,
    ),
    null,
  );
  const foreignUnitRequest = "для кабеля диаметром 12 см длиной 1 м";
  const foreignReference = extractSchemaBackedMeasuredReference(
    foreignUnitRequest,
    pairedFacets,
  );
  assertEquals(foreignReference, { value: 12, unit: "см" });
  assertEquals(
    terminalPairedFitDecision(
      foreignReference,
      foreignUnitRequest,
      "До изменения диаметр больше 12 см, после изменения диаметр меньше 12 см.",
      pairedFacets,
    ).state,
    "unproven",
  );
  assertEquals(
    extractSchemaBackedMeasuredReference(
      "трубка диаметром 12 мм длиной 1 м",
      pairedFacets,
      "Трубки термоусаживаемые",
    ),
    null,
  );
});

Deno.test("terminal jargon fit proves strict high > 10 > low from live paired schema", () => {
  const reference = { value: 10, unit: "мм" };
  const reasoning =
    "До установки внутренний диаметр должен быть строго больше 10 мм, а после изменения внутренний диаметр должен быть строго меньше 10 мм.";
  const decision = terminalPairedFitDecision(
    reference,
    "подбери трубку для кабеля диаметром 10 мм",
    reasoning,
    pairedFacets,
  );
  assertEquals(decision.state, "required");
  assertEquals(
    enforceTerminalPairedFit(
      [
        item("ok", "Изделие 12/6"),
        item("too-small", "Изделие 10/5"),
        item("too-large-after", "Изделие 12/10"),
        item("unproven", "Изделие без пары"),
      ],
      decision,
      reasoning,
    ).map((product) => product.id),
    ["ok"],
  );
});

Deno.test("paired object measurements never become exact product sizes at 12 or 10 mm", () => {
  for (const value of [12, 10]) {
    const reference = { value, unit: "мм" };
    const decision = terminalPairedFitDecision(
      reference,
      `подбери трубку для кабеля диаметром ${value} мм`,
      `До установки внутренний диаметр должен быть строго больше ${value} мм, а после изменения внутренний диаметр должен быть строго меньше ${value} мм.`,
      pairedFacets,
    );
    assertEquals(decision.state, "required");
    assertEquals(
      omitPairedObjectReferenceExactCriteria(
        [
          criterion(String(value), "diameter_before"),
          criterion(String(value), "diameter_after"),
          criterion("красный", "Цвет"),
        ],
        decision,
        pairedFacets,
      ).map(({ key }) => key),
      ["Цвет"],
    );
    assertEquals(
      enforceTerminalPairedFit(
        [
          item("equal-before", `Изделие ${value}/${value / 2}`),
          item("strict-fit", `Изделие ${value + 4}/${value / 2}`),
        ],
        decision,
        `До установки внутренний диаметр должен быть строго больше ${value} мм, а после изменения внутренний диаметр должен быть строго меньше ${value} мм.`,
      ).map(({ id }) => id),
      ["strict-fit"],
    );
  }
});

Deno.test("an unproven unique live pair still identifies its facets without authorizing cards", () => {
  const decision = terminalPairedFitDecision(
    { value: 12, unit: "мм" },
    "подбери трубку для кабеля диаметром 12 мм",
    "До установки диаметр не менее 12 мм, после установки не более 12 мм.",
    pairedFacets,
  );
  assertEquals(decision.state, "unproven");
  assertEquals(decision.selected_pair?.before_facet_key, "diameter_before");
  assertEquals(decision.selected_pair?.after_facet_key, "diameter_after");
  assertEquals(
    enforceTerminalPairedFit([item("tempting", "Изделие 16/8")], decision, ""),
    [],
  );
});

Deno.test("live caption-only units identify the same strict pair for both customer sizes", () => {
  const facets: CompatibilityFacet[] = [
    {
      key: "before_diameter",
      caption: "Внутр диаметр до термоусадки,мм",
      unit: null,
      values: [{ value: "12" }, { value: "16" }],
    },
    {
      key: "after_diameter",
      caption: "Внутр диаметр после термоусадки,мм",
      unit: null,
      values: [{ value: "6" }, { value: "8" }],
    },
  ];
  for (const value of [12, 10]) {
    const request = `подбери трубку для кабеля диаметром ${value} мм`;
    const decision = terminalPairedFitDecision(
      { value, unit: "мм" },
      request,
      "",
      facets,
    );
    assertEquals(decision.state, "unproven");
    assertEquals(decision.selected_pair?.before_facet_key, "before_diameter");
    assertEquals(
      omitPairedObjectReferenceExactCriteria(
        [{
          key: "Внутр диаметр до термоусадки,мм",
          op: "eq",
          value: String(value),
          evidence: "user_explicit",
        }],
        decision,
        facets,
      ),
      [],
    );
  }
});

Deno.test("measured requested product size is not reinterpreted as another object's paired fit", () => {
  for (const value of [12, 10]) {
    const direct = terminalPairedFitDecision(
      { value, unit: "мм" },
      `подбери термоусадочную трубку диаметром ${value} мм`,
      "",
      pairedFacets,
      "Трубки термоусаживаемые",
    );
    assertEquals(direct.state, "not_applicable");
    assertEquals(
      omitPairedObjectReferenceExactCriteria(
        [
          criterion(String(value), "diameter_before"),
        ],
        direct,
        pairedFacets,
      ).length,
      1,
    );
    const contextual = terminalPairedFitDecision(
      { value, unit: "мм" },
      `подбери термоусадочную трубку для кабеля диаметром ${value} мм`,
      "",
      pairedFacets,
      "Трубки термоусаживаемые",
    );
    assertEquals(contextual.state, "unproven");
    assertEquals(contextual.selected_pair?.before_facet_key, "diameter_before");
    const mounted = terminalPairedFitDecision(
      { value, unit: "мм" },
      `подбери трубку на кабель диаметром ${value} мм`,
      "",
      pairedFacets,
      "Трубки термоусаживаемые",
    );
    assertEquals(mounted.state, "unproven");
  }
});

Deno.test("live pair schema is an obligation, never a substitute for model reasoning", () => {
  const reference = { value: 10, unit: "мм" };
  for (
    const reasoning of [
      "Подбираю размер.",
      "До установки внутренний диаметр должен быть строго больше 10 мм.",
      "До и после изменения проверяю 10 мм.",
    ]
  ) {
    const decision = terminalPairedFitDecision(
      reference,
      "кабель диаметром 10 мм",
      reasoning,
      pairedFacets,
    );
    assertEquals(decision.state, "unproven", reasoning);
    assertEquals(
      enforceTerminalPairedFit(
        [
          item("unsafe", "Изделие 10/5"),
          item("otherwise-fitting", "Изделие 12/6"),
        ],
        decision,
        reasoning,
      ),
      [],
      reasoning,
    );
  }
});

Deno.test("a filler word between diameter and value cannot silently disable the pair gate", () => {
  const reference = { value: 10, unit: "мм" };
  const reasoning =
    "До установки внутренний диаметр должен быть строго больше 10 мм, а после изменения внутренний диаметр должен быть строго меньше 10 мм.";
  const decision = terminalPairedFitDecision(
    reference,
    "кабель диаметром примерно 10 мм",
    reasoning,
    pairedFacets,
  );
  assertEquals(decision.state, "required");
  assertEquals(
    enforceTerminalPairedFit(
      [
        item("unsafe", "Изделие 10/5"),
        item("safe", "Изделие 12/6"),
      ],
      decision,
      reasoning,
    ).map((product) => product.id),
    ["safe"],
  );
});

Deno.test("unrelated same-unit property never inherits a diameter pair", () => {
  const reference = { value: 10, unit: "мм" };
  const decision = terminalPairedFitDecision(
    reference,
    "кабель длиной 10 мм",
    "Подбираю длину.",
    pairedFacets,
  );
  assertEquals(decision.state, "not_applicable");
  assertEquals(
    enforceTerminalPairedFit(
      [
        item("single", "Изделие длиной 10 мм"),
      ],
      decision,
      "Подбираю длину.",
    ).map((product) => product.id),
    ["single"],
  );
});

Deno.test("nearest explicit property wins over older diameter even when model describes a pair", () => {
  const reference = { value: 10, unit: "мм" };
  const reasoning =
    "До установки внутренний диаметр должен быть строго больше 10 мм, а после изменения внутренний диаметр должен быть строго меньше 10 мм.";
  const decision = terminalPairedFitDecision(
    reference,
    "термоусадка: диаметр любой, длина 10 мм",
    reasoning,
    pairedFacets,
  );
  assertEquals(decision.state, "not_applicable");
});

Deno.test("the customer property selects the unique live pair regardless of facet order", () => {
  const lengthFacets: CompatibilityFacet[] = [
    {
      key: "length_before",
      caption: "Длина до изменения, мм",
      unit: "мм",
      values: [],
    },
    {
      key: "length_after",
      caption: "Длина после изменения, мм",
      unit: "мм",
      values: [],
    },
  ];
  const reference = { value: 10, unit: "мм" };
  const diameterReasoning =
    "До установки внутренний диаметр должен быть строго больше 10 мм, а после изменения внутренний диаметр должен быть строго меньше 10 мм.";
  const lengthReasoning =
    "До установки длина должна быть строго больше 10 мм, а после изменения длина должна быть строго меньше 10 мм.";
  for (
    const facets of [
      [...lengthFacets, ...pairedFacets],
      [...pairedFacets, ...lengthFacets],
    ]
  ) {
    assertEquals(
      terminalPairedFitDecision(
        reference,
        "кабель диаметром 10 мм",
        diameterReasoning,
        facets,
      ).state,
      "required",
    );
    assertEquals(
      terminalPairedFitDecision(
        reference,
        "кабель длиной 10 мм",
        lengthReasoning,
        facets,
      ).state,
      "required",
    );
    assertEquals(
      terminalPairedFitDecision(
        reference,
        "кабель длиной 10 мм",
        diameterReasoning,
        facets,
      ).state,
      "unproven",
    );
  }
});

Deno.test("a global property mention cannot lend unrelated strict bounds to the selected pair", () => {
  const reference = { value: 10, unit: "мм" };
  const falseReasoning =
    "Проверяю диаметр. Длина до установки строго больше 10 мм, после — строго меньше 10 мм.";
  const decision = terminalPairedFitDecision(
    reference,
    "кабель диаметром 10 мм",
    falseReasoning,
    pairedFacets,
  );
  assertEquals(decision.state, "unproven");
  assertEquals(
    enforceTerminalPairedFit(
      [
        item("false-card", "Изделие 12/6"),
      ],
      decision,
      falseReasoning,
    ),
    [],
  );
});

Deno.test("reversed before/after directions cannot prove the selected pair", () => {
  const reference = { value: 10, unit: "мм" };
  const reversed =
    "После установки внутренний диаметр должен быть строго больше 10 мм, а до изменения внутренний диаметр должен быть строго меньше 10 мм.";
  const decision = terminalPairedFitDecision(
    reference,
    "кабель диаметром 10 мм",
    reversed,
    pairedFacets,
  );
  assertEquals(decision.state, "unproven");
  assertEquals(
    enforceTerminalPairedFit(
      [
        item("tempting", "Изделие 12/6"),
      ],
      decision,
      reversed,
    ),
    [],
  );
});

Deno.test("an extra same-scalar bound on another property invalidates otherwise good pair prose", () => {
  const reference = { value: 10, unit: "мм" };
  const mixed =
    "До установки внутренний диаметр строго больше 10 мм, после изменения внутренний диаметр строго меньше 10 мм. Длина до изменения строго больше 10 мм.";
  assertEquals(
    terminalPairedFitDecision(
      reference,
      "кабель диаметром 10 мм",
      mixed,
      pairedFacets,
    ).state,
    "unproven",
  );
});

Deno.test("two customer mentions of the same scalar cannot discharge only one property", () => {
  const reference = { value: 10, unit: "мм" };
  const reasoning =
    "До установки внутренний диаметр должен быть строго больше 10 мм, а после изменения внутренний диаметр должен быть строго меньше 10 мм.";
  const decision = terminalPairedFitDecision(
    reference,
    "длина 10 мм и диаметр 10 мм",
    reasoning,
    pairedFacets,
  );
  assertEquals(decision.state, "unproven");
  assertEquals(
    enforceTerminalPairedFit(
      [
        item("one-axis-only", "Изделие 12/6"),
      ],
      decision,
      reasoning,
    ),
    [],
  );
});

Deno.test("equivalent decimal spellings and leading zeroes are separate customer obligations", () => {
  const reference = { value: 10, unit: "мм" };
  const reasoning =
    "До установки внутренний диаметр должен быть строго больше 10 мм, а после изменения внутренний диаметр должен быть строго меньше 10 мм.";
  for (const spelling of ["010 мм", "10.0 мм", "10,00 мм"]) {
    assertEquals(
      terminalPairedFitDecision(
        reference,
        `длина ${spelling} и диаметр 10 мм`,
        reasoning,
        pairedFacets,
      ).state,
      "unproven",
      spelling,
    );
    assertEquals(
      terminalPairedFitDecision(
        reference,
        `кабель диаметром ${spelling}`,
        reasoning,
        pairedFacets,
      ).state,
      "required",
      spelling,
    );
  }
});

Deno.test("equivalent unit aliases cannot hide a second customer measurement", () => {
  const powerFacets: CompatibilityFacet[] = [
    {
      key: "power_before",
      caption: "Мощность до изменения, Вт",
      unit: "вт",
      values: [],
    },
    {
      key: "power_after",
      caption: "Мощность после изменения, Вт",
      unit: "вт",
      values: [],
    },
  ];
  assertEquals(
    terminalPairedFitDecision(
      { value: 10, unit: "вт" },
      "мощность прибора 10 W и мощность линии 10 Вт",
      "До изменения мощность больше 10 Вт, после изменения мощность меньше 10 Вт.",
      powerFacets,
    ).state,
    "unproven",
  );
});

Deno.test("decimal comma stays inside each local model bound", () => {
  const reference = { value: 10.5, unit: "мм" };
  const reasoning =
    "До установки внутренний диаметр должен быть строго больше 10,5 мм, а после изменения внутренний диаметр должен быть строго меньше 10,5 мм.";
  const decision = terminalPairedFitDecision(
    reference,
    "кабель диаметром 10,5 мм",
    reasoning,
    pairedFacets,
  );
  assertEquals(decision.state, "required");
});

Deno.test("a second live pair with another unit also disqualifies bare title A/B", () => {
  const pressureFacets: CompatibilityFacet[] = [
    {
      key: "pressure_before",
      caption: "Давление до изменения, бар",
      unit: "бар",
      values: [],
    },
    {
      key: "pressure_after",
      caption: "Давление после изменения, бар",
      unit: "бар",
      values: [],
    },
  ];
  const reference = { value: 10, unit: "мм" };
  const reasoning =
    "До установки внутренний диаметр должен быть строго больше 10 мм, а после изменения внутренний диаметр должен быть строго меньше 10 мм.";
  const decision = terminalPairedFitDecision(
    reference,
    "кабель диаметром 10 мм",
    reasoning,
    [...pairedFacets, ...pressureFacets],
  );
  assertEquals(decision.state, "required");
  assertEquals(decision.selected_pair?.require_facet_values, true);
  assertEquals(
    enforceTerminalPairedFit(
      [
        item("bare", "Изделие 12/6"),
        {
          ...item("diameter-proven", "Изделие 12/6"),
          facet_values: {
            diameter_before: ["12 мм"],
            diameter_after: ["6 мм"],
          },
        },
      ],
      decision,
      reasoning,
    ).map((product) => product.id),
    ["diameter-proven"],
  );
});

Deno.test("multiple same-unit pairs require labeled live facet values for both selected sides", () => {
  const lengthFacets: CompatibilityFacet[] = [
    {
      key: "length_before",
      caption: "Длина до изменения, мм",
      unit: "мм",
      values: [],
    },
    {
      key: "length_after",
      caption: "Длина после изменения, мм",
      unit: "мм",
      values: [],
    },
  ];
  const reference = { value: 10, unit: "мм" };
  const reasoning =
    "До установки внутренний диаметр должен быть строго больше 10 мм, а после изменения внутренний диаметр должен быть строго меньше 10 мм.";
  const decision = terminalPairedFitDecision(
    reference,
    "кабель диаметром 10 мм",
    reasoning,
    [...lengthFacets, ...pairedFacets],
  );
  assertEquals(decision.state, "required");
  assertEquals(decision.selected_pair?.require_facet_values, true);
  const withFacets = (id: string, facets: Record<string, string[]>) => ({
    ...item(id, "Изделие 12/6"),
    facet_values: facets,
  });
  assertEquals(
    enforceTerminalPairedFit(
      [
        item("title-only", "Изделие 12/6"),
        withFacets("length-only", {
          length_before: ["12 мм"],
          length_after: ["6 мм"],
        }),
        withFacets("wrong-diameter", {
          diameter_before: ["10 мм"],
          diameter_after: ["5 мм"],
          length_before: ["12 мм"],
          length_after: ["6 мм"],
        }),
        withFacets("wrong-unit", {
          diameter_before: ["12 см"],
          diameter_after: ["6 мм"],
        }),
        withFacets("ambiguous-value", {
          diameter_before: ["12 мм", "14 мм"],
          diameter_after: ["6 мм"],
        }),
        withFacets("proven", {
          diameter_before: ["12 мм"],
          diameter_after: ["6 мм"],
          length_before: ["8 мм"],
          length_after: ["15 мм"],
        }),
      ],
      decision,
      reasoning,
    ).map((product) => product.id),
    ["proven"],
  );
});

Deno.test("two live pairs for one named property remain ambiguous", () => {
  const reference = { value: 10, unit: "мм" };
  const reasoning =
    "До установки внутренний диаметр должен быть строго больше 10 мм, а после изменения внутренний диаметр должен быть строго меньше 10 мм.";
  const outerFacets: CompatibilityFacet[] = [
    {
      key: "outer_diameter_before",
      caption: "Наружный диаметр до изменения, мм",
      unit: "мм",
      values: [],
    },
    {
      key: "outer_diameter_after",
      caption: "Наружный диаметр после изменения, мм",
      unit: "мм",
      values: [],
    },
  ];
  assertEquals(
    terminalPairedFitDecision(
      reference,
      "кабель диаметром 10 мм",
      reasoning,
      [...pairedFacets, ...outerFacets],
    ).state,
    "unproven",
  );
});

Deno.test("ambiguous customer measurement cannot authorize a paired card", () => {
  const decision = terminalPairedFitDecision(
    null,
    "диаметр 10 мм и 12 мм",
    "Подбираю размер.",
    pairedFacets,
  );
  assertEquals(decision.state, "unproven");
  assertEquals(
    enforceTerminalPairedFit(
      [
        item("uncertain", "Изделие 12/6"),
      ],
      decision,
      "Подбираю размер.",
    ),
    [],
  );
});

Deno.test("category with no paired state does not invent a contract", () => {
  const reference = { value: 10, unit: "мм" };
  const decision = terminalPairedFitDecision(
    reference,
    "длина 10 мм",
    "Подбираю длину.",
    [
      { key: "length", caption: "Длина, мм", unit: "мм", values: [] },
    ],
  );
  assertEquals(decision.state, "not_applicable");
  assertEquals(
    enforceTerminalPairedFit(
      [
        item("single", "Изделие 10 мм"),
      ],
      decision,
      "Подбираю длину.",
    ).map((product) => product.id),
    ["single"],
  );
});

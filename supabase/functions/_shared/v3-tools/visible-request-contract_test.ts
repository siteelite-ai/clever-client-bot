import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  buildVisibleRequestContract,
  productSupportsVisibleRequestContract,
  shouldContinueVisibleRecoveryPage,
  shouldExpandVisibleRecoverySearch,
  titleSupportsVisibleRequestContract,
} from "./visible-request-contract.ts";

Deno.test("literal linear length requires an actual unit in the title", () => {
  const contract = buildVisibleRequestContract("подбери удлинитель на 50 м");
  assertEquals(
    titleSupportsVisibleRequestContract("Удлинитель УК-50 /50м", contract),
    true,
  );
  assertEquals(
    titleSupportsVisibleRequestContract("Удлинитель EB-50-007", contract),
    false,
  );
});

Deno.test("room area is not treated as a product length", () => {
  assertEquals(
    buildVisibleRequestContract("светильник для гостиной 25 м²").length,
    0,
  );
});

Deno.test("installation height is application context, not exact product length", () => {
  assertEquals(
    buildVisibleRequestContract(
      "Нужен товар для площадки, высота установки 4 м",
    ).length,
    0,
  );
  assertEquals(
    buildVisibleRequestContract("Нужен товар для монтажа на высоте 6 м").length,
    0,
  );
  assertEquals(buildVisibleRequestContract("удлинитель на 4 м").length, 1);
});

Deno.test("route length is application context while product length stays visible", () => {
  assertEquals(
    buildVisibleRequestContract(
      "Система аналоговая, улица, длина трассы 30 м",
    ).length,
    0,
  );
  assertEquals(
    buildVisibleRequestContract("расстояние до камеры 30 метров").length,
    0,
  );
  assertEquals(buildVisibleRequestContract("кабель 30 м").length, 1);
});

Deno.test("explicit place count and double socket stay visible", () => {
  const places = buildVisibleRequestContract("удлинитель на 3 места");
  assertEquals(
    titleSupportsVisibleRequestContract("Удлинитель У03 3 места", places),
    true,
  );
  assertEquals(
    titleSupportsVisibleRequestContract("Удлинитель 4 гн.", places),
    false,
  );

  const doubleSocket = buildVisibleRequestContract(
    "двойные черные розетки электрические",
  );
  assertEquals(
    doubleSocket.map(({ kind, label, op, value }) => ({
      kind,
      label,
      op,
      value,
    })),
    [{ kind: "count", label: "двойная розетка", op: "eq", value: 2 }],
  );
  assertEquals(
    titleSupportsVisibleRequestContract(
      "Розетка двойная, цвет черный",
      doubleSocket,
    ),
    true,
  );
  assertEquals(
    titleSupportsVisibleRequestContract(
      "Розетка одинарная, цвет черный",
      doubleSocket,
    ),
    false,
  );
  assertEquals(
    buildVisibleRequestContract(
      "несколько двойных черных электрических розеток",
    )
      .map(({ kind, value }) => ({ kind, value })),
    [{ kind: "count", value: 2 }],
  );
  assertEquals(
    buildVisibleRequestContract("двойная рамка для розетки").length,
    0,
  );
});

Deno.test("structured catalog traits prove a card attribute omitted from its title", () => {
  const contract = buildVisibleRequestContract("удлинитель на 3 места", {
    productClass: "удлинитель",
    candidateTitles: ["Удлинитель серии A"],
  });
  assertEquals(
    productSupportsVisibleRequestContract({
      pagetitle: "Удлинитель серии A",
      short_traits: ["Количество розеток: 3"],
    }, contract),
    true,
  );
  assertEquals(
    productSupportsVisibleRequestContract({
      pagetitle: "Удлинитель серии B",
      short_traits: ["Количество розеток: 4"],
    }, contract),
    false,
  );
});

Deno.test("structured outlet count proves a double socket without title wording", () => {
  const contract = buildVisibleRequestContract("двойные розетки", {
    productClass: "розетки",
    candidateTitles: ["Розетка серии G"],
  });
  assertEquals(
    productSupportsVisibleRequestContract({
      pagetitle: "Розетка серии G",
      short_traits: ["Количество разъемов: 2"],
    }, contract),
    true,
  );
  assertEquals(
    productSupportsVisibleRequestContract({
      pagetitle: "Розетка серии G",
      short_traits: ["Количество разъемов: 1"],
    }, contract),
    false,
  );
});

Deno.test("final-card visible contract subsumes only duplicate double-socket wording", () => {
  const contract = buildVisibleRequestContract(
    "Найди двойные черные розетки электрические",
    {
      productClass: "розетки",
      candidateTitles: ["Розетка двойная черная", "Розетка серии G"],
    },
  );
  assertEquals(
    contract.map(({ kind, label, value }) => ({ kind, label, value })),
    [
      { kind: "count", label: "двойная розетка", value: 2 },
      { kind: "literal_modifier", label: "черные", value: "черные" },
    ],
  );
  assertEquals(
    productSupportsVisibleRequestContract({
      pagetitle: "Розетка серии G",
      short_traits: ["Количество разъемов: 2", "Цвет: черный"],
    }, contract),
    true,
  );
  // A title alone still cannot prove the missing count or the colour.
  assertEquals(
    titleSupportsVisibleRequestContract("Розетка серии G", contract),
    false,
  );
  assertEquals(
    productSupportsVisibleRequestContract({
      pagetitle: "Розетка серии G",
      short_traits: ["Количество разъемов: 2"],
    }, contract),
    false,
  );
});

Deno.test("final-card double-socket count rejects absent, ambiguous and contradictory evidence", () => {
  const contract = buildVisibleRequestContract("двойные розетки", {
    productClass: "розетки",
    candidateTitles: ["Розетка двойная", "Розетка серии G"],
  });
  assertEquals(contract.map(({ kind, label }) => ({ kind, label })), [
    { kind: "count", label: "двойная розетка" },
  ]);
  for (
    const product of [
      { pagetitle: "Розетка серии G", short_traits: [] },
      {
        pagetitle: "Розетка серии G",
        short_traits: ["Количество USB-разъемов: 2"],
      },
      {
        pagetitle: "Розетка серии G",
        short_traits: ["Количество USB разъемов: 2"],
      },
      {
        pagetitle: "Розетка одинарная серии G",
        short_traits: ["Количество разъемов: 2"],
      },
      {
        pagetitle: "Розетка двойная серии G",
        short_traits: ["Количество разъемов: 1"],
      },
    ]
  ) {
    assertEquals(
      productSupportsVisibleRequestContract(product, contract),
      false,
    );
  }
});

Deno.test("auxiliary port counts cannot stand in for two mains outlets", () => {
  const contract = buildVisibleRequestContract("двойные розетки", {
    productClass: "розетки",
    candidateTitles: ["Розетка двойная", "Розетка USB"],
  });
  for (
    const product of [
      {
        pagetitle: "Розетка USB",
        short_traits: ["USB: 2 гнезда", "Количество силовых розеток: 1"],
      },
      {
        pagetitle: "Розетка USB",
        short_traits: ["2 гнезда USB", "Количество силовых розеток: 1"],
      },
      { pagetitle: "Розетка USB 2 гнезда", short_traits: [] },
      { pagetitle: "Розетка серии G", short_traits: ["RJ45: 2 гнезда"] },
      { pagetitle: "Розетка серии G", short_traits: ["2 гнезда Type-C"] },
      { pagetitle: "Розетка USB", short_traits: ["Количество разъемов: 2"] },
      { pagetitle: "Розетка USB", short_traits: ["Количество розеток: 2"] },
      { pagetitle: "Розетка RJ45", short_traits: ["Количество разъемов: 2"] },
      {
        pagetitle: "Розетка серии G",
        short_traits: ["Количество разъемов: 2", "Type-C: 1 порт"],
      },
      {
        pagetitle: "Розетка двойная USB",
        short_traits: ["USB: 2 гнезда", "Количество силовых розеток: 1"],
      },
    ]
  ) {
    assertEquals(
      productSupportsVisibleRequestContract(product, contract),
      false,
    );
  }
});

Deno.test("explicit mains outlet proof survives auxiliary port context", () => {
  const contract = buildVisibleRequestContract("двойные розетки", {
    productClass: "розетки",
    candidateTitles: ["Розетка двойная", "Розетка USB"],
  });
  assertEquals(
    productSupportsVisibleRequestContract({
      pagetitle: "Розетка USB",
      short_traits: ["USB: 2 гнезда", "Количество силовых розеток: 2"],
    }, contract),
    true,
  );
  assertEquals(
    productSupportsVisibleRequestContract({
      pagetitle: "Розетка двойная USB",
      short_traits: ["Количество USB-разъемов: 2"],
    }, contract),
    true,
  );
});

Deno.test("qualified count-first mains evidence contradicts double wording", () => {
  const contract = buildVisibleRequestContract("двойные розетки", {
    productClass: "розетки",
    candidateTitles: ["Розетка двойная USB"],
  });
  for (
    const product of [
      {
        pagetitle: "Розетка двойная USB",
        short_traits: ["1 силовая розетка", "USB: 2 гнезда"],
      },
      { pagetitle: "Розетка двойная USB, 1 силовая розетка", short_traits: [] },
      {
        pagetitle: "Розетка двойная USB, 1 электрическая розетка",
        short_traits: [],
      },
      {
        pagetitle: "Розетка двойная USB",
        short_traits: ["1 штепсельная розетка"],
      },
    ]
  ) {
    assertEquals(
      productSupportsVisibleRequestContract(product, contract),
      false,
    );
  }
  assertEquals(
    productSupportsVisibleRequestContract({
      pagetitle: "Розетка USB",
      short_traits: ["2 силовые розетки", "USB: 1 гнездо"],
    }, contract),
    true,
  );
});

Deno.test("electrical connector wording does not prove two mains sockets with USB", () => {
  const contract = buildVisibleRequestContract("двойные розетки", {
    productClass: "розетки",
    candidateTitles: ["Розетка двойная", "Розетка USB"],
  });
  for (
    const product of [
      {
        pagetitle: "Розетка USB, 2 электрических разъема USB",
        short_traits: [],
      },
      {
        pagetitle: "Розетка USB",
        short_traits: ["Количество электрических разъемов: 2", "USB Type-C"],
      },
      {
        pagetitle: "Розетка USB",
        short_traits: ["Количество силовых разъемов: 2", "USB Type-C"],
      },
    ]
  ) {
    assertEquals(
      productSupportsVisibleRequestContract(product, contract),
      false,
    );
  }
  assertEquals(
    productSupportsVisibleRequestContract({
      pagetitle: "Розетка USB",
      short_traits: ["Количество силовых розеток: 2", "USB Type-C"],
    }, contract),
    true,
  );
});

Deno.test("double-socket wording subsumption leaves exact length mandatory", () => {
  const contract = buildVisibleRequestContract(
    "двойная розетка с кабелем 5 м",
    {
      productClass: "розетка",
      candidateTitles: ["Розетка двойная"],
    },
  );
  assertEquals(contract.map(({ kind }) => kind), [
    "linear_measurement",
    "count",
  ]);
  assertEquals(
    productSupportsVisibleRequestContract({
      pagetitle: "Розетка серии G",
      short_traits: ["Количество разъемов: 2", "Длина кабеля: 4 м"],
    }, contract),
    false,
  );
  assertEquals(
    productSupportsVisibleRequestContract({
      pagetitle: "Розетка серии G",
      short_traits: ["Количество разъемов: 2", "Длина кабеля: 5 м"],
    }, contract),
    true,
  );
});

Deno.test("directional measurements remain visible and preserve their bound", () => {
  const contract = buildVisibleRequestContract(
    "Покажите прожекторы мощностью от 100 Вт",
  );
  assertEquals(
    titleSupportsVisibleRequestContract("Прожектор LED 150W", contract),
    true,
  );
  assertEquals(
    titleSupportsVisibleRequestContract("Прожектор LED 100Вт", contract),
    true,
  );
  assertEquals(
    titleSupportsVisibleRequestContract("Прожектор LED 70W", contract),
    false,
  );
  assertEquals(
    titleSupportsVisibleRequestContract("Прожектор модель 06-150", contract),
    false,
  );
});

Deno.test("strict directional measurements do not accept their boundary", () => {
  const contract = buildVisibleRequestContract("Нужен товар больше 10 А");
  assertEquals(
    titleSupportsVisibleRequestContract("Товар 16A", contract),
    true,
  );
  assertEquals(
    titleSupportsVisibleRequestContract("Товар 10 А", contract),
    false,
  );
});

Deno.test("currency ceilings stay in the structured price guard, not the title contract", () => {
  const contract = buildVisibleRequestContract(
    "Найди автомат до 1000 тенге 1 полюсной, 16 А характеристика C",
    {
      productClass: "автоматический выключатель",
      candidateTitles: ["Автомат 1Р 16 А х-ка С"],
    },
  );
  assertEquals(
    contract.some((requirement) => requirement.label.includes("1000")),
    false,
  );
  assertEquals(
    titleSupportsVisibleRequestContract("Автомат 1Р 16 А х-ка С", contract),
    true,
  );
});

Deno.test("a live literal class modifier survives a later mixed recovery pool", () => {
  const contract = buildVisibleRequestContract(
    "Покажите светодиодные прожекторы мощностью от 100 Вт",
    {
      productClass: "светодиодные прожекторы",
      candidateTitles: [
        "Прожектор светодиодный 70W",
        "Прожектор ИО 150Вт",
        "Прожектор светодиодный 150Вт",
      ],
    },
  );
  assertEquals(
    titleSupportsVisibleRequestContract(
      "Прожектор светодиодный 150Вт",
      contract,
    ),
    true,
  );
  assertEquals(
    titleSupportsVisibleRequestContract("Прожектор светодиодный 70W", contract),
    false,
  );
  assertEquals(
    titleSupportsVisibleRequestContract("Прожектор ИО 150Вт", contract),
    false,
  );
});

Deno.test("a complete class proven by live taxonomy is not duplicated as a title modifier", () => {
  const contract = buildVisibleRequestContract(
    "подбери термоусадочную трубку для кабеля диаметром 12 мм",
    {
      productClass: "термоусадочная трубка",
      taxonomyClass: "Трубки термоусаживаемые",
      candidateTitles: [
        "Трубка ТТУ 16/8 мм",
        "Трубка термоусаживаемая 16/8 мм",
      ],
    },
  );
  assertEquals(contract.map((requirement) => requirement.label), []);
  assertEquals(
    titleSupportsVisibleRequestContract("Трубка ТТУ 16/8 мм", contract),
    true,
  );
});

Deno.test("a contextual measured object is not promoted from a mixed live-title cache", () => {
  for (const relation of ["для", "на"]) {
    const contract = buildVisibleRequestContract(
      `подбери трубку ${relation} кабель 12 мм`,
      {
        productClass: "трубка",
        taxonomyClass: "Трубки",
        candidateTitles: [
          "Трубка ТТУ 16/8 мм",
          "Трубка для кабеля 16/8 мм",
          "Кабель 12 мм",
        ],
      },
    );
    assertEquals(contract.map((requirement) => requirement.label), []);
    assertEquals(
      titleSupportsVisibleRequestContract("Трубка ТТУ 16/8 мм", contract),
      true,
    );
  }
});

Deno.test("a directly requested measured class remains the class, not a contextual object", () => {
  const contract = buildVisibleRequestContract(
    "подбери кабель диаметром 12 мм",
    {
      productClass: "кабель",
      taxonomyClass: "Кабели",
      candidateTitles: [
        "Кабель диаметром 12 мм",
        "Кабель 12 мм",
        "Трубка для кабеля",
      ],
    },
  );
  assertEquals(contract.map((requirement) => requirement.label), []);
  assertEquals(
    titleSupportsVisibleRequestContract("Кабель 12 мм", contract),
    true,
  );
});

Deno.test("a taxonomy-backed class term survives a broader frozen class", () => {
  const context = {
    productClass: "трубка",
    candidateTitles: ["Трубка термоусадочная 16/8 мм", "Трубка ТТУ 16/8 мм"],
  };
  const request = "подбери термоусадочную трубку для кабеля диаметром 12 мм";
  const backed = buildVisibleRequestContract(request, {
    ...context,
    taxonomyClass: "Трубки термоусаживаемые",
  });
  assertEquals(backed.map((requirement) => requirement.label), []);
  assertEquals(
    titleSupportsVisibleRequestContract("Трубка ТТУ 16/8 мм", backed),
    true,
  );

  const unrelatedTaxonomy = buildVisibleRequestContract(request, {
    ...context,
    taxonomyClass: "Трубки термостойкие",
  });
  assertEquals(unrelatedTaxonomy.map((requirement) => requirement.label), [
    "термоусадочную",
  ]);
  assertEquals(
    titleSupportsVisibleRequestContract(
      "Трубка ТТУ 16/8 мм",
      unrelatedTaxonomy,
    ),
    false,
  );
});

Deno.test("a real colour refinement remains visible beside a contextual object", () => {
  const contract = buildVisibleRequestContract(
    "подбери черную трубку для кабеля 12 мм",
    {
      productClass: "трубка",
      taxonomyClass: "Трубки",
      candidateTitles: ["Трубка черная 16/8 мм", "Трубка для кабеля 16/8 мм"],
    },
  );
  assertEquals(contract.map((requirement) => requirement.label), ["черную"]);
  assertEquals(
    titleSupportsVisibleRequestContract("Трубка черная 16/8 мм", contract),
    true,
  );
  assertEquals(
    titleSupportsVisibleRequestContract("Трубка белая 16/8 мм", contract),
    false,
  );
});

Deno.test("a refinement absent from live taxonomy remains a visible title modifier", () => {
  const contract = buildVisibleRequestContract(
    "покажи светодиодные прожекторы мощностью от 100 Вт",
    {
      productClass: "светодиодные прожекторы",
      taxonomyClass: "Прожекторы",
      candidateTitles: ["Прожектор светодиодный 150Вт", "Прожектор ИО 150Вт"],
    },
  );
  assertEquals(contract.map((requirement) => requirement.label), [
    "от 100 Вт",
    "светодиодные",
  ]);
});

Deno.test("a validated semantic facet mapping replaces only the duplicate literal spelling gate", () => {
  const contract = buildVisibleRequestContract(
    "покажи люминесцентные приборы мощностью от 100 Вт",
    {
      productClass: "приборы",
      taxonomyClass: "Приборы",
      candidateTitles: ["Прибор люминесцентный 150 Вт", "Прибор LX 150 Вт"],
      semanticallyMappedCustomerPhrases: ["люминесцентные"],
    },
  );
  assertEquals(contract.map((requirement) => requirement.label), ["от 100 Вт"]);
  assertEquals(
    titleSupportsVisibleRequestContract("Прибор LX 150 Вт", contract),
    true,
  );
});

Deno.test("a measurement descriptor is not duplicated as a literal title modifier", () => {
  const contract = buildVisibleRequestContract(
    "Покажите светодиодные прожекторы мощностью от 100 Вт",
    {
      productClass: "Прожекторы",
      candidateTitles: [
        "Прожектор светодиодный мощностью 70W",
        "Прожектор светодиодный MFL 01-150 150W",
      ],
    },
  );
  assertEquals(contract.map((requirement) => requirement.label), [
    "от 100 Вт",
    "светодиодные",
  ]);
  assertEquals(
    titleSupportsVisibleRequestContract(
      "Прожектор светодиодный MFL 01-150 150W",
      contract,
    ),
    true,
  );
});

Deno.test("a modifier absent from live titles is not guessed as catalog vocabulary", () => {
  const contract = buildVisibleRequestContract(
    "Покажите умные контроллеры",
    { productClass: "Контроллеры", candidateTitles: ["Контроллер ALPHA"] },
  );
  assertEquals(
    titleSupportsVisibleRequestContract("Контроллер ALPHA", contract),
    true,
  );
});

Deno.test("a non-empty rejected leaf permits one grounded full-text recovery", () => {
  assertEquals(shouldExpandVisibleRecoverySearch(true, 0), true);
  assertEquals(shouldExpandVisibleRecoverySearch(true, 1), false);
  assertEquals(shouldExpandVisibleRecoverySearch(false, 0), false);
});

Deno.test("visible recovery pagination is bounded and stops after confirmation", () => {
  assertEquals(
    shouldContinueVisibleRecoveryPage({
      page: 1,
      pageSize: 50,
      total: 145,
      confirmedCount: 0,
      maxPages: 4,
    }),
    true,
  );
  assertEquals(
    shouldContinueVisibleRecoveryPage({
      page: 2,
      pageSize: 50,
      total: 145,
      confirmedCount: 2,
      maxPages: 4,
    }),
    false,
  );
  assertEquals(
    shouldContinueVisibleRecoveryPage({
      page: 3,
      pageSize: 50,
      total: 145,
      confirmedCount: 0,
      maxPages: 4,
    }),
    false,
  );
  assertEquals(
    shouldContinueVisibleRecoveryPage({
      page: 4,
      pageSize: 50,
      total: 500,
      confirmedCount: 0,
      maxPages: 4,
    }),
    false,
  );
});

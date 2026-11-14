import {
  assert,
  assertEquals,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  cleanPowerMinimumWatts,
  type CleanPowerSearch,
  searchVerifiedCleanPowerCards,
  verifyCleanPowerCard,
} from "./clean-power-catalog-evidence.ts";
import type {
  ProductCache,
  ProductFull,
  ProductRef,
  SearchCatalogOk,
  ToolError,
} from "./types.ts";

function ups(overrides: Partial<ProductFull> = {}): ProductFull {
  return {
    id: "ups-1",
    pagetitle: "ИБП для котла",
    vendor: "Vendor",
    price: 12000,
    stock: "in_stock",
    short_traits: [
      "Форма выходного сигнала: Чистая синусоида",
      "Активная выходная мощность: 600 Вт",
    ],
    url: "https://220volt.kz/catalog/elektropitanie/ibp/ups-1/",
    leaf_category: "Источники бесперебойного питания",
    ...overrides,
  };
}

function ref(product: ProductFull): ProductRef {
  const {
    url: _url,
    facet_values: _facets,
    warehouse_evidence: _warehouse,
    ...rest
  } = product;
  return rest;
}

function okay(
  products: ProductFull[],
  total = products.length,
): SearchCatalogOk {
  return { ok: true, mode: "by_query", total, results: products.map(ref) };
}

const minimum = cleanPowerMinimumWatts("Какой ИБП для газового котла 250 Вт?");

Deno.test("clean-power candidate proves class, output waveform and active W independently", () => {
  assertEquals(minimum, 400);
  assertEquals(verifyCleanPowerCard(ups(), minimum), {
    verified: true,
    activeOutputWatts: 600,
    minimumWatts: 400,
    rejection: null,
  });
  assertEquals(
    verifyCleanPowerCard(
      ups({
        short_traits: [],
        facet_values: {
          forma_vykhodnogo_signala: ["Чистая синусоида"],
          aktivnaya_vykhodnaya_moshchnost_vt: ["0,6 кВт"],
        },
      }),
      minimum,
    ).verified,
    true,
  );
});

Deno.test("ATS and stabilizers are never presented as a boiler UPS", () => {
  for (
    const title of [
      "АВР / ATS для генератора и ИБП",
      "Стабилизатор напряжения с ИБП",
      "Автоматический ввод резерва ИБП",
    ]
  ) {
    assertEquals(
      verifyCleanPowerCard(ups({ pagetitle: title }), minimum).rejection,
      "wrong_class",
    );
  }
  assertEquals(
    verifyCleanPowerCard(
      ups({
        pagetitle: "Источник питания 600 Вт",
        leaf_category: "Электропитание",
      }),
      minimum,
    ).rejection,
    "wrong_class",
  );
});

Deno.test("output sine must be explicit; negative or stepped sine dominates positive wording", () => {
  const titleOnly = ups({
    pagetitle: "ИБП Pure Sine Wave 600W",
    short_traits: ["Активная выходная мощность: 600 Вт"],
  });
  assertEquals(
    verifyCleanPowerCard(titleOnly, minimum).rejection,
    "output_waveform_unproved",
  );
  const inputOnly = ups({
    short_traits: [
      "Форма входного сигнала: Чистая синусоида",
      "Активная выходная мощность: 600 Вт",
    ],
  });
  assertEquals(
    verifyCleanPowerCard(inputOnly, minimum).rejection,
    "output_waveform_unproved",
  );
  for (
    const value of [
      "Ступенчатая синусоида",
      "Модифицированная синусоида",
      "Не чистая синусоида",
      "Without pure sine",
      "Нет синусоиды",
    ]
  ) {
    assertEquals(
      verifyCleanPowerCard(
        ups({
          short_traits: [
            `Форма выходного сигнала: Чистая синусоида`,
            `Выходной сигнал: ${value}`,
            "Активная мощность: 600 Вт",
          ],
        }),
        minimum,
      ).rejection,
      "output_waveform_contradicted",
    );
  }
});

Deno.test("VA-only, input-W, peak-W and an ambiguous generic W are not active-output proof", () => {
  for (
    const trait of [
      "Выходная мощность: 1000 ВА",
      "Входная мощность: 800 Вт",
      "Пиковая выходная мощность: 800 Вт",
      "Мощность: 800 Вт",
      "Номинальная мощность: 800 Вт",
    ]
  ) {
    assertEquals(
      verifyCleanPowerCard(
        ups({
          short_traits: ["Форма выходного сигнала: Чистая синусоида", trait],
        }),
        minimum,
      ).rejection,
      "active_output_watts_unproved",
    );
  }
  assertEquals(
    verifyCleanPowerCard(
      ups({
        short_traits: [
          "Форма выходного сигнала: Чистая синусоида",
          "Выходная мощность: 1000 ВА / 600 Вт",
        ],
      }),
      minimum,
    ).verified,
    true,
  );
});

Deno.test("candidate below active W threshold or with conflicting ratings fails closed", () => {
  assertEquals(
    verifyCleanPowerCard(
      ups({
        short_traits: [
          "Форма выходного сигнала: Чистая синусоида",
          "Активная выходная мощность: 300 Вт",
        ],
      }),
      minimum,
    ).rejection,
    "active_output_watts_insufficient",
  );
  assertEquals(
    verifyCleanPowerCard(
      ups({
        short_traits: [
          "Форма выходного сигнала: Чистая синусоида",
          "Активная мощность: 600 Вт",
          "Выходная мощность: 350 Вт",
        ],
      }),
      minimum,
    ).rejection,
    "active_output_watts_insufficient",
  );
  assertEquals(
    verifyCleanPowerCard(ups({ stock: "out" }), minimum).rejection,
    "unavailable",
  );
  assertEquals(
    verifyCleanPowerCard(ups({ warehouse_evidence: "explicit_zero" }), minimum)
      .rejection,
    "unavailable",
  );
  assertEquals(
    verifyCleanPowerCard(ups({ price: 0 }), minimum).rejection,
    "unavailable",
  );
  assertEquals(verifyCleanPowerCard(ups(), null).rejection, "load_unstated");
});

Deno.test("bounded search returns proven cards with precise non-exhaustive guidance", async () => {
  const good = ups();
  const cache: ProductCache = new Map([[good.id, good]]);
  const calls: Array<{ query?: string; page?: number }> = [];
  const search: CleanPowerSearch = async (input) => {
    calls.push({ query: input.query, page: input.page });
    return input.query === "ИБП" ? okay([good]) : okay([]);
  };
  const result = await searchVerifiedCleanPowerCards(
    "Какой ИБП для котла 250 Вт?",
    search,
    cache,
  );
  assertEquals(result.status, "verified");
  assertEquals(result.products.map((p) => p.id), [good.id]);
  assertEquals(result.minimumWatts, 400);
  assertEquals(calls, [
    { query: "ИБП", page: 1 },
    { query: "источник бесперебойного питания", page: 1 },
    { query: "UPS", page: 1 },
  ]);
  assertStringIncludes(result.answer, "предварительные варианты");
  assertStringIncludes(result.answer, "пуск насоса");
});

Deno.test("catalog empty, catalog error and unverified results have different honest answers", async () => {
  const empty = await searchVerifiedCleanPowerCards(
    "ИБП для котла 250 Вт",
    async () => okay([]),
    new Map(),
  );
  assertEquals(empty.status, "empty");
  assertStringIncludes(empty.answer, "не доказывает");

  const error: ToolError = {
    ok: false,
    error_code: "catalog_timeout",
    message: "deadline",
  };
  const failed = await searchVerifiedCleanPowerCards(
    "ИБП для котла 250 Вт",
    async () => error,
    new Map(),
  );
  assertEquals(failed.status, "catalog_error");
  assertStringIncludes(failed.answer, "Каталог сейчас не ответил полностью");
  assertEquals(failed.answer.includes("карточки не пришли"), false);

  const wrong = ups({ pagetitle: "Стабилизатор напряжения с ИБП" });
  const unverified = await searchVerifiedCleanPowerCards(
    "ИБП для котла 250 Вт",
    async () => okay([wrong]),
    new Map([[wrong.id, wrong]]),
  );
  assertEquals(unverified.status, "unverified");
  assertEquals(unverified.products.length, 0);
  assertStringIncludes(
    unverified.answer,
    "не удалось подтвердить именно как ИБП",
  );
});

Deno.test("inconsistent zero total with materialized cards is not an empty catalog", async () => {
  const wrong = ups({ pagetitle: "АВР с ИБП" });
  const outcome = await searchVerifiedCleanPowerCards(
    "ИБП для котла 250 Вт",
    async () => okay([wrong], 0),
    new Map([[wrong.id, wrong]]),
  );
  assertEquals(outcome.status, "unverified");
  assertEquals(outcome.examinedCards, 1);
  assertEquals(outcome.answer.includes("карточки не пришли"), false);
});

Deno.test("search covers no more than four catalog pages and does not borrow generator watts", async () => {
  const good = ups();
  const cache: ProductCache = new Map([[good.id, good]]);
  let calls = 0;
  const result = await searchVerifiedCleanPowerCards(
    "Генератор 900 Вт даёт грязную энергию. Нужен ИБП для котла с чистой синусоидой",
    async () => {
      calls++;
      return okay([good], 500);
    },
    cache,
  );
  assertEquals(calls, 4);
  assertEquals(result.searchCalls, 4);
  assertEquals(result.status, "unverified");
  assertEquals(result.minimumWatts, null);
  assertEquals(result.rejectionCounts.load_unstated, 1);
  assert(result.answer.includes("укажите максимальное суммарное потребление"));
  assert(result.answer.includes("совместимость входа конкретного ИБП"));
  assertEquals(result.answer.includes("генератора 900 Вт"), false);
});

Deno.test("class-wide retrieval covers UPS alias before noisy query pagination", async () => {
  const good = ups({ id: "good-ups", pagetitle: "UPS 1000 VA" });
  const wrong = ups({ id: "wrong", pagetitle: "АВР для ИБП" });
  const cache: ProductCache = new Map([[good.id, good], [wrong.id, wrong]]);
  const calls: Array<{ query?: string; page?: number }> = [];
  const result = await searchVerifiedCleanPowerCards(
    "Какой ИБП для газового котла 250 Вт?",
    async (input) => {
      calls.push({ query: input.query, page: input.page });
      return input.query === "UPS" ? okay([good]) : okay([wrong], 500);
    },
    cache,
  );
  assertEquals(calls.slice(0, 3), [
    { query: "ИБП", page: 1 },
    { query: "источник бесперебойного питания", page: 1 },
    { query: "UPS", page: 1 },
  ]);
  assertEquals(calls.length, 4);
  assertEquals(result.products.map((p) => p.id), [good.id]);
  assertEquals(result.rejectionCounts.wrong_class, 1);
  assertEquals(result.partial, true);
});

Deno.test("all wrong-class candidates explain class failure rather than missing electrical proof", async () => {
  // Synthetic counterexample, NOT a replay of the seven unrecorded live SKUs.
  const cards = Array.from({ length: 7 }, (_, i) =>
    ups({
      id: `wrong-${i}`,
      pagetitle: "Стабилизатор напряжения с ИБП",
    }));
  const result = await searchVerifiedCleanPowerCards(
    "ИБП для котла 250 Вт",
    async () => okay(cards),
    new Map(cards.map((p) => [p.id, p])),
  );
  assertEquals(result.products.length, 0);
  assertEquals(result.rejectionCounts.wrong_class, 7);
  assertStringIncludes(result.answer, "не удалось подтвердить именно как ИБП");
  assertStringIncludes(result.answer, "не доказывает отсутствия ИБП");
  assertEquals(
    result.answer.includes("одновременно по чистой синусоиде"),
    false,
  );
});

Deno.test("additional UPS query never confers identity, waveform or active watt proof", async () => {
  const cards = [
    ups({ id: "ats", pagetitle: "ATS для ИБП" }),
    ups({
      id: "sine",
      pagetitle: "UPS Pure Sine 600W",
      short_traits: ["Активная мощность: 600 Вт"],
    }),
    ups({
      id: "va",
      short_traits: [
        "Форма выходного сигнала: Чистая синусоида",
        "Выходная мощность: 1000 ВА",
      ],
    }),
    ups({
      id: "weak",
      short_traits: [
        "Форма выходного сигнала: Чистая синусоида",
        "Активная мощность: 300 Вт",
      ],
    }),
  ];
  const calls: string[] = [];
  const result = await searchVerifiedCleanPowerCards(
    "ИБП для котла 250 Вт",
    async (input) => {
      calls.push(input.query!);
      return input.query === "UPS" ? okay(cards) : okay([]);
    },
    new Map(cards.map((p) => [p.id, p])),
  );
  assertEquals(calls.includes("UPS"), true);
  assertEquals(result.products.length, 0);
  assertEquals(result.rejectionCounts, {
    wrong_class: 1,
    output_waveform_unproved: 1,
    active_output_watts_unproved: 1,
    active_output_watts_insufficient: 1,
  });
});

Deno.test("class diagnostics distinguish prohibited title, category conflict and absent UPS evidence without relaxing identity", async () => {
  const cards = [
    ups({ id: "title", pagetitle: "ATS для ИБП" }),
    ups({
      id: "category",
      pagetitle: "UPS",
      leaf_category: "Стабилизаторы и ИБП",
    }),
    ups({
      id: "unknown",
      pagetitle: "Блок питания",
      leaf_category: "Электропитание",
    }),
  ];
  const result = await searchVerifiedCleanPowerCards(
    "ИБП для котла 250 Вт",
    async () => okay(cards),
    new Map(cards.map((p) => [p.id, p])),
  );
  assertEquals(result.products.length, 0);
  assertEquals(
    result.classRejections.map((
      x,
    ) => [x.product_id, x.reason, x.excluded_source]),
    [
      ["title", "excluded_power_class", "title"],
      ["category", "excluded_power_class", "category"],
      ["unknown", "ups_identity_unproved", "none"],
    ],
  );
  assertEquals(result.classRejections[1].title_has_ups_identity, true);
  assertEquals(result.classRejections[2].title_has_ups_identity, false);
});

Deno.test("class diagnostics are capped and omit unsafe ids and raw catalog prose", async () => {
  const cards = Array.from({ length: 12 }, (_, i) =>
    ups({
      id: i === 0 ? "unsafe/<private>" : `wrong-${i}`,
      pagetitle: "Стабилизатор с ИБП private-marker",
    }));
  const result = await searchVerifiedCleanPowerCards(
    "ИБП для котла 250 Вт",
    async () => okay(cards),
    new Map(cards.map((p) => [p.id, p])),
  );
  assertEquals(result.rejectionCounts.wrong_class, 12);
  assertEquals(result.classRejections.length, 8);
  assertEquals(result.classRejections[0].product_id, null);
  assertEquals(
    JSON.stringify(result.classRejections).includes("private-marker"),
    false,
  );
});

Deno.test("a failed alias does not prevent another alias, and partial status is honest", async () => {
  const good = ups();
  const result = await searchVerifiedCleanPowerCards(
    "ИБП для котла 250 Вт",
    async (input) => {
      if (input.query === "ИБП") throw Error("offline catalog failure");
      return input.query === "UPS" ? okay([good]) : okay([]);
    },
    new Map([[good.id, good]]),
  );
  assertEquals(result.searchCalls, 3);
  assertEquals(result.products.length, 1);
  assertEquals(result.partial, true);
  assertStringIncludes(result.answer, "Поиск был частичным");
});

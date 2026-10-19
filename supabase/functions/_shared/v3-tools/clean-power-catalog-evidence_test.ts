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
  assertStringIncludes(unverified.answer, "В проверенной выборке");
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

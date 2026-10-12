import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  executeDiscoverCategory,
  liftUngroundedLeafToCustomerHeadAncestor,
  resolveGroundedCategoryHeadToken,
  resolveHeadCategoryByFacetEvidence,
  resolveHeadCategoryByLeastSpecializedSibling,
  resolveHeadCategoryByLiveHierarchy,
  resolveLocalCategoryPagetitles,
} from "./discover-category.ts";

Deno.test("live category discovery bounds taxonomy and resolver headers and bodies", async () => {
  const baseDeps = {
    baseUrl: "https://catalog.example.test",
    apiToken: "test-token",
    openrouterApiKey: "test-model-token",
    timeoutMs: 20,
  };
  const pending = () => new Promise<Response>(() => {});
  const hangingBody = () =>
    ({
      ok: true,
      json: () => new Promise<unknown>(() => {}),
    }) as Response;
  const requestSignals: AbortSignal[] = [];

  const fetchNeverSettles =
    ((_url: string | URL | Request, init?: RequestInit) => {
      requestSignals.push(init?.signal as AbortSignal);
      return pending();
    }) as typeof fetch;
  const taxonomyHeaders = await executeDiscoverCategory(
    { noun: "Светильники" },
    { ...baseDeps, fetchImpl: fetchNeverSettles },
  );
  assertEquals(taxonomyHeaders.ok, false);
  if (!taxonomyHeaders.ok) {
    assertEquals(taxonomyHeaders.error_code, "catalog_timeout");
  }
  assertEquals(requestSignals.at(-1)?.aborted, true);

  const fetchBodyNeverSettles =
    ((_url: string | URL | Request, init?: RequestInit) => {
      requestSignals.push(init?.signal as AbortSignal);
      return Promise.resolve(hangingBody());
    }) as typeof fetch;
  const taxonomyBody = await executeDiscoverCategory(
    { noun: "Светильники" },
    { ...baseDeps, fetchImpl: fetchBodyNeverSettles },
  );
  assertEquals(taxonomyBody.ok, false);
  if (!taxonomyBody.ok) {
    assertEquals(taxonomyBody.error_code, "catalog_timeout");
  }
  assertEquals(requestSignals.at(-1)?.aborted, true);

  let taxonomyLoads = 0;
  const fetchLive = ((url: string | URL | Request) => {
    const path = String(url);
    if (path.includes("/categories?")) {
      taxonomyLoads++;
      return Promise.resolve(
        new Response(JSON.stringify({
          data: {
            results: [{ id: 501, pagetitle: "Светильники", children: [] }],
            pagination: { pages: 1 },
          },
        })),
      );
    }
    if (path.includes("/categories/options?")) {
      return Promise.resolve(
        new Response(JSON.stringify({
          data: {
            category: { id: 501, pagetitle: "Светильники", total_products: 2 },
            options: [{
              key: "shape",
              caption_ru: "Форма",
              type: "string",
              values: [{ value_ru: "круглый", products_count: 2 }],
            }],
          },
        })),
      );
    }
    throw new Error(`unexpected fetch ${path}`);
  }) as typeof fetch;
  const exact = await executeDiscoverCategory(
    { noun: "Светильники" },
    { ...baseDeps, fetchImpl: fetchLive },
  );
  assertEquals(exact.ok, true);
  if (exact.ok) {
    assertEquals(exact.category.pagetitle, "Светильники");
    assertEquals(exact.resolution_method, "exact");
    assertEquals(exact.leaf_categories, [{
      id: 501,
      pagetitle: "Светильники",
    }]);
  }
  assertEquals(taxonomyLoads, 1);

  const optionsHeaders = await executeDiscoverCategory(
    { noun: "Светильники" },
    {
      ...baseDeps,
      fetchImpl: ((url: string | URL | Request, init?: RequestInit) => {
        assertEquals(String(url).includes("/categories/options?"), true);
        requestSignals.push(init?.signal as AbortSignal);
        return pending();
      }) as typeof fetch,
    },
  );
  assertEquals(optionsHeaders.ok, false);
  if (!optionsHeaders.ok) {
    assertEquals(optionsHeaders.error_code, "catalog_timeout");
  }
  assertEquals(requestSignals.at(-1)?.aborted, true);

  const optionsBody = await executeDiscoverCategory(
    { noun: "Светильники" },
    {
      ...baseDeps,
      fetchImpl: ((url: string | URL | Request, init?: RequestInit) => {
        assertEquals(String(url).includes("/categories/options?"), true);
        requestSignals.push(init?.signal as AbortSignal);
        return Promise.resolve(hangingBody());
      }) as typeof fetch,
    },
  );
  assertEquals(optionsBody.ok, false);
  if (!optionsBody.ok) assertEquals(optionsBody.error_code, "catalog_timeout");
  assertEquals(requestSignals.at(-1)?.aborted, true);

  // Once taxonomy is cached, an unrelated noun must take the model resolver.
  // Its own fetch and body reader must both end as a timeout, never as an
  // invented category or an indefinitely pending accepted request.
  const resolverHeaders = await executeDiscoverCategory(
    { noun: "несуществующий товар" },
    {
      ...baseDeps,
      fetchImpl: ((url: string | URL | Request, init?: RequestInit) => {
        assertEquals(String(url).includes("openrouter.ai"), true);
        requestSignals.push(init?.signal as AbortSignal);
        return pending();
      }) as typeof fetch,
    },
  );
  assertEquals(resolverHeaders.ok, false);
  if (!resolverHeaders.ok) {
    assertEquals(resolverHeaders.error_code, "catalog_timeout");
  }
  assertEquals(requestSignals.at(-1)?.aborted, true);

  const resolverBody = await executeDiscoverCategory(
    { noun: "несуществующий товар" },
    {
      ...baseDeps,
      fetchImpl: ((url: string | URL | Request, init?: RequestInit) => {
        assertEquals(String(url).includes("openrouter.ai"), true);
        requestSignals.push(init?.signal as AbortSignal);
        return Promise.resolve(hangingBody());
      }) as typeof fetch,
    },
  );
  assertEquals(resolverBody.ok, false);
  if (!resolverBody.ok) {
    assertEquals(resolverBody.error_code, "catalog_timeout");
  }
  assertEquals(requestSignals.at(-1)?.aborted, true);

  const resolverSuccess = await executeDiscoverCategory(
    { noun: "несуществующий товар" },
    {
      ...baseDeps,
      fetchImpl: ((url: string | URL | Request) => {
        if (String(url).includes("openrouter.ai")) {
          return Promise.resolve(
            new Response(JSON.stringify({
              choices: [{
                message: {
                  content: JSON.stringify({
                    candidates: [{ pagetitle: "Светильники", confidence: 0.9 }],
                  }),
                },
              }],
            })),
          );
        }
        return fetchLive(url);
      }) as typeof fetch,
    },
  );
  assertEquals(resolverSuccess.ok, true);
  if (resolverSuccess.ok) {
    assertEquals(resolverSuccess.category.pagetitle, "Светильники");
    assertEquals(resolverSuccess.resolution_method, "model");
  }
});

Deno.test("price-only fresh taxonomy sees a new leaf while ordinary discovery keeps its cache", async () => {
  const oldLeaf = { id: 9501, pagetitle: "ВВГ 3x1,5", children: [] };
  const newLeaf = { id: 9502, pagetitle: "ВВГ ГОСТ 3x1,5", children: [] };
  let currentLeaves = [oldLeaf];
  let failFreshFetch = false;
  let taxonomyLoads = 0;
  const fetchImpl = ((url: string | URL | Request) => {
    const path = String(url);
    if (path.includes("/categories?")) {
      taxonomyLoads++;
      if (failFreshFetch) return Promise.resolve(new Response("unavailable", { status: 503 }));
      return Promise.resolve(new Response(JSON.stringify({
        data: {
          results: [{ id: 9500, pagetitle: "Кабель ВВГ", children: currentLeaves }],
          pagination: { page: 1, per_page: 200, pages: 1, total: 1 },
        },
      })));
    }
    if (path.includes("/categories/options?")) {
      return Promise.resolve(new Response(JSON.stringify({
        data: {
          category: { id: 9500, pagetitle: "Кабель ВВГ", total_products: 2 },
          options: [{
            key: "section",
            caption_ru: "Сечение",
            type: "string",
            values: [{ value_ru: "1,5", products_count: 2 }],
          }],
        },
      })));
    }
    throw new Error(`unexpected fetch ${path}`);
  }) as typeof fetch;
  const deps = { baseUrl: "https://catalog.example.test", apiToken: "test-token", fetchImpl };
  const noun = { noun: "Кабель ВВГ" };

  const seeded = await executeDiscoverCategory(noun, { ...deps, forceFreshTaxonomy: true });
  assertEquals(seeded.ok, true);
  if (seeded.ok) assertEquals(seeded.leaf_categories, [{ id: 9501, pagetitle: "ВВГ 3x1,5" }]);
  assertEquals(taxonomyLoads, 1);

  currentLeaves = [oldLeaf, newLeaf];
  const cached = await executeDiscoverCategory(noun, deps);
  assertEquals(cached.ok, true);
  if (cached.ok) assertEquals(cached.leaf_categories, [{ id: 9501, pagetitle: "ВВГ 3x1,5" }]);
  assertEquals(taxonomyLoads, 1);

  const refreshed = await executeDiscoverCategory(noun, { ...deps, forceFreshTaxonomy: true });
  assertEquals(refreshed.ok, true);
  if (refreshed.ok) {
    assertEquals(
      refreshed.leaf_categories.map((leaf) => leaf.id).sort(),
      [9501, 9502],
    );
  }
  assertEquals(taxonomyLoads, 2);

  failFreshFetch = true;
  const failed = await executeDiscoverCategory(noun, { ...deps, forceFreshTaxonomy: true });
  assertEquals(failed.ok, false);
  if (!failed.ok) assertEquals(failed.error_code, "transport_5xx");
  assertEquals(taxonomyLoads, 3);
  const ordinaryAfterFailure = await executeDiscoverCategory(noun, deps);
  assertEquals(ordinaryAfterFailure.ok, true);
  assertEquals(taxonomyLoads, 3);
});

Deno.test("price-only taxonomy rejects missing, changed and truncated pagination", async () => {
  const root = (id: number) => ({ id, pagetitle: `Категория ${id}`, children: [] });
  const firstRows = Array.from({ length: 200 }, (_, index) => root(10_000 + index));
  const cases = [
    {
      first: { results: [root(10_000)], pagination: { page: 1, per_page: 200, total: 1 } },
      second: null,
    },
    {
      first: {
        results: firstRows,
        pagination: { page: 1, per_page: 200, pages: 2, total: 201 },
      },
      second: {
        results: [root(10_200)],
        pagination: { page: 2, per_page: 200, pages: 2, total: 202 },
      },
    },
    {
      first: {
        results: firstRows,
        pagination: { page: 1, per_page: 200, pages: 2, total: 201 },
      },
      second: {
        results: [],
        pagination: { page: 2, per_page: 200, pages: 2, total: 201 },
      },
    },
  ];
  for (const scenario of cases) {
    const fetchImpl = ((url: string | URL | Request) => {
      const page = new URL(String(url)).searchParams.get("page");
      const value = page === "1" ? scenario.first : scenario.second;
      if (!value) throw new Error("unexpected category page");
      return Promise.resolve(new Response(JSON.stringify({ data: value })));
    }) as typeof fetch;
    const result = await executeDiscoverCategory(
      { noun: "Категория 10000" },
      {
        baseUrl: "https://catalog.example.test",
        apiToken: "test-token",
        fetchImpl,
        forceFreshTaxonomy: true,
      },
    );
    assertEquals(result.ok, false);
    if (!result.ok) assertEquals(result.error_code, "transport_5xx");
  }
});

Deno.test("price-only taxonomy resolves a category on the final verified page", async () => {
  const firstRows = Array.from({ length: 200 }, (_, index) => ({
    id: 20_000 + index,
    pagetitle: `Категория ${20_000 + index}`,
    children: [],
  }));
  let fetchedPages: number[] = [];
  const fetchImpl = ((input: string | URL | Request) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith("/categories")) {
      const page = Number(url.searchParams.get("page"));
      fetchedPages.push(page);
      return Promise.resolve(new Response(JSON.stringify({
        data: {
          results: page === 1 ? firstRows : [{
            id: 21_000,
            pagetitle: "Кабель ВВГ",
            children: [{ id: 21_001, pagetitle: "ВВГ 3x1,5", children: [] }],
          }],
          pagination: { page, per_page: 200, pages: 2, total: 201 },
        },
      })));
    }
    if (url.pathname.endsWith("/categories/options")) {
      return Promise.resolve(new Response(JSON.stringify({ data: {
        category: { id: 21_000, pagetitle: "Кабель ВВГ", total_products: 1 },
        options: [{
          key: "section",
          caption_ru: "Сечение",
          type: "string",
          values: [{ value_ru: "1,5", products_count: 1 }],
        }],
      } })));
    }
    throw new Error(`unexpected fetch ${url}`);
  }) as typeof fetch;
  const result = await executeDiscoverCategory(
    { noun: "Кабель ВВГ" },
    {
      baseUrl: "https://catalog.example.test",
      apiToken: "test-token",
      fetchImpl,
      forceFreshTaxonomy: true,
    },
  );
  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.resolution_method, "exact");
    assertEquals(result.leaf_categories, [{ id: 21_001, pagetitle: "ВВГ 3x1,5" }]);
  }
  assertEquals(fetchedPages, [1, 2]);
});

Deno.test("price-only discovery stops after fresh taxonomy when the class title is not exact", async () => {
  let requests = 0;
  const fetchImpl = ((input: string | URL | Request) => {
    requests++;
    const url = new URL(String(input));
    assertEquals(url.pathname.endsWith("/categories"), true);
    return Promise.resolve(new Response(JSON.stringify({ data: {
      results: [{ id: 31_000, pagetitle: "Кабель ВВГ", children: [] }],
      pagination: { page: 1, per_page: 200, pages: 1, total: 1 },
    } })));
  }) as typeof fetch;
  const result = await executeDiscoverCategory(
    { noun: "Кабель" },
    {
      baseUrl: "https://catalog.example.test",
      apiToken: "test-token",
      fetchImpl,
      openrouterApiKey: "unused-model-token",
      forceFreshTaxonomy: true,
      requireExactPagetitle: true,
    },
  );
  assertEquals(result.ok, false);
  if (!result.ok) assertEquals(result.error_code, "category_not_found");
  assertEquals(requests, 1);
});

Deno.test("a generic live head selects the uniquely least-specialized sibling", () => {
  const nodes = [
    {
      id: 1,
      pagetitle: "Защитные устройства",
      parentId: null,
      childrenIds: [2, 3],
    },
    {
      id: 2,
      pagetitle: "Автоматические выключатели",
      parentId: 1,
      childrenIds: [],
    },
    {
      id: 3,
      pagetitle: "Автоматы защиты двигателя",
      parentId: 1,
      childrenIds: [],
    },
  ];
  assertEquals(
    resolveHeadCategoryByLeastSpecializedSibling(
      "Нужен автомат для квартиры",
      ["Автоматические выключатели", "Автоматы защиты двигателя"],
      nodes,
    ),
    "Автоматические выключатели",
  );
});

Deno.test("least-specialized sibling resolution fails closed on ties or unrelated parents", () => {
  const tied = [
    { id: 1, pagetitle: "Общий раздел", parentId: null, childrenIds: [2, 3] },
    { id: 2, pagetitle: "Кабели силовые", parentId: 1, childrenIds: [] },
    { id: 3, pagetitle: "Кабели сигнальные", parentId: 1, childrenIds: [] },
  ];
  assertEquals(
    resolveHeadCategoryByLeastSpecializedSibling(
      "Нужен кабель",
      ["Кабели силовые", "Кабели сигнальные"],
      tied,
    ),
    null,
  );
  assertEquals(
    resolveHeadCategoryByLeastSpecializedSibling(
      "Нужен автомат",
      ["Автоматические выключатели", "Автоматы защиты двигателя"],
      [
        {
          id: 2,
          pagetitle: "Автоматические выключатели",
          parentId: 10,
          childrenIds: [],
        },
        {
          id: 3,
          pagetitle: "Автоматы защиты двигателя",
          parentId: 11,
          childrenIds: [],
        },
      ],
    ),
    null,
  );
});

const LIVE_TITLES = [
  "Светильники",
  "Уличные светильники",
  "Светильники для ЖКХ",
  "Датчики",
  "Средства для удаления наклеек",
  "Прожекторы",
  "Кабели силовые",
  "Кабели сигнальные",
  "Трубки термоусаживаемые",
  "Автоматические выключатели",
];

Deno.test("local live-taxonomy resolver handles an obvious inflected class without a model", () => {
  assertEquals(
    resolveLocalCategoryPagetitles({
      noun: "мне нужен бытовой светильник с датчиком движения",
      semantic_query:
        "мне нужен бытовой светильник с датчиком движения до 4000 тенге",
    }, LIVE_TITLES),
    ["Светильники"],
  );
});

Deno.test("local live-taxonomy resolver treats a prepositional class as a modifier, not the head product", () => {
  assertEquals(
    resolveLocalCategoryPagetitles({
      noun: "светильник с датчиком",
      semantic_query: "мне нужен светильник с датчиком движения",
    }, LIVE_TITLES),
    ["Светильники"],
  );
  assertEquals(
    resolveLocalCategoryPagetitles({
      noun: "датчик движения",
      semantic_query: "мне нужен датчик движения",
    }, LIVE_TITLES),
    ["Датчики"],
  );
});

Deno.test("a browse collection after из remains the requested class, while material does not", () => {
  assertEquals(
    resolveGroundedCategoryHeadToken(
      "Что предложите из автоматов на 25 А?",
      "Автоматические выключатели",
    ),
    "автоматов",
  );
  assertEquals(
    resolveGroundedCategoryHeadToken(
      "Покажите светильник из стекла",
      "Стеклянные изделия",
    ),
    null,
  );
});

Deno.test("standalone class head does not match a longer compound category prefix", () => {
  assertEquals(
    resolveLocalCategoryPagetitles({
      noun:
        "Подберите кабель для камер видеонаблюдения Уточнение клиента: Система аналоговая, улица, длина трассы 30 м",
      semantic_query:
        "Подберите кабель для камер видеонаблюдения Уточнение клиента: Система аналоговая, улица, длина трассы 30 м",
    }, ["Кабеленесущие системы", "Кабель и провод"]),
    ["Кабель и провод"],
  );
});

Deno.test("a shared grounded head resolves only through a proven live hierarchy umbrella", () => {
  const tree = [
    {
      id: 1,
      pagetitle: "Кабели, провода и изделия для прокладки кабеля",
      parentId: null,
      childrenIds: [2, 5],
    },
    { id: 2, pagetitle: "Кабель и провод", parentId: 1, childrenIds: [3, 4] },
    {
      id: 3,
      pagetitle: "Кабели связи телефонные",
      parentId: 2,
      childrenIds: [],
    },
    { id: 4, pagetitle: "Кабель коаксиальный", parentId: 2, childrenIds: [] },
    { id: 5, pagetitle: "Кабельная арматура", parentId: 1, childrenIds: [6] },
    { id: 6, pagetitle: "Кабельные вводы", parentId: 5, childrenIds: [] },
    { id: 7, pagetitle: "Светильники", parentId: null, childrenIds: [] },
  ];
  assertEquals(
    resolveHeadCategoryByLiveHierarchy(
      "кабель для видеонаблюдения, аналоговая система, улица, 30 метров",
      tree.map((node) => node.pagetitle),
      tree,
    ),
    "Кабель и провод",
  );

  assertEquals(
    resolveHeadCategoryByLiveHierarchy(
      "нужен держатель для кабеля",
      tree.map((node) => node.pagetitle),
      tree,
    ),
    null,
  );
});

Deno.test("live hierarchy recovery stays fail-closed without one common umbrella", () => {
  const tree = [
    { id: 1, pagetitle: "Первая группа", parentId: null, childrenIds: [2] },
    { id: 2, pagetitle: "Кабель КГ", parentId: 1, childrenIds: [] },
    { id: 3, pagetitle: "Вторая группа", parentId: null, childrenIds: [4] },
    { id: 4, pagetitle: "Кабель ВВГ", parentId: 3, childrenIds: [] },
  ];
  assertEquals(
    resolveHeadCategoryByLiveHierarchy(
      "нужен кабель для оборудования",
      tree.map((node) => node.pagetitle),
      tree,
    ),
    null,
  );
});

Deno.test("local live-taxonomy resolver prefers a fully customer-grounded specific class", () => {
  assertEquals(
    resolveLocalCategoryPagetitles({
      noun: "уличный светильник",
      semantic_query: "Нужен уличный светильник во двор",
    }, LIVE_TITLES),
    ["Уличные светильники"],
  );
  assertEquals(
    resolveLocalCategoryPagetitles({
      noun: "термоусадочная трубка",
      semantic_query: "Найди термоусадочную трубку диаметром 12 мм",
    }, LIVE_TITLES),
    ["Трубки термоусаживаемые"],
  );
});

Deno.test("local live-taxonomy resolver categorizes only the destination of a transformation", () => {
  assertEquals(
    resolveLocalCategoryPagetitles({
      noun:
        "Хочу заменить люстру на светодиодный светильник в гостиной 25 м². Что можете предложить?",
      semantic_query:
        "Хочу заменить люстру на светодиодный светильник в гостиной 25 м². Что можете предложить?",
    }, ["Люстры", "Светильники"]),
    ["Светильники"],
  );

  assertEquals(
    resolveLocalCategoryPagetitles({
      noun: "Хочу заменить светильник на люстру для гостиной",
      semantic_query: "Хочу заменить светильник на люстру для гостиной",
    }, ["Люстры", "Светильники"]),
    ["Люстры"],
  );

  assertEquals(
    resolveLocalCategoryPagetitles({
      noun:
        "Чем заменить люстру: нужен светодиодный светильник для гостиной площадью 25 кв. м?",
      semantic_query:
        "Чем заменить люстру: нужен светодиодный светильник для гостиной площадью 25 кв. м?",
    }, ["Люстры", "Светильники"]),
    ["Светильники"],
  );
});

Deno.test("local live-taxonomy resolver fails closed on a shared ambiguous class", () => {
  assertEquals(
    resolveLocalCategoryPagetitles({
      noun: "кабель",
      semantic_query: "Нужен кабель",
    }, LIVE_TITLES),
    [],
  );
  assertEquals(
    resolveLocalCategoryPagetitles({
      noun: "кабель для стационарного оборудования",
      semantic_query:
        "Нужен кабель для стационарного оборудования мощностью 3 кВт",
    }, ["Кабель КГ", "Кабель ВВГ", "Кабель и провод"]),
    [],
  );
  assertEquals(
    resolveLocalCategoryPagetitles({
      noun: "кабель КГ",
      semantic_query: "Нужен кабель КГ",
    }, ["Кабель КГ", "Кабель ВВГ", "Кабель и провод"]),
    ["Кабель КГ"],
  );
});

Deno.test("semantic discovery lifts an unrequested leaf to the nearest live head ancestor", () => {
  const tree = [
    { id: 1, pagetitle: "Каталог", parentId: null, childrenIds: [2] },
    {
      id: 2,
      pagetitle: "Проводники и аксессуары",
      parentId: 1,
      childrenIds: [3],
    },
    { id: 3, pagetitle: "Проводник и шнур", parentId: 2, childrenIds: [4, 5] },
    { id: 4, pagetitle: "Проводник ZX", parentId: 3, childrenIds: [] },
    { id: 5, pagetitle: "Проводник QY", parentId: 3, childrenIds: [] },
  ];
  assertEquals(
    liftUngroundedLeafToCustomerHeadAncestor(
      "Нужен проводник для стационарного прибора мощностью 3 кВт",
      "Проводник ZX",
      tree,
    ),
    "Проводник и шнур",
  );
  assertEquals(
    resolveGroundedCategoryHeadToken(
      "Нужен проводник для стационарного прибора мощностью 3 кВт",
      "Проводник и шнур",
    ),
    "проводник",
  );
});

Deno.test("an explicitly named live leaf is never lifted", () => {
  const tree = [
    { id: 1, pagetitle: "Проводник и шнур", parentId: null, childrenIds: [2] },
    { id: 2, pagetitle: "Проводник ZX", parentId: 1, childrenIds: [] },
  ];
  assertEquals(
    liftUngroundedLeafToCustomerHeadAncestor(
      "Нужен проводник ZX сечением 2,5 мм²",
      "Проводник ZX",
      tree,
    ),
    "Проводник ZX",
  );
});

Deno.test("taxonomy lifting does not replace a model-selected umbrella", () => {
  const tree = [
    { id: 1, pagetitle: "Проводник и шнур", parentId: null, childrenIds: [2] },
    { id: 2, pagetitle: "Проводник ZX", parentId: 1, childrenIds: [] },
  ];
  assertEquals(
    liftUngroundedLeafToCustomerHeadAncestor(
      "Нужен проводник для оборудования",
      "Проводник и шнур",
      tree,
    ),
    "Проводник и шнур",
  );
});

Deno.test("local live-taxonomy resolver accepts a unique compound category head", () => {
  assertEquals(
    resolveLocalCategoryPagetitles({
      noun: "Найди автомат до 1000 тенге 1 полюсной, 16 А характеристика С",
      semantic_query:
        "Найди автомат до 1000 тенге 1 полюсной, 16 А характеристика С",
    }, LIVE_TITLES),
    ["Автоматические выключатели"],
  );
  assertEquals(
    resolveGroundedCategoryHeadToken(
      "Найди автомат до 1000 тенге 1 полюсной, 16 А характеристика С",
      "Автоматические выключатели",
    ),
    "автомат",
  );
});

Deno.test("partial live-taxonomy heads remain fail-closed for modifiers and ambiguity", () => {
  assertEquals(
    resolveLocalCategoryPagetitles({
      noun: "нужно для автоматического включения света",
      semantic_query: "нужно устройство для автоматического включения света",
    }, LIVE_TITLES),
    [],
  );
  assertEquals(
    resolveGroundedCategoryHeadToken(
      "нужно устройство для автоматического включения света",
      "Автоматические выключатели",
    ),
    null,
  );
  assertEquals(
    resolveGroundedCategoryHeadToken(
      "не хочу автомат, нужен другой аппарат",
      "Автоматические выключатели",
    ),
    null,
  );
  assertEquals(
    resolveLocalCategoryPagetitles({
      noun: "не хочу средство для наклеек",
      semantic_query: "не хочу средство для наклеек, нужна лампа",
    }, LIVE_TITLES),
    [],
  );
  assertEquals(
    resolveLocalCategoryPagetitles({
      noun: "нужен кабель",
      semantic_query: "нужен кабель",
    }, ["Кабели силовые", "Кабели сигнальные"]),
    [],
  );
});

Deno.test("ambiguous live heads require unique evidence from at least two facet axes", () => {
  const candidates = [
    {
      pagetitle: "Автоматические выключатели",
      facets: [
        { caption: "Количество полюсов" },
        { caption: "Характеристика срабатывания" },
        { caption: "Номинальный ток" },
      ],
    },
    {
      pagetitle: "Автоматы защиты двигателя",
      facets: [
        { caption: "Номинальный ток" },
        { caption: "Мощность двигателя" },
      ],
    },
  ];
  assertEquals(
    resolveHeadCategoryByFacetEvidence(
      "Найди автомат 1 полюсной, 16 А характеристика С",
      candidates,
    ),
    "Автоматические выключатели",
  );
  assertEquals(
    resolveHeadCategoryByFacetEvidence("Найди автомат 16 А", candidates),
    null,
  );
  assertEquals(
    resolveHeadCategoryByFacetEvidence("Найди автомат по номинальному току", [
      candidates[0],
      {
        ...candidates[1],
        facets: [{ caption: "Номинальный ток" }, {
          caption: "Номинальная мощность",
        }],
      },
    ]),
    null,
  );
});

Deno.test("ambiguous live heads use compact codes only when two live facet axes prove them", () => {
  const breakers = {
    pagetitle: "Автоматические выключатели",
    facets: [
      {
        key: "curve",
        caption: "Характеристика срабатывания",
        values: [{ value: "B" }, { value: "C" }],
      },
      {
        key: "current",
        caption: "Номинальный ток",
        values: [{ value: "10" }, { value: "16" }],
      },
      {
        key: "poles",
        caption: "Количество полюсов",
        values: [{ value: "1" }, { value: "3" }],
      },
    ],
  };
  const motorProtection = {
    pagetitle: "Автоматы защиты двигателя",
    facets: [
      {
        key: "current",
        caption: "Номинальный ток",
        values: [{ value: "10" }, { value: "16" }],
      },
      {
        key: "power",
        caption: "Мощность двигателя",
        values: [{ value: "4" }, { value: "7.5" }],
      },
    ],
  };
  assertEquals(
    resolveHeadCategoryByFacetEvidence(
      "Найди однополюсный автомат C16 не дороже 1 000 тенге",
      [breakers, motorProtection],
    ),
    "Автоматические выключатели",
  );
  assertEquals(
    resolveHeadCategoryByFacetEvidence(
      "Найди однополюсный автомат С16 не дороже 1 000 тенге",
      [breakers, motorProtection],
    ),
    "Автоматические выключатели",
  );
});

Deno.test("compact live-facet evidence remains fail-closed on ties and single-axis values", () => {
  const compactFacets = [
    { key: "curve", caption: "Характеристика", values: [{ value: "C" }] },
    { key: "current", caption: "Ток", values: [{ value: "16 А" }] },
  ];
  assertEquals(
    resolveHeadCategoryByFacetEvidence("автомат C16", [
      { pagetitle: "Первая категория", facets: compactFacets },
      { pagetitle: "Вторая категория", facets: compactFacets },
    ]),
    null,
  );
  assertEquals(
    resolveHeadCategoryByFacetEvidence("автомат C16", [
      {
        pagetitle: "Единственная категория",
        facets: [{
          key: "model",
          caption: "Модель",
          values: [{ value: "C16" }],
        }],
      },
      {
        pagetitle: "Другая категория",
        facets: [{ key: "current", caption: "Ток", values: [{ value: "16" }] }],
      },
    ]),
    null,
  );
});

Deno.test("a numeric compound disambiguates compact-code categories through live values", () => {
  const shared = [
    { key: "curve", caption: "Характеристика", values: [{ value: "C" }] },
    { key: "current", caption: "Номинальный ток", values: [{ value: "16" }] },
  ];
  assertEquals(
    resolveHeadCategoryByFacetEvidence("однополюсный автомат C16", [
      {
        pagetitle: "Общий аппарат",
        facets: [...shared, {
          key: "poles",
          caption: "Количество полюсов",
          values: [{ value: "1" }, { value: "3" }],
        }],
      },
      {
        pagetitle: "Другой аппарат",
        facets: [...shared, {
          key: "poles",
          caption: "Количество полюсов",
          values: [{ value: "2" }, { value: "4" }],
        }],
      },
    ]),
    "Общий аппарат",
  );
});

Deno.test("local live-taxonomy resolver does not translate jargon or invent a category", () => {
  assertEquals(
    resolveLocalCategoryPagetitles({
      noun: "кукуруза",
      semantic_query: "Есть лампы кукуруза?",
    }, LIVE_TITLES),
    [],
  );
  assertEquals(
    resolveLocalCategoryPagetitles({
      noun: "наклейка",
      semantic_query:
        "Нужна лампа, похожая на кукурузный початок, а не средство для наклеек",
    }, LIVE_TITLES),
    [],
  );
});

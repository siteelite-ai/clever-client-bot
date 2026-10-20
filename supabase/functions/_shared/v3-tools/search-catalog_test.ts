import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { executeSearchCatalog, isRestrictedCatalogProduct } from "./search-catalog.ts";
import type { ProductCache } from "./types.ts";

Deno.test("incomplete by-filter input exposes a structured recovery code", async () => {
  let fetched = false;
  const result = await executeSearchCatalog({
    mode: "by_filter",
    per_page: 50,
  }, {
    baseUrl: "https://catalog.test",
    apiToken: "test",
    fetchImpl: () => {
      fetched = true;
      return Promise.resolve(new Response("", { status: 500 }));
    },
  }, new Map());

  assertEquals(fetched, false);
  assertEquals(result.ok, false);
  if (result.ok) return;
  assertEquals(result.error_code, "incomplete_filter");
});

Deno.test("catalog visibility policy fails closed only when the stable flag is present", () => {
  assertEquals(isRestrictedCatalogProduct({ options: [] }), false);
  assertEquals(isRestrictedCatalogProduct({
    options: [{ key: "ogranichennyy_prosmotr", value_ru: "Нет", value_kz: "Жоқ" }],
  }), false);
  assertEquals(isRestrictedCatalogProduct({
    options: [{ key: "ogranichennyy_prosmotr", value_ru: "Да" }],
  }), true);
  assertEquals(isRestrictedCatalogProduct({
    options: [{ key: "ogranichennyy_prosmotr", value: true }],
  }), true);
  assertEquals(isRestrictedCatalogProduct({
    options: [{ key: "ogranichennyy_prosmotr", value_ru: "" }],
  }), true);
});

Deno.test("restricted catalog products never enter search results or the product cache", async () => {
  const product = (id: string, options: unknown[]) => ({
    id,
    pagetitle: `Product ${id}`,
    price: 100,
    url: `https://220volt.kz/catalog/test/products/${id}/`,
    options,
  });
  const fetchImpl: typeof fetch = () => Promise.resolve(new Response(JSON.stringify({
    data: {
      results: [
        product("public-explicit", [{ key: "ogranichennyy_prosmotr", value_ru: "Нет" }]),
        product("public-unmarked", []),
        product("restricted-yes", [{ key: "ogranichennyy_prosmotr", value_ru: "Да" }]),
        product("restricted-boolean", [{ key: "ogranichennyy_prosmotr", value: true }]),
        product("restricted-unknown", [{ key: "ogranichennyy_prosmotr", value_ru: "pending" }]),
      ],
      pagination: { total: 5 },
    },
  }), { status: 200, headers: { "content-type": "application/json" } }));
  const cache: ProductCache = new Map();

  const result = await executeSearchCatalog({
    mode: "by_query",
    query: "product",
    per_page: 10,
  }, {
    baseUrl: "https://catalog.test",
    apiToken: "test",
    fetchImpl,
  }, cache);

  assertEquals(result.ok, true);
  if (!result.ok) return;
  assertEquals(result.results.map((entry) => entry.id), ["public-explicit", "public-unmarked"]);
  assertEquals(result.candidate_coverage, "complete_query_window");
  assertEquals([...cache.keys()], ["public-explicit", "public-unmarked"]);
});

Deno.test("live facet keys stay in the internal cache without inflating tool results", async () => {
  const cache: ProductCache = new Map();
  const result = await executeSearchCatalog({
    mode: "by_query",
    query: "C16",
  }, {
    baseUrl: "https://catalog.test",
    apiToken: "test",
    fetchImpl: () => Promise.resolve(new Response(JSON.stringify({
      data: {
        results: [{
          id: "c16",
          pagetitle: "Автоматический выключатель C16",
          price: 900,
          url: "https://220volt.kz/catalog/electric/breakers/c16/",
          options: [{ key: "nominal_current", caption_ru: "Номинальный ток", value_ru: "16" }],
        }],
        pagination: { total: 1 },
      },
    }), { status: 200, headers: { "content-type": "application/json" } })),
  }, cache);

  assertEquals(result.ok, true);
  if (!result.ok) return;
  assertEquals("facet_values" in result.results[0], false);
  assertEquals("facet_captions" in result.results[0], false);
  assertEquals(cache.get("c16")?.facet_values, { nominal_current: ["16"] });
  assertEquals(cache.get("c16")?.facet_captions, { nominal_current: "Номинальный ток" });
});

Deno.test("catalog keeps only unambiguous key-to-human-caption pairs as internal display metadata", async () => {
  const cache: ProductCache = new Map();
  const result = await executeSearchCatalog({
    mode: "by_query",
    query: "светильник",
  }, {
    baseUrl: "https://catalog.test",
    apiToken: "test",
    fetchImpl: () => Promise.resolve(new Response(JSON.stringify({
      data: {
        results: [{
          id: "lamp",
          pagetitle: "Светильник",
          price: 900,
          url: "https://220volt.kz/catalog/light/fixtures/lamp/",
          options: [
            { key: "cvet_korpusa", caption_ru: "Цвет корпуса", value_ru: "белый" },
            { key: "cvet_korpusa", caption_ru: "Цвет корпуса", value_ru: "серый" },
            { key: "ambiguous", caption_ru: "Ширина", value_ru: "10" },
            { key: "ambiguous", caption_ru: "Высота", value_ru: "20" },
            { key: "missing_caption", value_ru: "7" },
            { key: "poiskovyy_zapros", caption_ru: "Поисковый запрос", value_ru: "лампа" },
          ],
        }],
        pagination: { total: 1 },
      },
    }), { status: 200, headers: { "content-type": "application/json" } })),
  }, cache);
  assertEquals(result.ok, true);
  if (!result.ok) return;
  assertEquals("facet_captions" in result.results[0], false);
  assertEquals(cache.get("lamp")?.facet_values?.cvet_korpusa, ["белый", "серый"]);
  assertEquals(cache.get("lamp")?.facet_captions, { cvet_korpusa: "Цвет корпуса" });
});

Deno.test("catalog cache distinguishes absent warehouse rows from explicit zero without changing public stock", async () => {
  const rows = [
    { id: "absent" },
    { id: "empty", warehouses: [] },
    { id: "zero", warehouses: [{ city: "Алматы", amount: 0 }] },
    { id: "positive", warehouses: [{ city: "Алматы", amount: 2 }] },
    { id: "unverified", warehouses: [{ city: "Алматы", amount: "unknown" }] },
  ].map((row) => ({
    pagetitle: `Светодиодная люстра ${row.id}`,
    price: 1000,
    url: `https://220volt.kz/catalog/test/products/${row.id}/`,
    ...row,
  }));
  const cache: ProductCache = new Map();
  const result = await executeSearchCatalog({
    mode: "by_query",
    query: "люстра",
  }, {
    baseUrl: "https://catalog.test",
    apiToken: "test",
    fetchImpl: () => Promise.resolve(new Response(JSON.stringify({
      data: { results: rows, pagination: { total: rows.length } },
    }), { status: 200, headers: { "content-type": "application/json" } })),
  }, cache);

  assertEquals(result.ok, true);
  if (!result.ok) return;
  assertEquals(result.results.map(({ stock }) => stock), [
    "in_stock", "in_stock", "in_stock", "low", "in_stock",
  ]);
  assertEquals(result.results.every((entry) => !("warehouse_evidence" in entry)), true);
  assertEquals(rows.map(({ id }) => cache.get(id)?.warehouse_evidence), [
    "missing", "missing", "explicit_zero", "positive", "unverified",
  ]);
});

Deno.test("catalog retries an equivalent compound spelling only after an empty result", async () => {
  const queries: string[] = [];
  const fetchImpl: typeof fetch = (input) => {
    const url = new URL(String(input));
    const query = url.searchParams.get("query") ?? "";
    queries.push(query);
    const results = query === "ВВГнг 2*1,5"
      ? [{
        id: "exact",
        pagetitle: "Кабель ВВГ нг 2*1,5",
        price: 315,
        url: "https://220volt.kz/catalog/cables/vvg/kabel-vvg-ng-2*1,5/",
        options: [],
      }]
      : [];
    return Promise.resolve(new Response(JSON.stringify({
      data: { results, pagination: { total: results.length } },
    }), { status: 200, headers: { "content-type": "application/json" } }));
  };
  const cache: ProductCache = new Map();

  const result = await executeSearchCatalog({
    mode: "by_query",
    query: "ВВГнг 2х1.5",
    per_page: 10,
  }, {
    baseUrl: "https://catalog.test",
    apiToken: "test",
    fetchImpl,
  }, cache);

  assertEquals(queries, ["ВВГнг 2х1.5", "ВВГнг 2*1,5"]);
  assertEquals(result.ok, true);
  if (!result.ok) return;
  assertEquals(result.results.map((product) => product.id), ["exact"]);
  assertEquals(result.warnings, ["compound_query_variant_retry"]);
});

Deno.test("catalog executes repeated live facet values as OR alternatives", async () => {
  const requestedValues: string[][] = [];
  const fetchImpl: typeof fetch = (input) => {
    const url = new URL(String(input));
    const values = url.searchParams.getAll("options[flow][]");
    requestedValues.push(values);
    const value = values.length === 1 ? values[0] : null;
    const results = value
      ? [{
          id: value,
          pagetitle: `Fixture ${value}`,
          price: 100,
          url: `https://220volt.kz/catalog/light/fixture/item-${value}/`,
          options: [],
        }]
      : [];
    return Promise.resolve(new Response(JSON.stringify({
      data: { results, pagination: { total: results.length } },
    }), { status: 200, headers: { "content-type": "application/json" } }));
  };
  const cache: ProductCache = new Map();

  const result = await executeSearchCatalog({
    mode: "by_filter",
    category: "Fixtures",
    options: { flow: ["4000", "5000"], mount: ["ceiling"] },
    per_page: 10,
  }, {
    baseUrl: "https://catalog.test",
    apiToken: "test",
    fetchImpl,
  }, cache);

  assertEquals(requestedValues, [["4000"], ["5000"]]);
  assertEquals(result.ok, true);
  if (!result.ok) return;
  assertEquals(result.results.map((product) => product.id), ["4000", "5000"]);
  assertEquals(result.results.map((product) => product.leaf_category), ["Fixtures", "Fixtures"]);
  assertEquals(result.candidate_coverage, "complete_query_window");
  assertEquals(result.warnings, ["option_alternatives_fanout:2"]);
});

Deno.test("catalog retries a rate-limited single request instead of returning a false empty", async () => {
  let calls = 0;
  const fetchImpl: typeof fetch = () => {
    calls += 1;
    if (calls === 1) return Promise.resolve(new Response("", { status: 429 }));
    return Promise.resolve(new Response(JSON.stringify({
      data: {
        results: [{
          id: "recovered",
          pagetitle: "Recovered product",
          price: 100,
          url: "https://220volt.kz/catalog/test/products/recovered/",
          options: [],
        }],
        pagination: { total: 1 },
      },
    }), { status: 200, headers: { "content-type": "application/json" } }));
  };

  const result = await executeSearchCatalog({
    mode: "by_query",
    query: "recovered",
  }, {
    baseUrl: "https://catalog.test",
    apiToken: "test",
    fetchImpl,
  }, new Map());

  assertEquals(calls, 2);
  assertEquals(result.ok, true);
  if (!result.ok) return;
  assertEquals(result.results.map((product) => product.id), ["recovered"]);
  assertEquals(result.warnings, ["rate_limit_retry_recovered"]);
});

for (const [status, expectedCode] of [
  [401, "transport_5xx"],
  [403, "transport_5xx"],
  [404, "transport_5xx"],
  [400, "bad_input"],
  [422, "bad_input"],
] as const) {
  Deno.test(`catalog HTTP ${status} is classified as ${expectedCode}`, async () => {
    const result = await executeSearchCatalog({ mode: "by_query", query: "socket" }, {
      baseUrl: "https://catalog.test",
      apiToken: "test",
      fetchImpl: () => Promise.resolve(new Response("", { status })),
    }, new Map());

    assertEquals(result.ok, false);
    if (!result.ok) assertEquals(result.error_code, expectedCode);
  });
}

for (const withVerifiedCard of [false, true]) {
  Deno.test(`catalog fan-out ${withVerifiedCard ? "keeps a verified card" : "reports auth outage"} when one leaf returns HTTP 403`, async () => {
    const result = await executeSearchCatalog({
      mode: "by_filter",
      category_in: ["Leaf A", "Leaf B"],
      per_page: 10,
    }, {
      baseUrl: "https://catalog.test",
      apiToken: "test",
      fetchImpl: (input) => {
        const leaf = new URL(String(input)).searchParams.get("category");
        if (leaf === "Leaf B") return Promise.resolve(new Response("", { status: 403 }));
        const results = withVerifiedCard
          ? [{
            id: "verified",
            pagetitle: "Двойная розетка",
            price: 500,
            url: "https://220volt.kz/catalog/electric/sockets/verified/",
            options: [],
          }]
          : [];
        return Promise.resolve(new Response(JSON.stringify({
          data: { results, pagination: { total: results.length } },
        }), { status: 200, headers: { "content-type": "application/json" } }));
      },
    }, new Map());

    if (withVerifiedCard) {
      assertEquals(result.ok, true);
      if (result.ok) {
        assertEquals(result.results.map((product) => product.id), ["verified"]);
        assertEquals(result.candidate_coverage, "partial");
      }
    } else {
      assertEquals(result.ok, false);
      if (!result.ok) assertEquals(result.error_code, "transport_5xx");
    }
  });
}

Deno.test("catalog materialization recovery does not turn an auth outage into a false empty", async () => {
  let calls = 0;
  const result = await executeSearchCatalog({ mode: "by_query", query: "socket" }, {
    baseUrl: "https://catalog.test",
    apiToken: "test",
    fetchImpl: () => {
      calls += 1;
      if (calls > 1) return Promise.resolve(new Response("", { status: 401 }));
      return Promise.resolve(new Response(JSON.stringify({
        data: {
          results: [{
            id: "unrenderable",
            pagetitle: "Archived socket",
            price: 0,
            url: "https://220volt.kz/catalog/electric/sockets/archived/",
            options: [],
          }],
          pagination: { total: 100 },
        },
      }), { status: 200, headers: { "content-type": "application/json" } }));
    },
  }, new Map());

  assertEquals(calls, 2);
  assertEquals(result.ok, false);
  if (!result.ok) assertEquals(result.error_code, "transport_5xx");
});

Deno.test("catalog price sort rejects incomplete pages despite a verified first-page card", async () => {
  const result = await executeSearchCatalog({
    mode: "by_query",
    query: "socket",
    sort_cheapest: true,
  }, {
    baseUrl: "https://catalog.test",
    apiToken: "test",
    fetchImpl: (input) => {
      const page = Number(new URL(String(input)).searchParams.get("page") ?? "1");
      if (page === 2) return Promise.resolve(new Response("", { status: 403 }));
      return Promise.resolve(new Response(JSON.stringify({
        data: {
          results: [{
            id: "verified",
            pagetitle: "Двойная розетка",
            price: 500,
            url: "https://220volt.kz/catalog/electric/sockets/verified/",
            options: [],
          }],
          pagination: { total: 100 },
        },
      }), { status: 200, headers: { "content-type": "application/json" } }));
    },
  }, new Map());

  assertEquals(result.ok, false);
  if (!result.ok) assertEquals(result.error_code, "transport_5xx");
});

Deno.test("catalog price sort rejects a partial leaf fan-out", async () => {
  const result = await executeSearchCatalog({
    mode: "by_filter",
    category_in: ["Leaf A", "Leaf B"],
    sort_cheapest: true,
  }, {
    baseUrl: "https://catalog.test",
    apiToken: "test",
    fetchImpl: (input) => {
      const leaf = new URL(String(input)).searchParams.get("category");
      if (leaf === "Leaf B") return Promise.resolve(new Response("", { status: 403 }));
      return Promise.resolve(new Response(JSON.stringify({
        data: {
          results: [{
            id: "verified",
            pagetitle: "Двойная розетка",
            price: 500,
            url: "https://220volt.kz/catalog/electric/sockets/verified/",
            options: [],
          }],
          pagination: { total: 1 },
        },
      }), { status: 200, headers: { "content-type": "application/json" } }));
    },
  }, new Map());

  assertEquals(result.ok, false);
  if (!result.ok) assertEquals(result.error_code, "transport_5xx");
});

Deno.test("an outer recovery deadline prevents further catalog retries", async () => {
  const controller = new AbortController();
  let calls = 0;
  const result = await executeSearchCatalog({
    mode: "by_query",
    query: "motion",
  }, {
    baseUrl: "https://catalog.test",
    apiToken: "test",
    signal: controller.signal,
    fetchImpl: (_input, init) => {
      calls += 1;
      assertEquals(init?.signal?.aborted, false);
      controller.abort();
      return Promise.resolve(new Response("", { status: 429 }));
    },
  }, new Map());

  assertEquals(calls, 1);
  assertEquals(result.ok, false);
  if (!result.ok) assertEquals(result.error_code, "catalog_timeout");
});

Deno.test("catalog materializes a bounded later-page window when upstream total has no usable first-page cards", async () => {
  const calls: Array<{ page: number; perPage: number }> = [];
  const fetchImpl: typeof fetch = (input) => {
    const url = new URL(String(input));
    const page = Number(url.searchParams.get("page") ?? "1");
    const perPage = Number(url.searchParams.get("per_page") ?? "10");
    calls.push({ page, perPage });
    const results = perPage === 50 && page === 2
      ? [{
          id: "usable-later",
          pagetitle: "Стабилизатор напряжения 5 кВА",
          price: 125000,
          url: "https://220volt.kz/catalog/power/stabilizers/usable-later/",
          options: [],
        }]
      : [{
          id: `archived-${page}-${perPage}`,
          pagetitle: "Архивная карточка",
          price: 0,
          url: "https://220volt.kz/catalog/power/stabilizers/archived/",
          options: [],
        }];
    return Promise.resolve(new Response(JSON.stringify({
      data: { results, pagination: { total: 130 } },
    }), { status: 200, headers: { "content-type": "application/json" } }));
  };

  const result = await executeSearchCatalog({
    mode: "by_filter",
    category: "Стабилизаторы",
    per_page: 10,
  }, {
    baseUrl: "https://catalog.test",
    apiToken: "test",
    fetchImpl,
  }, new Map());

  assertEquals(result.ok, true);
  if (!result.ok) return;
  assertEquals(result.total, 130);
  assertEquals(result.results.map((product) => product.id), ["usable-later"]);
  assertEquals(result.candidate_coverage, "partial");
  assertEquals(result.warnings, ["catalog_materialization_recovered:1/130"]);
  assertEquals(calls, [
    { page: 1, perPage: 10 },
    { page: 1, perPage: 50 },
    { page: 2, perPage: 50 },
  ]);
});

Deno.test("catalog exposes zero when a bounded raw pool cannot materialize any renderable card", async () => {
  const calls: Array<{ page: number; perPage: number }> = [];
  const fetchImpl: typeof fetch = (input) => {
    const url = new URL(String(input));
    calls.push({
      page: Number(url.searchParams.get("page") ?? "1"),
      perPage: Number(url.searchParams.get("per_page") ?? "10"),
    });
    return Promise.resolve(new Response(JSON.stringify({
      data: {
        results: [{
          id: "unsafe-link",
          pagetitle: "Карточка с неподконтрольной ссылкой",
          price: 100,
          url: "https://example.test/catalog/power/stabilizers/item/",
          options: [],
        }],
        pagination: { total: 130 },
      },
    }), { status: 200, headers: { "content-type": "application/json" } }));
  };

  const result = await executeSearchCatalog({
    mode: "by_filter",
    category: "Стабилизаторы",
  }, {
    baseUrl: "https://catalog.test",
    apiToken: "test",
    fetchImpl,
  }, new Map());

  assertEquals(result.ok, true);
  if (!result.ok) return;
  assertEquals(result.total, 0);
  assertEquals(result.results, []);
  assertEquals(result.candidate_coverage, "partial");
  assertEquals(result.warnings, ["catalog_unmaterialized_total:130"]);
  assertEquals(calls, [
    { page: 1, perPage: 10 },
    { page: 1, perPage: 50 },
    { page: 2, perPage: 50 },
    { page: 3, perPage: 50 },
  ]);
});

Deno.test("candidate coverage uses raw pagination, not locally filtered products", async () => {
  const raw = Array.from({ length: 10 }, (_, index) => ({
    id: `item-${index}`,
    pagetitle: `Светильник ${index}`,
    price: index === 0 ? 100 : 0,
    url: `https://220volt.kz/catalog/light/fixtures/item-${index}/`,
    options: [],
  }));
  const fetchImpl: typeof fetch = () => Promise.resolve(new Response(JSON.stringify({
    data: { results: raw, pagination: { total: 53 } },
  }), { status: 200, headers: { "content-type": "application/json" } }));
  const result = await executeSearchCatalog({
    mode: "by_query",
    query: "светильник",
    per_page: 10,
  }, { baseUrl: "https://catalog.test", apiToken: "test", fetchImpl }, new Map());
  assertEquals(result.ok, true);
  if (!result.ok) return;
  assertEquals(result.results.length, 1);
  assertEquals(result.total, 53);
  assertEquals(result.candidate_coverage, "partial");
});

Deno.test("candidate coverage is unknown when upstream pagination is absent", async () => {
  const result = await executeSearchCatalog({
    mode: "by_query",
    query: "розетка",
  }, {
    baseUrl: "https://catalog.test",
    apiToken: "test",
    fetchImpl: () => Promise.resolve(new Response(JSON.stringify({
      data: { results: [{
        id: "socket",
        pagetitle: "Розетка",
        price: 500,
        url: "https://220volt.kz/catalog/electric/sockets/socket/",
        options: [],
      }] },
    }), { status: 200, headers: { "content-type": "application/json" } })),
  }, new Map());
  assertEquals(result.ok, true);
  if (!result.ok) return;
  assertEquals(result.candidate_coverage, "unknown");
});

Deno.test("candidate coverage is unknown when upstream results are malformed", async () => {
  const result = await executeSearchCatalog({
    mode: "by_query",
    query: "розетка",
  }, {
    baseUrl: "https://catalog.test",
    apiToken: "test",
    fetchImpl: () => Promise.resolve(new Response(JSON.stringify({
      data: { results: null, pagination: { total: 0 } },
    }), { status: 200, headers: { "content-type": "application/json" } })),
  }, new Map());
  assertEquals(result.ok, true);
  if (!result.ok) return;
  assertEquals(result.candidate_coverage, "unknown");
});

Deno.test("oversized unexpanded OR facets cannot claim complete coverage across leaves", async () => {
  const options = Array.from({ length: 25 }, (_, index) => String(index + 1));
  const result = await executeSearchCatalog({
    mode: "by_filter",
    category_in: ["Leaf A", "Leaf B"],
    options: { power: options },
  }, {
    baseUrl: "https://catalog.test",
    apiToken: "test",
    fetchImpl: (input) => {
      const leaf = new URL(String(input)).searchParams.get("category") ?? "unknown";
      return Promise.resolve(new Response(JSON.stringify({
        data: { results: [{
          id: leaf,
          pagetitle: `Fixture ${leaf}`,
          price: 500,
          url: `https://220volt.kz/catalog/light/fixtures/item-${leaf.replaceAll(" ", "-")}/`,
          options: [],
        }], pagination: { total: 1 } },
      }), { status: 200, headers: { "content-type": "application/json" } }));
    },
  }, new Map());
  assertEquals(result.ok, true);
  if (!result.ok) return;
  assertEquals(result.results.length, 2);
  assertEquals(result.candidate_coverage, "unknown");
});

Deno.test("candidate coverage is partial after an early OR stop", async () => {
  const requested: string[] = [];
  const result = await executeSearchCatalog({
    mode: "by_filter",
    category: "Fixtures",
    options: { power: ["10", "20"] },
    per_page: 2,
  }, {
    baseUrl: "https://catalog.test",
    apiToken: "test",
    fetchImpl: (input) => {
      const value = new URL(String(input)).searchParams.get("options[power][]") ?? "";
      requested.push(value);
      const results = [1, 2].map((index) => ({
        id: `${value}-${index}`,
        pagetitle: `Fixture ${value}-${index}`,
        price: 100,
        url: `https://220volt.kz/catalog/light/fixtures/item-${value}-${index}/`,
        options: [],
      }));
      return Promise.resolve(new Response(JSON.stringify({
        data: { results, pagination: { total: results.length } },
      }), { status: 200, headers: { "content-type": "application/json" } }));
    },
  }, new Map());
  assertEquals(result.ok, true);
  if (!result.ok) return;
  assertEquals(requested, ["10"]);
  assertEquals(result.candidate_coverage, "partial");
});

Deno.test("sorted candidate coverage is separate from price-order coverage", async () => {
  const products = [30, 10, 20].map((price) => ({
    id: String(price),
    pagetitle: `Fixture ${price}`,
    price,
    url: `https://220volt.kz/catalog/light/fixtures/item-${price}/`,
    options: [],
  }));
  const fetchImpl: typeof fetch = () => Promise.resolve(new Response(JSON.stringify({
    data: { results: products, pagination: { total: products.length } },
  }), { status: 200, headers: { "content-type": "application/json" } }));
  const deps = { baseUrl: "https://catalog.test", apiToken: "test", fetchImpl };
  const shortWindow = await executeSearchCatalog({
    mode: "by_query", query: "fixture", sort_cheapest: true, per_page: 2,
  }, deps, new Map());
  assertEquals(shortWindow.ok, true);
  if (!shortWindow.ok) return;
  assertEquals(shortWindow.results.map((product) => product.price), [10, 20]);
  assertEquals(shortWindow.candidate_coverage, "partial");

  const fullWindow = await executeSearchCatalog({
    mode: "by_query", query: "fixture", sort_cheapest: true, per_page: 3,
  }, deps, new Map());
  assertEquals(fullWindow.ok, true);
  if (!fullWindow.ok) return;
  assertEquals(fullWindow.results.map((product) => product.price), [10, 20, 30]);
  assertEquals(fullWindow.candidate_coverage, "complete_query_window");
});

Deno.test("sort-truncated searches keep candidate coverage partial", async () => {
  const fetchImpl: typeof fetch = (input) => {
    const page = Number(new URL(String(input)).searchParams.get("page") ?? "1");
    const products = Array.from({ length: 50 }, (_, index) => {
      const id = (page - 1) * 50 + index + 1;
      return {
        id: String(id),
        pagetitle: `Fixture ${id}`,
        price: 1000 - id,
        url: `https://220volt.kz/catalog/light/fixtures/item-${id}/`,
        options: [],
      };
    });
    return Promise.resolve(new Response(JSON.stringify({
      data: { results: products, pagination: { total: 201 } },
    }), { status: 200, headers: { "content-type": "application/json" } }));
  };
  const result = await executeSearchCatalog({
    mode: "by_query", query: "fixture", sort_cheapest: true, per_page: 10,
  }, { baseUrl: "https://catalog.test", apiToken: "test", fetchImpl }, new Map());
  assertEquals(result.ok, true);
  if (!result.ok) return;
  assertEquals(result.results[0].price, 800);
  assertEquals(result.candidate_coverage, "partial");
  assertEquals(result.warnings, ["sort_truncated:201>200"]);
});

import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { executeSearchCatalog } from "./search-catalog.ts";
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
  assertEquals(result.warnings, ["catalog_unmaterialized_total:130"]);
  assertEquals(calls, [
    { page: 1, perPage: 10 },
    { page: 1, perPage: 50 },
    { page: 2, perPage: 50 },
    { page: 3, perPage: 50 },
  ]);
});

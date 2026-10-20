import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import type { Criterion } from "./criteria-gate.ts";
import { filterFinalCardsByMandatoryFacetEvidence } from "./final-card-facet-gate.ts";
import { setActiveCatalogFacetSchema } from "./catalog-facet-proof-ledger.ts";
import { executeSearchCatalog } from "./search-catalog.ts";
import type { ProductCache, ProductFull } from "./types.ts";

const facets = [{
  key: "item_kind",
  caption: "Вид изделия",
  values: [{ value: "силовой" }, { value: "сетевой" }],
}];
const kind: Criterion = {
  key: "Вид изделия",
  op: "eq",
  value: "силовой",
  evidence: "user_explicit",
  level: "A",
};

function url(id: string): string {
  return `https://220volt.kz/catalog/test/products/${id}/`;
}

function raw(id: string, productUrl = url(id), options: unknown[] = []) {
  return {
    id,
    pagetitle: `Изделие ${id}`,
    price: 100,
    url: productUrl,
    options,
  };
}

function response(products: unknown[], status = 200): Response {
  return new Response(
    JSON.stringify({
      data: { results: products, pagination: { total: products.length } },
    }),
    { status, headers: { "content-type": "application/json" } },
  );
}

const deps = (fetchImpl: typeof fetch) => ({
  baseUrl: "https://catalog.test",
  apiToken: "test",
  fetchImpl,
});

function boundCache(schema = facets): ProductCache {
  const cache: ProductCache = new Map();
  setActiveCatalogFacetSchema(cache, schema);
  return cache;
}

function final(cache: ProductCache, ids: string[], criteria = [kind]) {
  return filterFinalCardsByMandatoryFacetEvidence(
    ids.map((id) => cache.get(id)).filter((p): p is ProductFull => Boolean(p)),
    criteria,
    facets,
    cache,
  );
}

Deno.test("A exact filter cannot confer proof on B introduced by broad recovery", async () => {
  const cache = boundCache();
  const fetchImpl: typeof fetch = (input) => {
    const search = new URL(String(input)).searchParams;
    return Promise.resolve(
      response(search.has("options[item_kind][]") ? [raw("A")] : [raw("B")]),
    );
  };
  await executeSearchCatalog(
    {
      mode: "by_filter",
      options: { item_kind: ["силовой"] },
    },
    deps(fetchImpl),
    cache,
  );
  await executeSearchCatalog(
    {
      mode: "by_query",
      query: "изделие",
    },
    deps(fetchImpl),
    cache,
  );
  assertEquals(final(cache, ["A", "B"]).products.map((p) => p.id), ["A"]);
  assertEquals(final(cache, ["B"]).rejected[0]?.source, "missing_proof");
});

Deno.test("each executed OR branch gives only its own returned SKU an exact receipt", async () => {
  const cache = boundCache();
  const fetchImpl: typeof fetch = (input) => {
    const value = new URL(String(input)).searchParams.get(
      "options[item_kind][]",
    );
    return Promise.resolve(response(value ? [raw(value)] : []));
  };
  const result = await executeSearchCatalog(
    {
      mode: "by_filter",
      options: { item_kind: ["силовой", "сетевой"] },
      per_page: 10,
    },
    deps(fetchImpl),
    cache,
  );
  assertEquals(result.ok, true);
  if (!result.ok) return;
  const allowed = [kind, { ...kind, value: "сетевой" }];
  assertEquals(
    final(cache, ["силовой", "сетевой"], allowed).products.map((p) => p.id),
    ["силовой", "сетевой"],
  );
  assertEquals(final(cache, ["сетевой"]).products, []);
  assertEquals(JSON.stringify(result.results).includes("proof"), false);
  assertEquals(
    JSON.stringify(result.results).includes("https://220volt.kz"),
    false,
  );
});

Deno.test("early OR stop cannot grant an unexecuted alternative a receipt", async () => {
  const cache = boundCache();
  const executed: string[] = [];
  const fetchImpl: typeof fetch = (input) => {
    const value =
      new URL(String(input)).searchParams.get("options[item_kind][]") ?? "";
    executed.push(value);
    return Promise.resolve(response([raw(value || "unfiltered")]));
  };
  await executeSearchCatalog(
    {
      mode: "by_filter",
      options: { item_kind: ["силовой", "сетевой"] },
      per_page: 1,
    },
    deps(fetchImpl),
    cache,
  );
  assertEquals(executed, ["силовой"]);
  cache.set("B", {
    id: "B",
    pagetitle: "Изделие B",
    price: 100,
    vendor: null,
    stock: "in_stock",
    short_traits: [],
    url: url("B"),
  });
  assertEquals(final(cache, ["силовой", "B"]).products.map((p) => p.id), [
    "силовой",
  ]);
});

Deno.test("a failed OR branch cannot grant proof through a successful sibling", async () => {
  const cache = boundCache();
  const fetchImpl: typeof fetch = (input) => {
    const value = new URL(String(input)).searchParams.get(
      "options[item_kind][]",
    );
    return Promise.resolve(
      value === "силовой"
        ? response([raw("A")])
        : new Response("failure", { status: 500 }),
    );
  };
  const result = await executeSearchCatalog(
    {
      mode: "by_filter",
      options: { item_kind: ["силовой", "сетевой"] },
      per_page: 10,
    },
    deps(fetchImpl),
    cache,
  );
  assertEquals(result.ok, true);
  cache.set("B", {
    id: "B",
    pagetitle: "Изделие B",
    price: 100,
    vendor: null,
    stock: "in_stock",
    short_traits: [],
    url: url("B"),
  });
  assertEquals(
    final(cache, ["A", "B"], [kind, { ...kind, value: "сетевой" }])
      .products.map((p) => p.id),
    ["A"],
  );
});

Deno.test("failed, category-only, and by_query searches never create facet receipts", async () => {
  const cache = boundCache();
  const okFetch: typeof fetch = () => Promise.resolve(response([raw("A")]));
  const badFetch: typeof fetch = () =>
    Promise.resolve(new Response("failure", { status: 500 }));
  const failed = await executeSearchCatalog(
    {
      mode: "by_filter",
      options: { item_kind: ["силовой"] },
    },
    deps(badFetch),
    cache,
  );
  assertEquals(failed.ok, false);
  cache.set("A", {
    id: "A",
    pagetitle: "Изделие A",
    price: 100,
    vendor: null,
    stock: "in_stock",
    short_traits: [],
    url: url("A"),
  });
  assertEquals(final(cache, ["A"]).products, []);
  await executeSearchCatalog(
    {
      mode: "by_filter",
      category: "products",
    },
    deps(okFetch),
    cache,
  );
  assertEquals(final(cache, ["A"]).products, []);
  await executeSearchCatalog(
    {
      mode: "by_query",
      query: "изделие",
    },
    deps(okFetch),
    cache,
  );
  assertEquals(final(cache, ["A"]).products, []);
});

Deno.test("failed sorted pagination cannot preserve a first-page filter receipt", async () => {
  const cache = boundCache();
  const fetchImpl: typeof fetch = (input) => {
    const page = Number(new URL(String(input)).searchParams.get("page") ?? "1");
    return Promise.resolve(
      page === 1
        ? new Response(
          JSON.stringify({
            data: { results: [raw("A")], pagination: { total: 60 } },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        )
        : new Response("failure", { status: 500 }),
    );
  };
  const result = await executeSearchCatalog(
    {
      mode: "by_filter",
      options: { item_kind: ["силовой"] },
      sort_cheapest: true,
    },
    deps(fetchImpl),
    cache,
  );
  assertEquals(result.ok, false);
  assertEquals(final(cache, ["A"]).products, []);
});

Deno.test("same SKU and URL keeps prior proof through sparse overwrite but contradiction wins", async () => {
  const cache = boundCache();
  const exactFetch: typeof fetch = () => Promise.resolve(response([raw("A")]));
  const filter = {
    mode: "by_filter" as const,
    options: { item_kind: ["силовой"] },
  };
  await executeSearchCatalog(filter, deps(exactFetch), cache);
  await executeSearchCatalog(
    { mode: "by_query", query: "A" },
    deps(exactFetch),
    cache,
  );
  assertEquals(final(cache, ["A"]).products.map((p) => p.id), ["A"]);

  const contradictingFetch: typeof fetch = () =>
    Promise.resolve(response([
      raw("A", url("A"), [{
        key: "item_kind",
        caption_ru: "Вид изделия",
        value_ru: "сетевой",
      }]),
    ]));
  await executeSearchCatalog(
    { mode: "by_query", query: "A" },
    deps(contradictingFetch),
    cache,
  );
  assertEquals(final(cache, ["A"]).products, []);
  assertEquals(final(cache, ["A"]).rejected[0]?.source, "catalog_facet");
});

Deno.test("SKU/URL identity changes and a new turn cannot inherit old filter proof", async () => {
  const cache = boundCache();
  await executeSearchCatalog(
    {
      mode: "by_filter",
      options: { item_kind: ["силовой"] },
    },
    deps(() => Promise.resolve(response([raw("A")]))),
    cache,
  );
  await executeSearchCatalog(
    { mode: "by_query", query: "A" },
    deps(() =>
      Promise.resolve(response([
        raw("A", url("new-url")),
        raw("B", url("A")),
      ]))
    ),
    cache,
  );
  assertEquals(final(cache, ["A", "B"]).products, []);

  const nextTurn: ProductCache = new Map([["A", {
    id: "A",
    pagetitle: "Изделие A",
    price: 100,
    vendor: null,
    stock: "in_stock",
    short_traits: [],
    url: url("A"),
  }]]);
  assertEquals(final(nextTurn, ["A"]).products, []);
});

Deno.test("one exact value cannot prove a different mandatory value; approved removal is explicit", async () => {
  const cache = boundCache();
  await executeSearchCatalog(
    {
      mode: "by_filter",
      options: { item_kind: ["силовой"] },
    },
    deps(() => Promise.resolve(response([raw("A")]))),
    cache,
  );
  assertEquals(
    final(cache, ["A"], [{ ...kind, value: "сетевой" }]).products,
    [],
  );
  // Once an approved relaxation has removed the requirement from the frozen
  // selection contract, this generic egress gate has nothing to enforce.
  assertEquals(final(cache, ["A"], []).products.map((p) => p.id), ["A"]);
});

Deno.test("receipt keeps its execution schema when later discovery changes or clears", async () => {
  const cache = boundCache();
  await executeSearchCatalog(
    {
      mode: "by_filter",
      options: { item_kind: ["силовой"] },
    },
    deps(() => Promise.resolve(response([raw("A")]))),
    cache,
  );
  const ambiguous = [...facets, {
    key: "another_kind",
    caption: "Вид изделия",
    values: [{ value: "силовой" }],
  }];
  setActiveCatalogFacetSchema(cache, ambiguous);
  assertEquals(
    filterFinalCardsByMandatoryFacetEvidence(
      [cache.get("A")!],
      [kind],
      ambiguous,
      cache,
    ).products.map((product) => product.id),
    ["A"],
  );
  setActiveCatalogFacetSchema(cache, []);
  assertEquals(
    filterFinalCardsByMandatoryFacetEvidence(
      [cache.get("A")!],
      [kind],
      [],
      cache,
    ).products.map((product) => product.id),
    ["A"],
  );
});

Deno.test("an in-flight filter captures its schema before a later discovery", async () => {
  const cache = boundCache();
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  const fetchImpl: typeof fetch = async () => {
    await pending;
    return response([raw("A")]);
  };
  const search = executeSearchCatalog(
    {
      mode: "by_filter",
      options: { item_kind: ["силовой"] },
    },
    deps(fetchImpl),
    cache,
  );
  setActiveCatalogFacetSchema(cache, [{
    key: "other_kind",
    caption: "Другой вид",
    values: [{ value: "другой" }],
  }]);
  release();
  assertEquals((await search).ok, true);
  assertEquals(final(cache, ["A"]).products.map((product) => product.id), [
    "A",
  ]);
});

Deno.test("ambiguous executed captions and oversized unexpanded OR do not grant proof", async () => {
  const ambiguous = [...facets, {
    key: "another_kind",
    caption: "Вид изделия",
    values: [{ value: "силовой" }],
  }];
  const cache = boundCache(ambiguous);
  await executeSearchCatalog(
    {
      mode: "by_filter",
      options: { item_kind: ["силовой"] },
    },
    deps(() => Promise.resolve(response([raw("A")]))),
    cache,
  );
  assertEquals(
    filterFinalCardsByMandatoryFacetEvidence(
      [cache.get("A")!],
      [kind],
      ambiguous,
      cache,
    ).products,
    [],
  );

  const aggregateCache = boundCache();
  await executeSearchCatalog(
    {
      mode: "by_filter",
      options: {
        item_kind: Array.from(
          { length: 25 },
          (_, index) => index === 0 ? "силовой" : `variant-${index}`,
        ),
      },
    },
    deps(() => Promise.resolve(response([raw("A")]))),
    aggregateCache,
  );
  assertEquals(final(aggregateCache, ["A"]).products, []);
});

Deno.test("ignored unknown option and unsupported live value never prove sparse cards", async () => {
  const cache = boundCache();
  const broadFetch: typeof fetch = () => Promise.resolve(response([raw("A")]));
  await executeSearchCatalog(
    {
      mode: "by_filter",
      options: { ignored_option: ["силовой"] },
    },
    deps(broadFetch),
    cache,
  );
  assertEquals(final(cache, ["A"]).products, []);
  await executeSearchCatalog(
    {
      mode: "by_filter",
      options: { item_kind: ["unsupported_value"] },
    },
    deps(broadFetch),
    cache,
  );
  assertEquals(final(cache, ["A"]).products, []);
});

Deno.test("numeric filter proof uses numeric equality, not substring matching", async () => {
  const cache = boundCache([{
    key: "nominal_current",
    caption: "Номинальный ток",
    values: [{ value: "16" }, { value: "160" }],
  }]);
  await executeSearchCatalog(
    {
      mode: "by_filter",
      options: { nominal_current: ["16"] },
    },
    deps(() => Promise.resolve(response([raw("A")]))),
    cache,
  );
  const live = [{ key: "nominal_current", caption: "Номинальный ток" }];
  const current: Criterion = {
    key: "Номинальный ток",
    op: "eq",
    value: "16",
    unit: "A",
    evidence: "user_explicit",
    level: "A",
  };
  assertEquals(
    filterFinalCardsByMandatoryFacetEvidence(
      [cache.get("A")!],
      [current],
      live,
      cache,
    ).products.map((p) => p.id),
    ["A"],
  );
  assertEquals(
    filterFinalCardsByMandatoryFacetEvidence(
      [cache.get("A")!],
      [{ ...current, value: "160" }],
      live,
      cache,
    ).products,
    [],
  );
});

import {
  assert,
  assertEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  CATALOG_QA_SECRET_ENV,
  CATALOG_QA_SECRET_HEADER,
  classifyCatalogHealthHttpStatus,
  isExactCatalogHealthPreflightPayload,
  runCatalogHealthPreflight,
} from "./catalog-health-preflight.ts";

const BASE = "https://fixture.catalog.invalid/api";
const HEALTHY_PRODUCT = {
  id: 1,
  article: "FIX-1",
  pagetitle: "Fixture product",
  price: 100,
  url: "https://220volt.kz/catalog/test/fixtures/product/",
  category: { id: 7, pagetitle: "Live leaf & parts" },
};
const HEALTHY_CATEGORIES = [{
  id: 1,
  pagetitle: "Root",
  children: [{ id: 7, pagetitle: "Live leaf & parts", children: [] }],
}];
const HEALTHY_FACETS = {
  data: {
    category: { id: 7, pagetitle: "Live leaf & parts", total_products: 1 },
    options: [{ key: "color", caption_ru: "Color", values: [{ value_ru: "white", products_count: 1 }] }],
  },
};

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function productPage(products: unknown[]): Response {
  return json({ data: { results: products, pagination: {
    page: 1, per_page: 50, pages: 1, total: products.length,
  } } });
}

function categoryPage(categories: unknown[]): Response {
  return json({ data: { results: categories, pagination: {
    page: 1, per_page: 200, pages: 1, total: categories.length,
  } } });
}

function pagedCategories(
  categories: unknown[],
  page: number,
  pagination: Record<string, unknown> = {},
): Response {
  return json({ data: { results: categories, pagination: {
    page, per_page: 1, pages: 2, total: 2, ...pagination,
  } } });
}

async function checkCategoryPages(
  pageResponse: (page: number) => Response | Promise<Response>,
  timeoutMs?: number,
) {
  const pageCalls: number[] = [];
  let dependentCalls = 0;
  const result = await runCatalogHealthPreflight({
    baseUrl: BASE, apiToken: "fixture-private-token", timeoutMs,
    fetchImpl: (async (input) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/categories")) {
        const page = Number(url.searchParams.get("page"));
        pageCalls.push(page);
        return await pageResponse(page);
      }
      if (url.pathname.endsWith("/products")) {
        if (!url.searchParams.has("article")) {
          return productPage([HEALTHY_PRODUCT]);
        }
        dependentCalls++;
        return productPage([HEALTHY_PRODUCT]);
      }
      dependentCalls++;
      return json(HEALTHY_FACETS);
    }) as typeof fetch,
  });
  return { result, pageCalls, dependentCalls };
}

Deno.test("catalog QA payload and header are separate from browser chat", () => {
  assertEquals(CATALOG_QA_SECRET_ENV, "VOLT220_V3_CATALOG_QA_SECRET");
  assertEquals(CATALOG_QA_SECRET_HEADER, "x-catalog-qa-secret");
  assertEquals(
    isExactCatalogHealthPreflightPayload({ type: "catalog_health_preflight" }),
    true,
  );
  for (
    const payload of [
      {},
      null,
      "catalog_health_preflight",
      { type: "catalog_health_preflight", message: "hello" },
      { type: "other" },
    ]
  ) {
    assertEquals(isExactCatalogHealthPreflightPayload(payload), false);
  }
});

Deno.test("catalog QA classifies upstream statuses without exposing response bodies", () => {
  for (
    const [status, expected] of [
      [401, "auth"],
      [403, "auth"],
      [404, "route"],
      [405, "route"],
      [429, "rate_limit"],
      [500, "upstream"],
      [502, "upstream"],
    ] as const
  ) {
    assertEquals(classifyCatalogHealthHttpStatus(status), expected);
  }
});

Deno.test("catalog QA validates a live product leaf before the authenticated facets route", async () => {
  const requests: Array<{ url: URL; auth: string | null; redirect: RequestRedirect }> = [];
  const result = await runCatalogHealthPreflight({
    baseUrl: BASE,
    apiToken: "fixture-private-token",
    fetchImpl: (async (input, init) => {
      const req = new Request(input, init);
      const url = new URL(req.url);
      requests.push({ url, auth: req.headers.get("authorization"), redirect: req.redirect });
      if (url.pathname.endsWith("/categories")) {
        return categoryPage(HEALTHY_CATEGORIES);
      }
      if (url.pathname.endsWith("/products")) {
        return productPage([HEALTHY_PRODUCT]);
      }
      if (url.pathname.endsWith("/categories/options")) {
        return json(HEALTHY_FACETS);
      }
      throw new Error(`unexpected path ${url.pathname}`);
    }) as typeof fetch,
  });
  assertEquals(result, {
    ok: true,
    status: "ready",
    checks: {
      categories: { status: "ok", http_status: 200 },
      products: { status: "ok", http_status: 200 },
      facets: { status: "ok", http_status: 200 },
      article_filter: { status: "ok", http_status: 200 },
    },
  });
  assertEquals(requests.length, 4);
  const categories = requests.find(({ url }) =>
    url.pathname.endsWith("/categories")
  );
  const products = requests.find(({ url }) =>
    url.pathname.endsWith("/products") && !url.searchParams.has("article")
  );
  const article = requests.find(({ url }) =>
    url.pathname.endsWith("/products") && url.searchParams.has("article")
  );
  const facets = requests.find(({ url }) =>
    url.pathname.endsWith("/categories/options")
  );
  assert(categories && products && facets && article);
  assertEquals(categories.url.origin, "https://fixture.catalog.invalid");
  assertEquals(
    categories.url.searchParams.toString(),
    "parent=0&depth=10&per_page=200&page=1",
  );
  assertEquals(
    products.url.searchParams.toString(),
    "per_page=20&page=1&min_price=1",
  );
  assertEquals(categories.auth, "Bearer fixture-private-token");
  assertEquals(products.auth, "Bearer fixture-private-token");
  assertEquals(article.auth, "Bearer fixture-private-token");
  assertEquals(article.redirect, "error");
  assertEquals(article.url.searchParams.toString(), "article=FIX-1&per_page=50&page=1");
  assertEquals(facets.auth, "Bearer fixture-private-token");
  assertEquals(facets.redirect, "error");
  assertEquals(facets.url.searchParams.get("pagetitle"), "Live leaf & parts");
  assertEquals(facets.url.search, "?pagetitle=Live+leaf+%26+parts");
});

Deno.test("catalog QA prefers a usable product's exact live leaf over unrelated taxonomy order", async () => {
  const categories = [{ id: 1, pagetitle: "Root", children: [
    { id: 7, pagetitle: "Product leaf", children: [] },
    { id: 8, pagetitle: "Unrelated leaf", children: [] },
  ] }];
  const product = {
    ...HEALTHY_PRODUCT,
    category: { id: 7, pagetitle: "Product leaf" },
  };
  let requestedLeaf: string | null = null;
  const result = await runCatalogHealthPreflight({
    baseUrl: BASE, apiToken: "fixture-private-token",
    fetchImpl: (async (input) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/categories")) {
        return categoryPage(categories);
      }
      if (url.pathname.endsWith("/products")) {
        return productPage([product]);
      }
      requestedLeaf = url.searchParams.get("pagetitle");
      return json({ data: {
        category: { id: 7, pagetitle: "Product leaf", total_products: 1 },
        options: [],
      } });
    }) as typeof fetch,
  });
  assertEquals(requestedLeaf, "Product leaf");
  assertEquals(result.ok, true);
  assert(!JSON.stringify(result).includes("Product leaf"));
});

Deno.test("catalog QA retains independent results and never mistakes 500 for empty stock", async () => {
  const result = await runCatalogHealthPreflight({
    baseUrl: BASE,
    apiToken: "fixture-private-token",
    fetchImpl: (async (input) =>
      new URL(String(input)).pathname.endsWith("/categories")
        ? json({ private_error: "do not expose this body" }, 500)
        : json({ data: { results: [HEALTHY_PRODUCT] } })) as typeof fetch,
  });
  assertEquals(result.ok, false);
  assertEquals(result.status, "unavailable");
  assertEquals(result.classification, "upstream");
  assertEquals(result.checks.categories, {
    status: "unavailable",
    http_status: 500,
    classification: "upstream",
  });
  assertEquals(result.checks.products, { status: "ok", http_status: 200 });
  assertEquals(result.checks.facets, undefined);
  assert(!JSON.stringify(result).includes("private_error"));
  assert(!JSON.stringify(result).includes("fixture-private-token"));
});

Deno.test("catalog QA fails closed on malformed or empty adapter response", async () => {
  for (
    const body of [
      { data: { results: [] } },
      { data: { results: "not-an-array" } },
      { data: { results: [null] } },
    ]
  ) {
    const result = await runCatalogHealthPreflight({
      baseUrl: BASE,
      apiToken: "fixture-private-token",
      fetchImpl: (async (input) =>
        new URL(String(input)).pathname.endsWith("/categories")
          ? json(body)
          : json({ data: { results: [HEALTHY_PRODUCT] } })) as typeof fetch,
    });
    assertEquals(result.ok, false);
    assertEquals(result.classification, "schema_error");
  }

  const malformedProducts = await runCatalogHealthPreflight({
    baseUrl: BASE,
    apiToken: "fixture-private-token",
    fetchImpl: (async (input) =>
      new URL(String(input)).pathname.endsWith("/categories")
        ? json({ results: [{ id: 1, pagetitle: "Root" }] })
        : json({ results: [] })) as typeof fetch,
  });
  assertEquals(malformedProducts.ok, false);
  assertEquals(malformedProducts.classification, "schema_error");
});

Deno.test("catalog QA does not mistake one category page for the full taxonomy", async () => {
  const pagination = { page: 1, per_page: 200, pages: 1, total: 1 };
  const cases = [
    { data: { results: HEALTHY_CATEGORIES } },
    { data: { results: HEALTHY_CATEGORIES, pagination: { ...pagination, pages: 2, total: 2 } } },
    { data: { results: HEALTHY_CATEGORIES, pagination: { ...pagination, page: 2 } } },
    { data: { results: HEALTHY_CATEGORIES, pagination: { ...pagination, per_page: 0 } } },
    { data: { results: HEALTHY_CATEGORIES, pagination: { ...pagination, per_page: "200" } } },
    { data: { results: HEALTHY_CATEGORIES, pagination: { ...pagination, total: 2 } } },
    { data: { results: HEALTHY_CATEGORIES, pagination: { ...pagination, pages: undefined } } },
    { success: false, data: { results: HEALTHY_CATEGORIES, pagination } },
  ];
  for (const body of cases) {
    const calls: string[] = [];
    const result = await runCatalogHealthPreflight({
      baseUrl: BASE, apiToken: "fixture-private-token",
      fetchImpl: (async (input) => {
        const url = new URL(String(input));
        calls.push(url.pathname);
        if (url.pathname.endsWith("/categories")) return json(body);
        if (url.pathname.endsWith("/products")) return productPage([HEALTHY_PRODUCT]);
        throw new Error("dependent route should not be called");
      }) as typeof fetch,
    });
    assertEquals(result.ok, false);
    assertEquals(result.classification, "schema_error");
    assertEquals(result.checks.categories, {
      status: "unavailable", http_status: 200, classification: "schema_error",
    });
    assertEquals(calls, ["/api/categories", "/api/products"]);
  }
});

Deno.test("catalog QA reads every taxonomy page before choosing a live product leaf", async () => {
  const { result, pageCalls, dependentCalls } = await checkCategoryPages((page) =>
    page === 1
      ? pagedCategories([{ id: 8, pagetitle: "Earlier root", children: [] }], 1)
      : pagedCategories(HEALTHY_CATEGORIES, 2)
  );
  assertEquals(pageCalls, [1, 2]);
  assertEquals(dependentCalls, 2);
  assertEquals(result.status, "ready");
  assertEquals(result.checks.categories, { status: "ok", http_status: 200 });
  assert(!JSON.stringify(result).includes("Earlier root"));
});

Deno.test("catalog QA accepts an exact shorter final taxonomy page", async () => {
  const { result, pageCalls, dependentCalls } = await checkCategoryPages((page) =>
    page === 1
      ? pagedCategories([
        { id: 8, pagetitle: "Earlier root", children: [] },
        { id: 9, pagetitle: "Another root", children: [] },
      ], 1, { per_page: 2, pages: 2, total: 3 })
      : pagedCategories(HEALTHY_CATEGORIES, 2, {
        per_page: 2, pages: 2, total: 3,
      })
  );
  assertEquals(pageCalls, [1, 2]);
  assertEquals(dependentCalls, 2);
  assertEquals(result.status, "ready");
});

Deno.test("catalog QA rejects missing, contradictory, or invalid later taxonomy pages", async () => {
  const first = pagedCategories([{ id: 8, pagetitle: "Earlier root", children: [] }], 1);
  for (const second of [
    pagedCategories([], 2),
    pagedCategories(HEALTHY_CATEGORIES, 1),
    pagedCategories(HEALTHY_CATEGORIES, 2, { pages: 3 }),
    pagedCategories(HEALTHY_CATEGORIES, 2, { total: 3 }),
    pagedCategories(HEALTHY_CATEGORIES, 2, { per_page: 2 }),
    pagedCategories(HEALTHY_CATEGORIES, 2, { pages: 3, total: 3 }),
    pagedCategories(HEALTHY_CATEGORIES, 2, { per_page: 2, total: 3 }),
    pagedCategories([{ id: 8, pagetitle: "Duplicate root", children: [] }], 2),
    pagedCategories([{ id: 1, pagetitle: "Root", children: [{ id: 7, pagetitle: "Leaf" }] }], 2),
    json({ data: { results: HEALTHY_CATEGORIES } }),
  ]) {
    const { result, pageCalls, dependentCalls } = await checkCategoryPages((page) =>
      page === 1 ? first.clone() : second.clone()
    );
    assertEquals(pageCalls, [1, 2]);
    assertEquals(dependentCalls, 0);
    assertEquals(result.status, "unavailable");
    assertEquals(result.classification, "schema_error");
    assertEquals(result.checks.categories.http_status, 200);
  }
  const missing = await checkCategoryPages((page) =>
    page === 1 ? first.clone() : json({ private_error: "do not return" }, 404)
  );
  assertEquals(missing.pageCalls, [1, 2]);
  assertEquals(missing.dependentCalls, 0);
  assertEquals(missing.result.classification, "route");
  assertEquals(missing.result.checks.categories.http_status, 404);
  assert(!JSON.stringify(missing.result).includes("private_error"));
  const shortFirst = await checkCategoryPages(() => pagedCategories([], 1));
  assertEquals(shortFirst.pageCalls, [1]);
  assertEquals(shortFirst.dependentCalls, 0);
  assertEquals(shortFirst.result.classification, "schema_error");
});

Deno.test("catalog QA rejects a reported taxonomy larger than the page or node cap", async () => {
  for (const pagination of [
    { page: 1, per_page: 1, pages: 65, total: 65 },
    { page: 1, per_page: 200, pages: 61, total: 12_001 },
  ]) {
    const { result, pageCalls, dependentCalls } = await checkCategoryPages(() =>
      json({ data: { results: [{ id: 8, pagetitle: "Root", children: [] }], pagination } })
    );
    assertEquals(pageCalls, [1]);
    assertEquals(dependentCalls, 0);
    assertEquals(result.classification, "schema_error");
  }
  const oversizedChildren = Array.from({ length: 12_000 }, (_, index) => ({
    id: index + 2, pagetitle: `Leaf ${index}`, children: [],
  }));
  const oversized = await checkCategoryPages(() =>
    categoryPage([{ id: 1, pagetitle: "Root", children: oversizedChildren }])
  );
  assertEquals(oversized.pageCalls, [1]);
  assertEquals(oversized.dependentCalls, 0);
  assertEquals(oversized.result.classification, "schema_error");
});

Deno.test("catalog QA bounds the whole category crawl when a later page stalls", async () => {
  const first = pagedCategories([{ id: 8, pagetitle: "Earlier root", children: [] }], 1);
  const { result, pageCalls, dependentCalls } = await checkCategoryPages((page) =>
    page === 1 ? first.clone() : new Promise<Response>(() => {}),
  10);
  assertEquals(pageCalls, [1, 2]);
  assertEquals(dependentCalls, 0);
  assertEquals(result.classification, "transport");
  assertEquals(result.checks.categories.http_status, null);
});

Deno.test("catalog QA classifies bounded transport failure", async () => {
  const result = await runCatalogHealthPreflight({
    baseUrl: BASE,
    apiToken: "fixture-private-token",
    timeoutMs: 10,
    fetchImpl: (async () =>
      await new Promise<Response>(() => {})) as typeof fetch,
  });
  assertEquals(result.ok, false);
  assertEquals(result.classification, "transport");
  assertEquals(result.checks.categories.http_status, null);
  assertEquals(result.checks.products.http_status, null);
});

Deno.test("catalog QA treats facets 503 as infrastructure outage, without disclosing body or title", async () => {
  const requests: string[] = [];
  const result = await runCatalogHealthPreflight({
    baseUrl: BASE,
    apiToken: "fixture-private-token",
    fetchImpl: (async (input) => {
      const url = new URL(String(input));
      requests.push(url.pathname);
      if (url.pathname.endsWith("/categories")) {
        return categoryPage(HEALTHY_CATEGORIES);
      }
      if (url.pathname.endsWith("/products")) {
        return productPage([HEALTHY_PRODUCT]);
      }
      return json({ private_detail: "secret-category-and-token" }, 503);
    }) as typeof fetch,
  });
  assertEquals(result.ok, false);
  assertEquals(result.status, "unavailable");
  assertEquals(result.classification, "upstream");
  assertEquals(result.checks.facets, {
    status: "unavailable", http_status: 503, classification: "upstream",
  });
  assertEquals(requests, ["/api/categories", "/api/products", "/api/categories/options", "/api/products"]);
  const serialized = JSON.stringify(result);
  for (const value of ["secret-category", "Live leaf", "fixture-private-token"]) {
    assert(!serialized.includes(value));
  }
});

Deno.test("catalog QA rejects malformed or wrong-leaf facets and times out the third route", async () => {
  for (const body of [
    { data: { category: { id: 8, pagetitle: "Other", total_products: 1 }, options: [] } },
    { data: { category: { id: 7, pagetitle: "Live leaf & parts", total_products: 1 } } },
    { data: { category: { id: 7, pagetitle: "Live leaf & parts", total_products: -1 }, options: [] } },
    { data: { category: { id: 7, pagetitle: "Live leaf & parts", total_products: 1 }, options: [null] } },
    { success: false, ...HEALTHY_FACETS },
    { success: false, error: "private" },
  ]) {
    const result = await runCatalogHealthPreflight({
      baseUrl: BASE, apiToken: "fixture-private-token",
      fetchImpl: (async (input) => {
        const path = new URL(String(input)).pathname;
        if (path.endsWith("/categories")) return categoryPage(HEALTHY_CATEGORIES);
        if (path.endsWith("/products")) return productPage([HEALTHY_PRODUCT]);
        return json(body);
      }) as typeof fetch,
    });
    assertEquals(result.classification, "schema_error");
    assertEquals(result.checks.facets?.http_status, 200);
    assert(!JSON.stringify(result).includes("private"));
  }
  let facetSignal: AbortSignal | undefined;
  const timeout = await runCatalogHealthPreflight({
    baseUrl: BASE, apiToken: "fixture-private-token", timeoutMs: 10,
    fetchImpl: (async (input, init) => {
      const path = new URL(String(input)).pathname;
      if (path.endsWith("/categories")) return categoryPage(HEALTHY_CATEGORIES);
      if (path.endsWith("/products")) return productPage([HEALTHY_PRODUCT]);
      facetSignal = init?.signal ?? undefined;
      return await new Promise<Response>(() => {});
    }) as typeof fetch,
  });
  assertEquals(timeout.classification, "transport");
  assertEquals(timeout.checks.facets?.http_status, null);
  assertEquals(facetSignal?.aborted, true);
});

Deno.test("catalog QA does not guess a leaf when live taxonomy is incomplete", async () => {
  let facetCalls = 0;
  const result = await runCatalogHealthPreflight({
    baseUrl: BASE, apiToken: "fixture-private-token",
    fetchImpl: (async (input) => {
      const path = new URL(String(input)).pathname;
      if (path.endsWith("/categories")) {
        return json({ data: { results: [{ id: 1, pagetitle: "Root" }] } });
      }
      if (path.endsWith("/products")) return json({ data: { results: [HEALTHY_PRODUCT] } });
      facetCalls++;
      return json(HEALTHY_FACETS);
    }) as typeof fetch,
  });
  assertEquals(result.classification, "schema_error");
  assertEquals(result.checks.facets, undefined);
  assertEquals(facetCalls, 0);
});

Deno.test("catalog QA does not start paid checks for empty or unusable product pages", async () => {
  const restricted = {
    ...HEALTHY_PRODUCT,
    options: [{ key: "ogranichennyy_prosmotr", value_ru: "Да" }],
  };
  for (
    const products of [
      [],
      [null],
      [{ ...HEALTHY_PRODUCT, price: 0 }],
      [{ ...HEALTHY_PRODUCT, url: "https://example.com/product" }],
      [restricted],
    ]
  ) {
    const result = await runCatalogHealthPreflight({
      baseUrl: BASE,
      apiToken: "fixture-private-token",
      fetchImpl: (async (input) =>
        new URL(String(input)).pathname.endsWith("/categories")
          ? json({ data: { results: [{ id: 1, pagetitle: "Root" }] } })
          : json({ data: { results: products } })) as typeof fetch,
    });
    assertEquals(result.ok, false);
    assertEquals(result.classification, "schema_error");
    assertEquals(result.checks.products.status, "unavailable");
  }
});

Deno.test("catalog QA rejects ignored, empty, incomplete, or failed exact-article filters", async () => {
  const unrelated = { ...HEALTHY_PRODUCT, id: 2, article: "OTHER-2" };
  const filtered = (results: unknown[], paginationOverride: Record<string, unknown> = {}) => ({
    data: { results, pagination: {
      page: 1, per_page: 50, pages: 1, total: results.length,
      ...paginationOverride,
    } },
  });
  const cases = [
    filtered([HEALTHY_PRODUCT, unrelated]),
    filtered([unrelated]),
    filtered([]),
    filtered([{ ...HEALTHY_PRODUCT, article: null }]),
    filtered([{ ...HEALTHY_PRODUCT, price: 0 }]),
    filtered([{ ...HEALTHY_PRODUCT, url: "https://wrong.invalid/product" }]),
    filtered([{ ...HEALTHY_PRODUCT, id: 2 }]),
    { data: { results: [HEALTHY_PRODUCT] } },
    filtered([HEALTHY_PRODUCT], { total: 2 }),
    filtered([HEALTHY_PRODUCT], { page: 2 }),
    filtered([HEALTHY_PRODUCT], { pages: 2 }),
    filtered([HEALTHY_PRODUCT], { per_page: 0 }),
    filtered([HEALTHY_PRODUCT], { per_page: "50" }),
    filtered([HEALTHY_PRODUCT], { page: undefined }),
    filtered([HEALTHY_PRODUCT], { pages: undefined }),
    { success: false, ...filtered([HEALTHY_PRODUCT]) },
  ];
  for (const filteredBody of cases) {
    const result = await runCatalogHealthPreflight({
      baseUrl: BASE, apiToken: "fixture-private-token",
      fetchImpl: (async (input) => {
        const url = new URL(String(input));
        if (url.pathname.endsWith("/categories")) {
          return categoryPage(HEALTHY_CATEGORIES);
        }
        if (url.pathname.endsWith("/products")) {
          return url.searchParams.has("article")
            ? json(filteredBody)
            : productPage([HEALTHY_PRODUCT]);
        }
        return json(HEALTHY_FACETS);
      }) as typeof fetch,
    });
    assertEquals(result.ok, false);
    assertEquals(result.classification, "schema_error");
    assertEquals(result.checks.article_filter, {
      status: "unavailable", http_status: 200, classification: "schema_error",
    });
    assertEquals(result.checks.facets?.status, "ok");
    assert(!JSON.stringify(result).includes("OTHER-2"));
  }
});

Deno.test("catalog QA accepts duplicate exact articles only when the baseline SKU is present", async () => {
  const result = await runCatalogHealthPreflight({
    baseUrl: BASE, apiToken: "fixture-private-token",
    fetchImpl: (async (input) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/categories")) {
        return categoryPage(HEALTHY_CATEGORIES);
      }
      if (url.pathname.endsWith("/products")) {
        return productPage(url.searchParams.has("article")
          ? [HEALTHY_PRODUCT, { ...HEALTHY_PRODUCT, id: 2 }]
          : [HEALTHY_PRODUCT]);
      }
      return json(HEALTHY_FACETS);
    }) as typeof fetch,
  });
  assertEquals(result.status, "ready");
});

Deno.test("catalog QA cannot prove an article filter without a usable baseline article", async () => {
  const calls: string[] = [];
  const result = await runCatalogHealthPreflight({
    baseUrl: BASE, apiToken: "fixture-private-token",
    fetchImpl: (async (input) => {
      const url = new URL(String(input));
      calls.push(url.pathname);
      if (url.pathname.endsWith("/categories")) {
        return categoryPage(HEALTHY_CATEGORIES);
      }
      return productPage([{ ...HEALTHY_PRODUCT, article: null }]);
    }) as typeof fetch,
  });
  assertEquals(result.classification, "schema_error");
  assertEquals(result.checks.article_filter, {
    status: "unavailable", http_status: null, classification: "schema_error",
  });
  assertEquals(calls, ["/api/categories", "/api/products"]);
});

Deno.test("catalog QA classifies filtered-article transport failure without exposing identity", async () => {
  const result = await runCatalogHealthPreflight({
    baseUrl: BASE, apiToken: "fixture-private-token", timeoutMs: 10,
    fetchImpl: (async (input) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/categories")) {
        return categoryPage(HEALTHY_CATEGORIES);
      }
      if (url.pathname.endsWith("/products")) {
        return url.searchParams.has("article")
          ? await new Promise<Response>(() => {})
          : productPage([HEALTHY_PRODUCT]);
      }
      return json(HEALTHY_FACETS);
    }) as typeof fetch,
  });
  assertEquals(result.ok, false);
  assertEquals(result.classification, "transport");
  assertEquals(result.checks.article_filter, {
    status: "unavailable", http_status: null, classification: "transport",
  });
  assert(!JSON.stringify(result).includes("FIX-1"));
});

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
        return json({ data: { results: HEALTHY_CATEGORIES } });
      }
      if (url.pathname.endsWith("/products")) {
        return json({ data: { results: [HEALTHY_PRODUCT] } });
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
    },
  });
  assertEquals(requests.length, 3);
  const categories = requests.find(({ url }) =>
    url.pathname.endsWith("/categories")
  );
  const products = requests.find(({ url }) =>
    url.pathname.endsWith("/products")
  );
  const facets = requests.find(({ url }) =>
    url.pathname.endsWith("/categories/options")
  );
  assert(categories && products && facets);
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
        return json({ data: { results: categories } });
      }
      if (url.pathname.endsWith("/products")) {
        return json({ data: { results: [product] } });
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
        return json({ data: { results: HEALTHY_CATEGORIES } });
      }
      if (url.pathname.endsWith("/products")) {
        return json({ data: { results: [HEALTHY_PRODUCT] } });
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
  assertEquals(requests, ["/api/categories", "/api/products", "/api/categories/options"]);
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
        if (path.endsWith("/categories")) return json({ data: { results: HEALTHY_CATEGORIES } });
        if (path.endsWith("/products")) return json({ data: { results: [HEALTHY_PRODUCT] } });
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
      if (path.endsWith("/categories")) return json({ data: { results: HEALTHY_CATEGORIES } });
      if (path.endsWith("/products")) return json({ data: { results: [HEALTHY_PRODUCT] } });
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

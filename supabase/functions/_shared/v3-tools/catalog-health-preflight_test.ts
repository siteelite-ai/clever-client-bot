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

Deno.test("catalog QA uses the real V3 taxonomy query and authenticated product route", async () => {
  const requests: Array<{ url: URL; auth: string | null }> = [];
  const result = await runCatalogHealthPreflight({
    baseUrl: BASE,
    apiToken: "fixture-private-token",
    fetchImpl: (async (input, init) => {
      const req = new Request(input, init);
      const url = new URL(req.url);
      requests.push({ url, auth: req.headers.get("authorization") });
      return url.pathname.endsWith("/categories")
        ? json({
          data: { results: [{ id: 1, pagetitle: "Root", children: [] }] },
        })
        : json({ data: { results: [HEALTHY_PRODUCT] } });
    }) as typeof fetch,
  });
  assertEquals(result, {
    ok: true,
    status: "ready",
    checks: {
      categories: { status: "ok", http_status: 200 },
      products: { status: "ok", http_status: 200 },
    },
  });
  assertEquals(requests.length, 2);
  const categories = requests.find(({ url }) =>
    url.pathname.endsWith("/categories")
  );
  const products = requests.find(({ url }) =>
    url.pathname.endsWith("/products")
  );
  assert(categories && products);
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

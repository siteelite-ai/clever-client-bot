import {
  assert,
  assertEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  isCatalogRouteProbeCandidate,
  parseCatalogRouteProbePayload,
  runCatalogRouteProbe,
} from "./catalog-route-probe.ts";

const BASE = "https://fixture.catalog.invalid/api";
const TOKEN = "private-catalog-token-do-not-reflect";
const PRODUCT = {
  id: 123,
  pagetitle: "Private Gallant fixture product",
  price: 1000,
  url: "https://220volt.kz/catalog/test/fixtures/private-product/",
};

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

Deno.test("catalog route probe accepts only short exact private payloads", () => {
  assertEquals(isCatalogRouteProbeCandidate({ type: "catalog_route_probe" }), true);
  assertEquals(isCatalogRouteProbeCandidate({ type: "catalog_health_preflight" }), false);
  assertEquals(parseCatalogRouteProbePayload({
    type: "catalog_route_probe",
    query: " Gallant ",
    exact_category: " Розетки ",
  }), {
    type: "catalog_route_probe",
    query: "Gallant",
    exact_category: "Розетки",
  });
  for (
    const bad of [
      { type: "catalog_route_probe" },
      { type: "catalog_route_probe", query: "" },
      { type: "catalog_route_probe", query: "x".repeat(65) },
      { type: "catalog_route_probe", exact_category: "A\nB" },
      { type: "catalog_route_probe", query: 12 },
      { type: "catalog_route_probe", query: "Gallant", endpoint: "https://evil.invalid" },
      { type: "catalog_route_probe", query: "Gallant", apiToken: TOKEN },
      { type: "catalog_route_probe", query: "Gallant", exact_category: null },
      { type: "catalog_route_probe", query: "Gallant", check_facets: true },
      { type: "catalog_route_probe", exact_category: "Розетки", check_facets: false },
      null,
      [],
    ]
  ) assertEquals(parseCatalogRouteProbePayload(bad), null);
});

Deno.test("catalog route probe uses representative search and exact taxonomy without model calls", async () => {
  const requests: Array<{ url: URL; auth: string | null }> = [];
  const result = await runCatalogRouteProbe(
    { type: "catalog_route_probe", query: "Gallant", exact_category: "Розетки", check_facets: true },
    {
      baseUrl: BASE,
      apiToken: TOKEN,
      fetchImpl: (async (input, init) => {
        const request = new Request(input, init);
        const url = new URL(request.url);
        requests.push({ url, auth: request.headers.get("authorization") });
        if (url.pathname === "/api/products") {
          return json({ data: { results: [PRODUCT], pagination: { total: 1 } } });
        }
        if (url.pathname === "/api/categories") {
          return json({
            data: {
              results: [{ id: 7, pagetitle: "Розетки", children: [] }],
              pagination: { page: 1, per_page: 200, pages: 1, total: 1 },
            },
          });
        }
        if (url.pathname === "/api/categories/options") {
          return json({
            data: {
              category: { id: 7, pagetitle: "Розетки", total_products: 12 },
              options: [{
                key: "connector_count",
                caption_ru: "Количество разъемов",
                type: "number",
                values: [{ value_ru: "2", products_count: 5 }],
              }],
            },
          });
        }
        throw new Error(`unexpected destination: ${url.origin}${url.pathname}`);
      }) as typeof fetch,
    },
  );
  assertEquals(result.ok, true);
  assertEquals(result.status, "ready");
  assertEquals(result.checks.search?.status, "ok");
  assertEquals(result.checks.exact_leaf?.status, "ok");
  assertEquals(result.checks.taxonomy?.status, "ok");
  assertEquals(result.checks.taxonomy?.taxonomy_cache, "eligible_unverified");
  assertEquals(requests.length, 3);
  assertEquals(requests[0].url.searchParams.toString(), "query=Gallant&min_price=1&per_page=50");
  assertEquals(requests[1].url.searchParams.toString(), "parent=0&depth=10&per_page=200&page=1");
  assertEquals(requests[2].url.searchParams.toString(), "pagetitle=%D0%A0%D0%BE%D0%B7%D0%B5%D1%82%D0%BA%D0%B8");
  assert(requests.every(({ url, auth }) =>
    url.origin === "https://fixture.catalog.invalid" && auth === `Bearer ${TOKEN}`
  ));
  const body = JSON.stringify(result);
  for (const privateValue of [TOKEN, "Gallant", "Розетки", PRODUCT.pagetitle, PRODUCT.url, BASE]) {
    assert(!body.includes(privateValue));
  }
});

Deno.test("catalog route probe rejects malformed input before any upstream call", async () => {
  let calls = 0;
  const result = await runCatalogRouteProbe(
    { type: "catalog_route_probe", query: "x".repeat(65) },
    {
      baseUrl: BASE,
      apiToken: TOKEN,
      fetchImpl: (async () => {
        calls++;
        throw new Error("must not fetch");
      }) as typeof fetch,
    },
  );
  assertEquals(calls, 0);
  assertEquals(result, {
    ok: false,
    status: "unavailable",
    classification: "invalid_probe",
    checks: {},
  });
});

Deno.test("catalog route probe distinguishes upstream failure and empty query without reflecting body", async () => {
  const failed = await runCatalogRouteProbe(
    { type: "catalog_route_probe", query: "Gallant" },
    {
      baseUrl: BASE,
      apiToken: TOKEN,
      fetchImpl: (async () => json({ private_error: "upstream secret" }, 502)) as typeof fetch,
    },
  );
  assertEquals(failed.ok, false);
  assertEquals(failed.classification, "upstream");
  assertEquals(failed.checks.search?.classification, "upstream");
  assert(!JSON.stringify(failed).includes("upstream secret"));

  const empty = await runCatalogRouteProbe(
    { type: "catalog_route_probe", query: "Gallant" },
    {
      baseUrl: BASE,
      apiToken: TOKEN,
      fetchImpl: (async () =>
        json({ data: { results: [], pagination: { total: 0 } } })) as typeof fetch,
    },
  );
  assertEquals(empty.classification, "no_match");
  assertEquals(empty.checks.search?.classification, "no_match");
});

Deno.test("catalog route probe bounds a stalled catalog search", async () => {
  const started = Date.now();
  const result = await runCatalogRouteProbe(
    { type: "catalog_route_probe", query: "Gallant" },
    {
      baseUrl: BASE,
      apiToken: TOKEN,
      fetchImpl: (async (_input, init) =>
        await new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(new DOMException("aborted", "AbortError")), { once: true });
        })) as typeof fetch,
    },
    { searchDeadlineMs: 10 },
  );
  assertEquals(result.classification, "timeout");
  assertEquals(result.checks.search?.classification, "timeout");
  assert(Date.now() - started < 1_000);
});

Deno.test("catalog route probe keeps exact-category miss separate from outage", async () => {
  // The shared taxonomy adapter may already be warm from the successful test.
  // Regardless of cache provenance, an unknown exact pagetitle must not call AI.
  const result = await runCatalogRouteProbe(
    { type: "catalog_route_probe", exact_category: "Unknown fixture category" },
    {
      baseUrl: BASE,
      apiToken: TOKEN,
      fetchImpl: (async (input) => {
        const url = new URL(String(input));
        if (url.pathname === "/api/categories") {
          return json({ data: { results: [{ id: 7, pagetitle: "Розетки", children: [] }] } });
        }
        throw new Error(`unexpected upstream ${url.pathname}`);
      }) as typeof fetch,
    },
  );
  assertEquals(result.classification, "no_match");
  assertEquals(result.checks.exact_leaf?.classification, "no_match");
  assertEquals(result.checks.taxonomy, undefined);
  assertEquals(result.checks.exact_leaf?.taxonomy_cache, "eligible_unverified");
});

Deno.test("catalog route probe reports exact-category options outage without reflecting its body", async () => {
  const result = await runCatalogRouteProbe(
    { type: "catalog_route_probe", exact_category: "Розетки", check_facets: true },
    {
      baseUrl: BASE,
      apiToken: TOKEN,
      fetchImpl: (async (input) => {
        const url = new URL(String(input));
        if (url.pathname === "/api/categories") {
          return json({ data: { results: [{ id: 7, pagetitle: "Розетки", children: [] }] } });
        }
        if (url.pathname === "/api/categories/options") {
          return json({ private_error: "secret upstream body" }, 502);
        }
        throw new Error(`unexpected upstream ${url.pathname}`);
      }) as typeof fetch,
    },
  );
  assertEquals(result.classification, "upstream");
  assertEquals(result.checks.exact_leaf?.status, "ok");
  assertEquals(result.checks.taxonomy?.classification, "upstream");
  const body = JSON.stringify(result);
  assert(!body.includes(TOKEN));
  assert(!body.includes("Розетки"));
  assert(!body.includes("secret upstream body"));
});

Deno.test("exact leaf readiness does not depend on options availability", async () => {
  const paths: string[] = [];
  const result = await runCatalogRouteProbe(
    { type: "catalog_route_probe", exact_category: "Розетки" },
    {
      baseUrl: BASE,
      apiToken: TOKEN,
      fetchImpl: (async (input) => {
        const url = new URL(String(input));
        paths.push(url.pathname);
        if (url.pathname === "/api/categories") {
          return json({ data: { results: [{ id: 7, pagetitle: "Розетки", children: [] }] } });
        }
        throw new Error(`options must not be queried: ${url.pathname}`);
      }) as typeof fetch,
    },
  );
  assertEquals(result.ok, true);
  assertEquals(result.checks.exact_leaf?.status, "ok");
  assertEquals(result.checks.taxonomy, undefined);
  assertEquals(paths.includes("/api/categories/options"), false);
});

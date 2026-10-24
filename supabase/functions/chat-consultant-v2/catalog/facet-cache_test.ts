import {
  assertEquals,
  assertNotEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import { exactFacetCacheRawKey } from "../catalog-deps-factory.ts";
import { hashKey } from "../cache.ts";
import { loadCategoryFacets } from "./facet-cache.ts";
import { __resetCatalogBreakerForTests } from "./circuit-breaker.ts";

Deno.test("facet cache: distinct pagetitles that normalize alike retain exact keys", async () => {
  const first = await exactFacetCacheRawKey("A/B");
  const second = await exactFacetCacheRawKey("A B");
  assertNotEquals(first, second);
  assertNotEquals(
    await hashKey("facets", first),
    await hashKey("facets", second),
  );
});

Deno.test("facet cache: a cross-category hit is rejected and live category recovers", async () => {
  __resetCatalogBreakerForTests();
  let networkCalls = 0;
  const apiClient = {
    baseUrl: "https://catalog.example.test/api",
    apiToken: "synthetic",
    fetch: (async () => {
      networkCalls++;
      return Response.json({ data: {
        category: { pagetitle: "A B", total_products: 3 },
        options: [{ key: "finish", values: [{ value_ru: "B-only" }] }],
      } });
    }) as typeof fetch,
  };
  const wrongCategory = {
    status: "ok" as const,
    categoryPagetitle: "A/B",
    options: [{ key: "finish", values: [{ value_ru: "A-only" }] }],
    totalProducts: 3,
    ms: 1,
  };
  const result = await loadCategoryFacets(
    "A B", 3600, apiClient,
    async () => ({ value: wrongCategory as never, cacheHit: true }),
  );
  assertEquals(result.source, "live");
  assertEquals(result.value.categoryPagetitle, "A B");
  assertEquals(result.value.options[0].values?.[0].value_ru, "B-only");
  assertEquals(networkCalls, 1);
});

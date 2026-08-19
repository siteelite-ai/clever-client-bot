import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { executeSearchCatalog } from "./search-catalog.ts";
import type { ProductCache } from "./types.ts";

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

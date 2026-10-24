import {
  assert,
  assertEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  type ReplacementCandidateSearch,
  retrieveReplacementCandidateWindow,
} from "./replacement-candidate-retrieval.ts";
import type { ProductCache, ProductRef } from "./types.ts";

const deps = { baseUrl: "https://catalog.test", apiToken: "test-only" };

function card(id: string): ProductRef {
  return {
    id,
    pagetitle: `Товар ${id}`,
    vendor: null,
    price: 100,
    stock: "in_stock",
    short_traits: [],
    leaf_category: "Светильники",
  };
}

function ok(
  total: number,
  ids: string[],
  coverage: "complete_query_window" | "partial" | "unknown" = "partial",
) {
  return {
    tool: "search_catalog" as const,
    ok: true as const,
    mode: "by_filter",
    total,
    results: ids.map(card),
    candidate_coverage: coverage,
  };
}

Deno.test("source-only retrieval relaxes exact source facets, then reaches leaf-only without an SKU dictionary", async () => {
  const requests: Array<
    {
      page: number | undefined;
      options: Record<string, string[]> | undefined;
      category: string | undefined;
      minPrice: number | undefined;
      maxPrice: number | undefined;
    }
  > = [];
  const search: ReplacementCandidateSearch = async (input) => {
    requests.push({
      page: input.page,
      options: input.options,
      category: input.category,
      minPrice: input.min_price,
      maxPrice: input.max_price,
    });
    const keys = Object.keys(input.options ?? {});
    if (keys.length === 3) return ok(0, [], "complete_query_window");
    if (keys.length === 2) return ok(1, ["a"], "complete_query_window");
    if (keys.length === 1) return ok(1, ["a"], "complete_query_window");
    return ok(2, ["a", "b"], "complete_query_window");
  };
  const result = await retrieveReplacementCandidateWindow({
    leafCategory: "Светильники",
    strictOptions: {
      kind: ["downlight"],
      mount: ["recessed"],
      color: ["neutral"],
    },
    softFacetOrder: ["color", "mount", "kind"],
    maxPrice: 2_000,
    deps,
    cache: new Map(),
    search,
  });
  assertEquals(result.termination, "stage_plan_completed");
  assertEquals(result.products.map((product) => product.id), ["a", "b"]);
  assertEquals(result.stages.map((stage) => stage.kind), [
    "strict",
    "relaxed",
    "relaxed",
    "leaf_only",
  ]);
  assertEquals(result.stages.map((stage) => stage.droppedFacetKeys), [
    [],
    ["color"],
    ["color", "mount"],
    ["color", "mount", "kind"],
  ]);
  assertEquals(requests.map((request) => Object.keys(request.options ?? {})), [
    ["kind", "mount", "color"],
    ["kind", "mount"],
    ["kind"],
    [],
  ]);
  assertEquals(requests.map((request) => request.maxPrice), [
    2_000,
    2_000,
    2_000,
    2_000,
  ]);
  assertEquals(requests.map((request) => request.minPrice), [1, 1, 1, 1]);
  assertEquals(requests.map((request) => request.category), [
    "Светильники",
    "Светильники",
    "Светильники",
    "Светильники",
  ]);
  assertEquals(result.leafQueryCoverage, "complete_query_window");
});

Deno.test("paginated recall dedupes IDs but never upgrades multi-page raw coverage to exhaustive", async () => {
  const requests: number[] = [];
  const search: ReplacementCandidateSearch = async (input) => {
    requests.push(input.page ?? -1);
    if (input.options) {
      if (input.page === 1) return ok(5, ["a", "b"]);
      if (input.page === 2) return ok(5, ["b", "c"]);
      return ok(5, ["d"]);
    }
    return ok(0, [], "complete_query_window");
  };
  const result = await retrieveReplacementCandidateWindow({
    leafCategory: "Светильники",
    strictOptions: { form: ["recessed"] },
    deps,
    cache: new Map(),
    search,
    pageSize: 2,
    maxPagesPerStage: 3,
  });
  assertEquals(requests, [1, 2, 3, 1]);
  assertEquals(result.products.map((product) => product.id), [
    "a",
    "b",
    "c",
    "d",
  ]);
  assertEquals(result.stages[0].pages.map((page) => page.reportedTotal), [
    5,
    5,
    5,
  ]);
  assertEquals(result.stages[0].coverage, "partial");
  assertEquals(result.stages[0].requestedWindowScanned, true);
  assertEquals(result.leafQueryCoverage, "complete_query_window");
});

Deno.test("a global page cap returns partial stage evidence and does not pretend leaf-only was searched", async () => {
  const search: ReplacementCandidateSearch = async () => ok(500, ["a"]);
  const result = await retrieveReplacementCandidateWindow({
    leafCategory: "Светильники",
    strictOptions: { kind: ["downlight"], color: ["neutral"] },
    deps,
    cache: new Map(),
    search,
    maxPagesTotal: 2,
    maxPagesPerStage: 2,
  });
  assertEquals(result.termination, "page_cap");
  assertEquals(result.pagesRequested, 2);
  assertEquals(result.stages.length, 1);
  assertEquals(result.stages[0].coverage, "partial");
  assertEquals(result.stages[0].interruption, "global_page_limit");
  assertEquals(result.stages[0].requestedWindowScanned, false);
  assertEquals(result.leafQueryCoverage, null);
  assertEquals(result.plannedStageCount, 3);
});

Deno.test("deadline aborts a hanging executor and records the interrupted stage", async () => {
  const search: ReplacementCandidateSearch = () => new Promise(() => {});
  const started = Date.now();
  const result = await retrieveReplacementCandidateWindow({
    leafCategory: "Светильники",
    strictOptions: { kind: ["downlight"] },
    deps,
    cache: new Map(),
    search,
    deadlineMs: 20,
  });
  assertEquals(result.termination, "deadline");
  assertEquals(result.stages[0].interruption, "deadline");
  assertEquals(result.leafQueryCoverage, null);
  assert(Date.now() - started < 1_000);
});

Deno.test("external abort stops before a catalog call", async () => {
  const controller = new AbortController();
  controller.abort();
  let calls = 0;
  const result = await retrieveReplacementCandidateWindow({
    leafCategory: "Светильники",
    strictOptions: { kind: ["downlight"] },
    deps: { ...deps, signal: controller.signal },
    cache: new Map(),
    search: async () => {
      calls++;
      return ok(0, [], "complete_query_window");
    },
  });
  assertEquals(result.termination, "external_abort");
  assertEquals(result.pagesRequested, 0);
  assertEquals(result.stages.length, 0);
  assertEquals(calls, 0);
});

Deno.test("executor rejection returns a bounded technical failure, not false no-results", async () => {
  const result = await retrieveReplacementCandidateWindow({
    leafCategory: "Светильники",
    strictOptions: { kind: ["downlight"] },
    deps,
    cache: new Map(),
    search: () => Promise.reject(new Error("private upstream detail")),
  });
  assertEquals(result.termination, "catalog_error");
  assertEquals(result.failedStage, {
    id: "strict",
    errorCode: "internal",
    message: "catalog executor rejected",
  });
});

Deno.test("inconsistent single-page complete flag is downgraded to unknown", async () => {
  const result = await retrieveReplacementCandidateWindow({
    leafCategory: "Светильники",
    strictOptions: {},
    deps,
    cache: new Map(),
    pageSize: 2,
    maxLeafPages: 1,
    search: async () => ok(20, ["a", "b"], "complete_query_window"),
  });
  assertEquals(result.stages[0].coverage, "unknown");
  assertEquals(result.leafQueryCoverage, "unknown");
  assertEquals(result.stages[0].requestedWindowScanned, false);
});

Deno.test("unmaterialized raw total is not reported as a fully scanned leaf", async () => {
  const result = await retrieveReplacementCandidateWindow({
    leafCategory: "Светильники",
    strictOptions: {},
    deps,
    cache: new Map(),
    maxLeafPages: 1,
    search: async () => ({
      ...ok(0, [], "unknown"),
      warnings: ["catalog_unmaterialized_total:200"],
    }),
  });
  assertEquals(result.products, []);
  assertEquals(result.stages[0].requestedWindowScanned, false);
  assertEquals(result.stages[0].coverage, "unknown");
  assertEquals(result.leafQueryCoverage, "unknown");
});

Deno.test("unknown raw page coverage with zero reported total never proves a scanned leaf", async () => {
  const result = await retrieveReplacementCandidateWindow({
    leafCategory: "Светильники",
    strictOptions: {},
    deps,
    cache: new Map(),
    maxLeafPages: 1,
    search: async () => ok(0, [], "unknown"),
  });
  assertEquals(result.stages[0].requestedWindowScanned, false);
  assertEquals(result.stages[0].coverage, "unknown");
  assertEquals(result.leafQueryCoverage, "unknown");
});

Deno.test("catalog failure stops relaxation instead of reporting an empty category", async () => {
  let calls = 0;
  const search: ReplacementCandidateSearch = async () => {
    calls++;
    if (calls === 1) return ok(0, [], "complete_query_window");
    return {
      tool: "search_catalog",
      ok: false,
      error_code: "rate_limited",
      message: "429",
    };
  };
  const result = await retrieveReplacementCandidateWindow({
    leafCategory: "Светильники",
    strictOptions: { kind: ["downlight"] },
    deps,
    cache: new Map(),
    search,
  });
  assertEquals(result.termination, "catalog_error");
  assertEquals(result.failedStage, {
    id: "leaf_only",
    errorCode: "rate_limited",
    message: "429",
  });
  assertEquals(result.stages[1].coverage, "unknown");
  assertEquals(result.leafQueryCoverage, "unknown");
  assertEquals(calls, 2);
});

Deno.test("pagination drift and uncertain raw coverage cannot become a complete claim", async () => {
  const search: ReplacementCandidateSearch = async (input) =>
    input.page === 1 ? ok(3, ["a"], "unknown") : ok(4, ["b"], "partial");
  const result = await retrieveReplacementCandidateWindow({
    leafCategory: "Светильники",
    strictOptions: { kind: ["downlight"] },
    deps,
    cache: new Map(),
    search,
    pageSize: 1,
    maxPagesPerStage: 3,
  });
  assertEquals(result.termination, "pagination_changed");
  assertEquals(result.stages[0].coverage, "unknown");
  assertEquals(result.stages[0].interruption, "pagination_changed");
  assertEquals(result.leafQueryCoverage, null);
});

Deno.test("real shared catalog boundary keeps restricted cards out of recall results and cache", async () => {
  const cache: ProductCache = new Map();
  const fetchImpl: typeof fetch = () =>
    Promise.resolve(
      new Response(
        JSON.stringify({
          data: {
            results: [
              {
                id: "public",
                pagetitle: "Public item",
                price: 100,
                url: "https://220volt.kz/catalog/test/items/public/",
                options: [{ key: "ogranichennyy_prosmotr", value_ru: "Нет" }],
              },
              {
                id: "restricted",
                pagetitle: "Restricted item",
                price: 100,
                url: "https://220volt.kz/catalog/test/items/restricted/",
                options: [{ key: "ogranichennyy_prosmotr", value_ru: "Да" }],
              },
            ],
            pagination: { total: 2 },
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
  const result = await retrieveReplacementCandidateWindow({
    leafCategory: "Светильники",
    strictOptions: { kind: ["downlight"] },
    deps: { ...deps, fetchImpl },
    cache,
    stopWhen: (products) => products.some((product) => product.id === "public"),
  });
  assertEquals(result.termination, "target_reached");
  assertEquals(result.products.map((product) => product.id), ["public"]);
  assertEquals([...cache.keys()], ["public"]);
  assertEquals(
    result.stages[0].pages[0].candidateCoverage,
    "complete_query_window",
  );
  assertEquals(result.stages[0].pages[0].visibleCount, 1);
});

Deno.test("physical catalog request cap includes hidden restricted-row recovery fetches", async () => {
  const cache: ProductCache = new Map();
  let physicalFetches = 0;
  const restrictedRows = Array.from({ length: 50 }, (_, index) => ({
    id: `restricted-${index}`,
    pagetitle: `Restricted item ${index}`,
    price: 100,
    url: `https://220volt.kz/catalog/test/items/restricted-${index}/`,
    options: [{ key: "ogranichennyy_prosmotr", value_ru: "Да" }],
  }));
  const fetchImpl: typeof fetch = () => {
    physicalFetches++;
    return Promise.resolve(
      new Response(
        JSON.stringify({
          data: {
            results: restrictedRows,
            pagination: { total: 200 },
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
  };
  const result = await retrieveReplacementCandidateWindow({
    leafCategory: "Светильники",
    strictOptions: { kind: ["downlight"] },
    deps: { ...deps, fetchImpl },
    cache,
    maxPagesTotal: 2,
    maxCatalogRequestsTotal: 2,
  });
  assertEquals(physicalFetches, 2);
  assertEquals(result.catalogRequestsMade, 2);
  assertEquals(result.pagesRequested, 1);
  assertEquals(result.termination, "request_cap");
  assertEquals(result.stages[0].interruption, "upstream_request_limit");
  assertEquals(result.stages[0].requestedWindowScanned, false);
  assertEquals(result.leafQueryCoverage, null);
  assertEquals(result.products, []);
  assertEquals([...cache.keys()], []);
});

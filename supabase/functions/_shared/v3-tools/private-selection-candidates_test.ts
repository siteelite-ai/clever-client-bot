import {
  assertEquals,
  assertFalse,
} from "https://deno.land/std@0.208.0/assert/mod.ts";
import { retrievePrivateSelectionCandidates } from "./private-selection-candidates.ts";
import type { DiscoverCategoryOk } from "./discover-category.ts";
import type {
  executeSearchCatalog,
  SearchCatalogInput,
} from "./search-catalog.ts";
import type { ProductCache } from "./types.ts";

const discovery: DiscoverCategoryOk = {
  ok: true,
  category: { id: 1, pagetitle: "Категория", total_products: 20 },
  leaf_categories: [{ id: 1, pagetitle: "Лист" }],
  facets: [{
    key: "rating",
    caption: "Параметр",
    unit: "A",
    type: "list",
    values: [{ value: "4–6" }, { value: "6–10" }],
  }, { key: "files", caption: "Файлы", unit: null, type: "list", values: [] }],
};
const deps = {
  baseUrl: "https://catalog.invalid",
  apiToken: "not-a-real-token",
};
const input = {
  discovery,
  deps,
  options: { rating: ["4–6", "6–10"] },
  maxPrice: 1000,
};

Deno.test("private retrieval preserves all supplied options, category and budget without a renderable pool", async () => {
  let request: SearchCatalogInput | undefined;
  let privateCache: ProductCache | undefined;
  const search: typeof executeSearchCatalog = async (query, _deps, cache) => {
    request = query;
    privateCache = cache;
    const product = {
      id: "private-id",
      pagetitle: "Товар",
      vendor: null,
      price: 100,
      stock: "in_stock" as const,
      short_traits: [],
      url: "https://catalog.invalid/private-card",
      facet_values: {
        rating: ["4–6"],
        files: ["private.pdf"],
        unknown: ["discard"],
      },
    };
    cache.set(product.id, product);
    return {
      tool: "search_catalog",
      ok: true,
      mode: query.mode,
      total: 20,
      results: [product],
      side_effects: [{ type: "contacts", html: "must not escape" }],
    };
  };
  const result = await retrievePrivateSelectionCandidates(input, search);
  assertEquals(request, {
    mode: "by_filter",
    category_in: ["Лист"],
    options: input.options,
    per_page: 12,
    page: 1,
    max_price: 1000,
  });
  assertEquals(result, {
    status: "ready",
    count: 1,
    evidence: {
      category: "Категория",
      sample_only: true,
      candidates: [{
        name: "Товар",
        properties: [{ key: "rating", caption: "Параметр", values: ["4–6"] }],
      }],
    },
  });
  const serialized = JSON.stringify(result);
  for (
    const forbidden of [
      "private-id",
      "private-card",
      "private.pdf",
      "must not escape",
      "side_effects",
      "not-a-real-token",
    ]
  ) assertFalse(serialized.includes(forbidden));
  assertEquals(privateCache?.size, 1);
});

Deno.test("invalid and contradictory supplied options never silently become a broad query", async () => {
  let calls = 0;
  const search: typeof executeSearchCatalog = () => {
    calls++;
    throw new Error("must not run");
  };
  const invalidOptions: Array<Record<string, string[]>> = [{ rating: [] }, {
    rating: ["invented"],
  }, { unknown: ["x"] }];
  for (const options of invalidOptions) {
    assertEquals(
      await retrievePrivateSelectionCandidates({ ...input, options }, search),
      { status: "skipped", count: 0 },
    );
  }
  assertEquals(calls, 0);
});

Deno.test("a broad discovery cannot cause unbounded category fanout", async () => {
  const wide = {
    ...discovery,
    leaf_categories: [1, 2, 3, 4].map((id) => ({ id, pagetitle: String(id) })),
  };
  assertEquals(
    await retrievePrivateSelectionCandidates(
      { ...input, discovery: wide },
      () => {
        throw new Error("must not run");
      },
    ),
    { status: "skipped", count: 0 },
  );
});

Deno.test("catalog failure remains unavailable, never evidence of no matching products", async () => {
  assertEquals(
    await retrievePrivateSelectionCandidates(
      input,
      async () => ({
        tool: "search_catalog",
        ok: false,
        error_code: "catalog_timeout",
        message: "upstream",
      }),
    ),
    { status: "unavailable", count: 0 },
  );
  assertEquals(
    await retrievePrivateSelectionCandidates(input, () => {
      throw new Error("network");
    }),
    { status: "unavailable", count: 0 },
  );
});

Deno.test("sample is bounded and every invocation gets a separate private cache", async () => {
  let previous: ProductCache | undefined;
  const search: typeof executeSearchCatalog = async (_query, _deps, cache) => {
    assertFalse(cache === previous);
    previous = cache;
    return {
      tool: "search_catalog",
      ok: true,
      mode: "by_filter",
      total: 500,
      results: Array.from(
        { length: 12 },
        (_, id) => ({
          id: String(id),
          pagetitle: "x".repeat(500),
          vendor: null,
          price: 1,
          stock: "in_stock",
          short_traits: [],
        }),
      ),
    };
  };
  for (let i = 0; i < 2; i++) {
    const result = await retrievePrivateSelectionCandidates(input, search);
    assertEquals(result.count, 6);
    assertEquals(result.evidence?.candidates[0].name.length, 180);
    assertEquals(result.evidence?.sample_only, true);
  }
});

Deno.test("private candidate evidence has a hard serialized input budget", async () => {
  const facets = Array.from(
    { length: 24 },
    (_, i) => ({
      key: `property_${i}`,
      caption: "x".repeat(200),
      unit: null,
      type: "list",
      values: [],
    }),
  );
  const search: typeof executeSearchCatalog = async (_q, _d, cache) => {
    const product = {
      id: "id",
      pagetitle: "candidate",
      vendor: null,
      price: 1,
      stock: "in_stock" as const,
      short_traits: [],
      url: "https://catalog.invalid/hidden",
      facet_values: Object.fromEntries(
        facets.map((f) => [f.key, Array(4).fill("x".repeat(500))]),
      ),
    };
    cache.set(product.id, product);
    return {
      tool: "search_catalog",
      ok: true,
      mode: "by_filter",
      total: 12,
      results: Array(12).fill(product),
    };
  };
  const result = await retrievePrivateSelectionCandidates({
    ...input,
    options: {},
    discovery: { ...discovery, facets },
  }, search);
  assertEquals(result.status, "ready");
  assertFalse(JSON.stringify(result.evidence).length > 12000);
});

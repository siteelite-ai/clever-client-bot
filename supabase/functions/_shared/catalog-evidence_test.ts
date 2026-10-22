import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  assessCategoryFacets,
  assessCategoryPage,
  combineCategoryPages,
} from "./catalog-evidence.ts";

function node(id: number, children: unknown = []): Record<string, unknown> {
  return {
    id,
    pagetitle: `Категория ${id}`,
    alias: `category-${id}`,
    parent: 0,
    children,
  };
}

function page(
  requestedPage: number,
  results: unknown[],
  opts: { perPage?: number; pages?: number; total?: number } = {},
): unknown {
  return {
    data: {
      results,
      pagination: {
        page: requestedPage,
        per_page: opts.perPage ?? 2,
        pages: opts.pages ?? 1,
        total: opts.total ?? results.length,
      },
    },
  };
}

function facet(
  category: Record<string, unknown> = {
    id: 7,
    pagetitle: "Категория 7",
    total_products: 5,
  },
  options: unknown[] = [{
    key: "brand",
    values: [{ value_ru: "Марка", products_count: 5 }],
  }],
): unknown {
  return { data: { data: { category, options } } };
}

Deno.test("catalog evidence: full multi-page taxonomy is complete and sorted", () => {
  const first = assessCategoryPage(
    page(1, [node(2), node(1)], { pages: 2, total: 3 }),
    1,
  );
  const second = assessCategoryPage(
    page(2, [node(3)], { pages: 2, total: 3 }),
    2,
  );
  assertEquals(combineCategoryPages([second, first]), {
    state: "complete",
    names: ["Категория 1", "Категория 2", "Категория 3"],
  });
});

Deno.test("catalog evidence: two data envelopes are valid, a third is not", () => {
  const valid = page(1, [node(1)]);
  assertEquals(assessCategoryPage({ data: valid }, 1).state, "complete");
  assertEquals(assessCategoryPage({ data: { data: valid } }, 1), {
    state: "unavailable",
    reason: "invalid_envelope",
  });
});

Deno.test("catalog evidence: missing children permits positive names but not a completeness claim", () => {
  const first = assessCategoryPage(page(1, [node(1, null)]), 1);
  assertEquals(first.state, "visible_only");
  assertEquals(combineCategoryPages([first]), {
    state: "visible_only",
    names: ["Категория 1"],
  });
});

Deno.test("catalog evidence: a partial child tree remains visible_only across complete root pagination", () => {
  const first = assessCategoryPage(
    page(1, [node(1, null)], { perPage: 1, pages: 2, total: 2 }),
    1,
  );
  const second = assessCategoryPage(
    page(2, [node(2)], { perPage: 1, pages: 2, total: 2 }),
    2,
  );
  assertEquals(combineCategoryPages([first, second]), {
    state: "visible_only",
    names: ["Категория 1", "Категория 2"],
  });
});

Deno.test("catalog evidence: HTTP failure, false success and malformed 200 are unavailable", () => {
  const valid = page(1, [node(1)]);
  assertEquals(assessCategoryPage(valid, 1, 502), {
    state: "unavailable",
    reason: "http_error",
  });
  assertEquals(assessCategoryPage({ success: false, data: valid }, 1), {
    state: "unavailable",
    reason: "invalid_envelope",
  });
  assertEquals(
    assessCategoryPage(
      { success: true, data: { success: false, data: valid } },
      1,
    ),
    {
      state: "unavailable",
      reason: "invalid_envelope",
    },
  );
  assertEquals(assessCategoryPage({ data: null, results: [node(1)] }, 1), {
    state: "unavailable",
    reason: "invalid_envelope",
  });
  assertEquals(
    assessCategoryPage({ data: { results: null, pagination: {} } }, 1),
    {
      state: "unavailable",
      reason: "invalid_pagination",
    },
  );
});

Deno.test("catalog evidence: page length, count drift and missing page fail closed", () => {
  const short = assessCategoryPage(
    page(1, [node(1)], { pages: 2, total: 3 }),
    1,
  );
  assertEquals(short, { state: "unavailable", reason: "invalid_pagination" });
  const first = assessCategoryPage(
    page(1, [node(1), node(2)], { pages: 2, total: 3 }),
    1,
  );
  const second = assessCategoryPage(
    page(2, [node(3)], { pages: 2, total: 3 }),
    2,
  );
  const drift = assessCategoryPage(
    page(2, [node(3), node(4)], { pages: 2, total: 4 }),
    2,
  );
  assertEquals(combineCategoryPages([first]), {
    state: "unavailable",
    reason: "missing_page",
  });
  assertEquals(combineCategoryPages([first, drift]), {
    state: "unavailable",
    reason: "page_drift",
  });
  assertEquals(combineCategoryPages([first, first]), {
    state: "unavailable",
    reason: "page_drift",
  });
  assertEquals(combineCategoryPages([first, second]).state, "complete");
});

Deno.test("catalog evidence: repeated IDs within and across pages cannot become cached taxonomy", () => {
  const child = { ...node(1), parent: 1 };
  assertEquals(assessCategoryPage(page(1, [node(1, [child])]), 1), {
    state: "unavailable",
    reason: "duplicate_id",
  });
  const first = assessCategoryPage(
    page(1, [node(1)], { perPage: 1, pages: 2, total: 2 }),
    1,
  );
  const second = assessCategoryPage(
    page(2, [node(1)], { perPage: 1, pages: 2, total: 2 }),
    2,
  );
  assertEquals(combineCategoryPages([first, second]), {
    state: "unavailable",
    reason: "duplicate_id",
  });
});

Deno.test("catalog evidence: malformed category identity never becomes visible", () => {
  assertEquals(
    assessCategoryPage(
      page(1, [{ pagetitle: "Ложная категория", alias: "x", parent: 0 }]),
      1,
    ),
    {
      state: "unavailable",
      reason: "invalid_category",
    },
  );
  assertEquals(assessCategoryPage(page(1, [{ ...node(1), children: 7 }]), 1), {
    state: "unavailable",
    reason: "invalid_category",
  });
});

Deno.test("catalog evidence: an empty leaf at the maximum requested depth is valid", () => {
  let chain: Record<string, unknown> = node(11);
  for (let id = 10; id >= 1; id--) {
    chain = node(id, [chain]);
  }
  assertEquals(assessCategoryPage(page(1, [chain]), 1).state, "complete");
  const beyondDepth = node(12);
  chain = node(11, [beyondDepth]);
  for (let id = 10; id >= 1; id--) {
    chain = node(id, [chain]);
  }
  assertEquals(assessCategoryPage(page(1, [chain]), 1), {
    state: "unavailable",
    reason: "invalid_category",
  });
});

Deno.test("catalog evidence: facet requires exact category identity and a real option schema", () => {
  const matched = assessCategoryFacets(facet(), {
    pagetitle: "Категория 7",
    categoryId: 7,
  });
  assertEquals(matched.state, "verified");
  if (matched.state === "verified") assertEquals(matched.totalProducts, 5);
  assertEquals(assessCategoryFacets(facet(), { categoryId: 8 }), {
    state: "unavailable",
    reason: "category_mismatch",
  });
  assertEquals(
    assessCategoryFacets(facet({ total_products: 5 }), {
      pagetitle: "Категория 7",
    }),
    {
      state: "unavailable",
      reason: "category_mismatch",
    },
  );
  assertEquals(assessCategoryFacets(facet(), {}), {
    state: "unavailable",
    reason: "category_mismatch",
  });
});

Deno.test("catalog evidence: facet errors, malformed wrappers and fake emptiness fail closed", () => {
  assertEquals(assessCategoryFacets(facet(), { categoryId: 7 }, 502), {
    state: "unavailable",
    reason: "http_error",
  });
  assertEquals(
    assessCategoryFacets({ success: false, data: facet() }, { categoryId: 7 }),
    {
      state: "unavailable",
      reason: "invalid_envelope",
    },
  );
  assertEquals(
    assessCategoryFacets({
      data: null,
      category: { id: 7, total_products: 0 },
      options: [],
    }, { categoryId: 7 }),
    {
      state: "unavailable",
      reason: "invalid_envelope",
    },
  );
  assertEquals(
    assessCategoryFacets(facet({ id: 7, total_products: 5 }, []), {
      categoryId: 7,
    }),
    {
      state: "unavailable",
      reason: "invalid_facets",
    },
  );
  assertEquals(
    assessCategoryFacets(
      facet({ id: 7, total_products: 5 }, [{ key: "brand", values: [] }]),
      { categoryId: 7 },
    ),
    {
      state: "unavailable",
      reason: "invalid_facets",
    },
  );
  assertEquals(
    assessCategoryFacets(facet({ id: 7, total_products: null }, []), {
      categoryId: 7,
    }),
    {
      state: "unavailable",
      reason: "invalid_facets",
    },
  );
  assertEquals(
    assessCategoryFacets(
      facet({ id: 7, total_products: 1 }, [{
        key: "brand",
        values: [{ value_ru: { fake: true } }],
      }]),
      { categoryId: 7 },
    ),
    {
      state: "unavailable",
      reason: "invalid_facets",
    },
  );
});

Deno.test("catalog evidence: confirmed zero products allows empty facets; numeric values are valid", () => {
  assertEquals(
    assessCategoryFacets(facet({ id: 7, total_products: 0 }, []), {
      categoryId: 7,
    }).state,
    "verified",
  );
  assertEquals(
    assessCategoryFacets(
      facet({ id: 7, total_products: 1 }, [
        {
          key: "power",
          values: [{ value_ru: 16, value_kz: null, products_count: 1 }],
        },
      ]),
      { categoryId: 7 },
    ).state,
    "verified",
  );
});

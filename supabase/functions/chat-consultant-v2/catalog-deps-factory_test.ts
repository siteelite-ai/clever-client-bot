import {
  assertEquals,
  assertRejects,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  _resetCategoriesCache,
  createCatalogProductionDeps,
} from "./catalog-deps-factory.ts";

function categoryNode(
  pagetitle: string,
  id: number,
  parent = 0,
  children: unknown[] = [],
) {
  return { id, pagetitle, alias: `category-${id}`, parent, children };
}

function categoryPage(
  names: string[],
  page: number,
  perPage: number,
  total: number,
): Response {
  return Response.json({
    data: {
      results: names.map((pagetitle, index) => categoryNode(pagetitle, (page - 1) * perPage + index + 1)),
      pagination: { page, per_page: perPage, pages: Math.max(1, Math.ceil(total / perPage)), total },
    },
  });
}

async function withCatalogFetch(
  handler: (page: number) => Response,
  check: (listCategories: () => Promise<string[]>, calls: number[]) => Promise<void>,
): Promise<void> {
  _resetCategoriesCache();
  const originalFetch = globalThis.fetch;
  const calls: number[] = [];
  globalThis.fetch = ((input: RequestInfo | URL) => {
    const url = new URL(String(input));
    assertEquals(url.pathname, "/api/categories");
    const page = Number(url.searchParams.get("page"));
    calls.push(page);
    return Promise.resolve(handler(page));
  }) as typeof fetch;
  try {
    const deps = createCatalogProductionDeps({
      supabase: {} as never,
      openRouterKey: "unused-in-category-tests",
      catalogApiToken: "category-test-token",
      resolverThresholds: null,
      baseUrl: "https://catalog.example.test/api",
    });
    await check(deps.resolver.listCategories, calls);
  } finally {
    globalThis.fetch = originalFetch;
    _resetCategoriesCache();
  }
}

Deno.test("V2 category cache: first-page HTTP failure is not cached", async () => {
  let fail = true;
  await withCatalogFetch(
    () => fail ? new Response("unavailable", { status: 502 }) : categoryPage(["Розетки"], 1, 1, 1),
    async (listCategories, calls) => {
      await assertRejects(listCategories, Error, "/categories HTTP 502 on page 1");
      fail = false;
      assertEquals(await listCategories(), ["Розетки"]);
      assertEquals(await listCategories(), ["Розетки"]);
      assertEquals(calls, [1, 1]);
    },
  );
});

Deno.test("V2 category cache: later-page HTTP failure cannot cache a partial tree", async () => {
  let failPageTwo = true;
  await withCatalogFetch(
    (page) => page === 1
      ? categoryPage(["Розетки"], 1, 1, 2)
      : failPageTwo
      ? new Response("unavailable", { status: 502 })
      : categoryPage(["Светильники"], 2, 1, 2),
    async (listCategories, calls) => {
      await assertRejects(listCategories, Error, "/categories HTTP 502 on page 2");
      failPageTwo = false;
      assertEquals(await listCategories(), ["Розетки", "Светильники"]);
      assertEquals(await listCategories(), ["Розетки", "Светильники"]);
      assertEquals(calls, [1, 2, 1, 2]);
    },
  );
});

Deno.test("V2 category cache: malformed successful page is not treated as a complete list", async () => {
  let truncated = true;
  await withCatalogFetch(
    (page) => page === 1
      ? categoryPage(["Розетки"], 1, 1, 2)
      : truncated
      ? categoryPage([], 2, 1, 2)
      : categoryPage(["Светильники"], 2, 1, 2),
    async (listCategories, calls) => {
      await assertRejects(listCategories, Error, "/categories incomplete results on page 2");
      truncated = false;
      assertEquals(await listCategories(), ["Розетки", "Светильники"]);
      assertEquals(calls, [1, 2, 1, 2]);
    },
  );
});

Deno.test("V2 category cache: page cap fails closed instead of caching ten of eleven pages", async () => {
  let oversized = true;
  await withCatalogFetch(
    () => oversized ? categoryPage(["Розетки"], 1, 1, 11) : categoryPage(["Розетки"], 1, 1, 1),
    async (listCategories, calls) => {
      await assertRejects(listCategories, Error, "/categories incomplete pagination on page 1");
      oversized = false;
      assertEquals(await listCategories(), ["Розетки"]);
      assertEquals(calls, [1, 1]);
    },
  );
});

Deno.test("V2 category cache: complete nested taxonomy keeps sorted, deduplicated titles", async () => {
  await withCatalogFetch(
    () => Response.json({
      data: {
        results: [
          categoryNode("Розетки", 1, 0, [categoryNode("Двойные розетки", 3, 1)]),
          categoryNode("Светильники", 2, 0, [categoryNode("Розетки", 4, 2)]),
        ],
        pagination: { page: 1, per_page: 200, pages: 1, total: 2 },
      },
    }),
    async (listCategories, calls) => {
      assertEquals(await listCategories(), ["Двойные розетки", "Розетки", "Светильники"]);
      assertEquals(await listCategories(), ["Двойные розетки", "Розетки", "Светильники"]);
      assertEquals(calls, [1]);
    },
  );
});

Deno.test("V2 category cache: incomplete nested node is never cached", async () => {
  let malformed = true;
  await withCatalogFetch(
    () => malformed
      ? Response.json({
        data: {
          results: [categoryNode("Розетки", 1, 0, [{ id: 2, alias: "broken", parent: 1, children: [] }])],
          pagination: { page: 1, per_page: 200, pages: 1, total: 1 },
        },
      })
      : categoryPage(["Розетки"], 1, 1, 1),
    async (listCategories, calls) => {
      await assertRejects(listCategories, Error, "/categories incomplete node on page 1");
      malformed = false;
      assertEquals(await listCategories(), ["Розетки"]);
      assertEquals(calls, [1, 1]);
    },
  );
});

Deno.test("V2 category cache: HTTP 200 root without id cannot poison a retry", async () => {
  let malformed = true;
  await withCatalogFetch(
    () => malformed
      ? Response.json({
        data: {
          results: [{ pagetitle: "Розетки", alias: "rozetki", parent: 0, children: [] }],
          pagination: { page: 1, per_page: 1, pages: 1, total: 1 },
        },
      })
      : categoryPage(["Розетки"], 1, 1, 1),
    async (listCategories, calls) => {
      await assertRejects(listCategories, Error, "/categories incomplete node on page 1");
      malformed = false;
      assertEquals(await listCategories(), ["Розетки"]);
      assertEquals(await listCategories(), ["Розетки"]);
      assertEquals(calls, [1, 1]);
    },
  );
});

Deno.test("V2 category cache: HTTP 200 child without id cannot poison a retry", async () => {
  let malformed = true;
  await withCatalogFetch(
    () => malformed
      ? Response.json({
        data: {
          results: [categoryNode("Розетки", 1, 0, [
            { pagetitle: "Двойные розетки", alias: "double", parent: 1, children: [] },
          ])],
          pagination: { page: 1, per_page: 1, pages: 1, total: 1 },
        },
      })
      : categoryPage(["Розетки"], 1, 1, 1),
    async (listCategories, calls) => {
      await assertRejects(listCategories, Error, "/categories incomplete node on page 1");
      malformed = false;
      assertEquals(await listCategories(), ["Розетки"]);
      assertEquals(calls, [1, 1]);
    },
  );
});

Deno.test("V2 category cache: HTTP 200 success:false cannot poison a retry", async () => {
  let rejected = true;
  await withCatalogFetch(
    () => rejected
      ? Response.json({
        success: false,
        data: {
          results: [categoryNode("Розетки", 1)],
          pagination: { page: 1, per_page: 1, pages: 1, total: 1 },
        },
      })
      : categoryPage(["Розетки"], 1, 1, 1),
    async (listCategories, calls) => {
      await assertRejects(listCategories, Error, "/categories unsuccessful response on page 1");
      rejected = false;
      assertEquals(await listCategories(), ["Розетки"]);
      assertEquals(calls, [1, 1]);
    },
  );
});

Deno.test("V2 category cache: explicit null data envelope cannot use sibling results", async () => {
  let malformed = true;
  await withCatalogFetch(
    () => malformed
      ? Response.json({
        data: null,
        results: [categoryNode("Розетки", 1)],
        pagination: { page: 1, per_page: 1, pages: 1, total: 1 },
      })
      : categoryPage(["Розетки"], 1, 1, 1),
    async (listCategories, calls) => {
      await assertRejects(listCategories, Error, "/categories incomplete pagination on page 1");
      malformed = false;
      assertEquals(await listCategories(), ["Розетки"]);
      assertEquals(calls, [1, 1]);
    },
  );
});

Deno.test("V2 category cache: over-deep tree is rejected without caching", async () => {
  let tooDeep = true;
  let tree = categoryNode("Уровень 12", 13);
  for (let level = 11; level >= 0; level--) {
    tree = categoryNode(`Уровень ${level}`, level + 1, 0, [tree]);
  }
  await withCatalogFetch(
    () => tooDeep
      ? Response.json({
        data: {
          results: [tree],
          pagination: { page: 1, per_page: 1, pages: 1, total: 1 },
        },
      })
      : categoryPage(["Розетки"], 1, 1, 1),
    async (listCategories, calls) => {
      await assertRejects(listCategories, Error, "/categories tree exceeds requested depth on page 1");
      tooDeep = false;
      assertEquals(await listCategories(), ["Розетки"]);
      assertEquals(calls, [1, 1]);
    },
  );
});

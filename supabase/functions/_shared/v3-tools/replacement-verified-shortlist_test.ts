import {
  assert,
  assertEquals,
  assertRejects,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  createReplacementCatalogBudget,
  retrieveVerifiedCutoutShortlist,
  selectVerifiedCutoutHints,
} from "./replacement-verified-shortlist.ts";
import { executeSearchCatalog } from "./search-catalog.ts";
import type { ProductCache, ProductRef } from "./types.ts";

const liveUrl = (id: string) =>
  `https://220volt.kz/catalog/svetotexnika/svetilniki/${id}/`;
const future = "2026-11-20T00:00:00.000Z";
const now = new Date("2026-10-20T00:00:00.000Z");

function row(id: string, overrides: Record<string, unknown> = {}) {
  return {
    product_id: id,
    article: `ART-${id}`,
    catalog_url: liveUrl(id),
    catalog_leaf_category: "Светильники",
    approval_status: "approved",
    revoked_at: null,
    valid_until: future,
    cutout_shape: "round",
    cutout_kind: "exact",
    cutout_min_mm: 90,
    cutout_max_mm: 90,
    ...overrides,
  };
}

function raw(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    article: `ART-${id}`,
    pagetitle: `Светильник встраиваемый ${id}`,
    url: liveUrl(id),
    price: 1_000,
    category: "Светильники",
    warehouses: [{ city: "Астана", amount: 2 }],
    options: [],
    ...overrides,
  };
}

function json(rows: unknown[], total = rows.length): Response {
  return new Response(
    JSON.stringify({
      data: { results: rows, pagination: { total } },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

Deno.test("verified cutout hints reject stale, revoked, malformed, duplicate and unmatching rows", () => {
  const rows = [
    row("yes"),
    row("expired", { valid_until: "2026-10-19T00:00:00.000Z" }),
    row("revoked", { revoked_at: "2026-10-19T00:00:00.000Z" }),
    row("pending", { approval_status: "pending" }),
    row("wrong-leaf", { catalog_leaf_category: "Прожекторы" }),
    row("range-miss", {
      cutout_kind: "range",
      cutout_min_mm: 91,
      cutout_max_mm: 110,
    }),
    row("url-spoof", { catalog_url: "https://evil.example/product" }),
    row("yes", { article: "OTHER" }),
    row("range", {
      cutout_kind: "range",
      cutout_min_mm: 90,
      cutout_max_mm: 110,
    }),
  ];
  assertEquals(
    selectVerifiedCutoutHints(rows, 90, "Светильники", now).map((
      { productId },
    ) => productId),
    ["yes", "range"],
  );
  assertEquals(selectVerifiedCutoutHints(rows, 0, "Светильники", now), []);
  assertEquals(
    selectVerifiedCutoutHints(
      Array.from({ length: 10 }, (_, i) => row(`item-${i}`)),
      90,
      "Светильники",
      now,
    ).length,
    8,
  );
});

Deno.test("private cutout hint discovers an exact card beyond the four-page leaf window", async () => {
  const cache: ProductCache = new Map();
  const seen: string[] = [];
  const controller = new AbortController();
  const found = await retrieveVerifiedCutoutShortlist({
    hints: selectVerifiedCutoutHints(
      [row("page-five")],
      90,
      "Светильники",
      now,
    ),
    sourceProductId: "original",
    leafCategory: "Светильники",
    deps: {
      baseUrl: "https://catalog.test",
      apiToken: "test",
      signal: controller.signal,
      fetchImpl: (input) => {
        const url = new URL(String(input));
        seen.push(url.search);
        return Promise.resolve(json([raw("page-five")], 1314));
      },
    },
    cache,
    remainingMs: () => 9_000,
    hydrate: async (privateCache, ids) => {
      assertEquals(ids, ["page-five"]);
      const full = privateCache.get(ids[0]);
      if (full) full.verified_manufacturer_facts = {} as never;
    },
    accept: (product) =>
      Boolean(cache.get(product.id)?.verified_manufacturer_facts),
    target: 3,
  });
  assertEquals(found.products.map(({ id }) => id), ["page-five"]);
  assertEquals(found.interrupted, false);
  assertEquals(seen.length, 1);
  assert(seen[0].includes("article=ART-page-five"));
  assert(
    seen[0].includes(
      "category=%D0%A1%D0%B2%D0%B5%D1%82%D0%B8%D0%BB%D1%8C%D0%BD%D0%B8%D0%BA%D0%B8",
    ),
  );
  assert(seen[0].includes("per_page=50"));
});

Deno.test("live identity, canonical URL, leaf, stock and price are strict postfilters", async () => {
  const variants: Array<[string, Record<string, unknown>]> = [
    ["different id", { id: "spoof" }],
    ["different article", { article: "WRONG" }],
    ["different url", { url: liveUrl("other") }],
    ["different leaf", { category: "Уличные прожекторы" }],
    ["zero stock", { warehouses: [{ city: "Астана", amount: 0 }] }],
    ["missing stock", { warehouses: [] }],
    ["zero price", { price: 0 }],
    ["over budget", { price: 3_000 }],
    ["restricted", {
      options: [{ key: "ogranichennyy_prosmotr", value_ru: "Да" }],
    }],
  ];
  for (const [label, change] of variants) {
    const cache: ProductCache = new Map();
    const controller = new AbortController();
    let hydrated = 0;
    const result = await retrieveVerifiedCutoutShortlist({
      hints: selectVerifiedCutoutHints(
        [row("candidate")],
        90,
        "Светильники",
        now,
      ),
      sourceProductId: "original",
      leafCategory: "Светильники",
      maxPrice: 2_000,
      deps: {
        baseUrl: "https://catalog.test",
        apiToken: "test",
        signal: controller.signal,
        fetchImpl: () => Promise.resolve(json([raw("candidate", change)])),
      },
      cache,
      remainingMs: () => 9_000,
      hydrate: async () => {
        hydrated++;
      },
      accept: () => true,
      target: 3,
    });
    assertEquals(result.products.length, 0, label);
    assertEquals(hydrated, 0, label);
  }
});

Deno.test("shortlist uses the same final assessor after hydration", async () => {
  const cache: ProductCache = new Map();
  const controller = new AbortController();
  const accepted: ProductRef[] = [];
  const result = await retrieveVerifiedCutoutShortlist({
    hints: selectVerifiedCutoutHints(
      [row("candidate")],
      90,
      "Светильники",
      now,
    ),
    sourceProductId: "original",
    leafCategory: "Светильники",
    deps: {
      baseUrl: "https://catalog.test",
      apiToken: "test",
      signal: controller.signal,
      fetchImpl: () => Promise.resolve(json([raw("candidate")])),
    },
    cache,
    remainingMs: () => 9_000,
    hydrate: async () => {},
    accept: (product) => {
      accepted.push(product);
      return false;
    },
    target: 3,
  });
  assertEquals(accepted.map(({ id }) => id), ["candidate"]);
  assertEquals(result.products, []);
  assertEquals(result.rejected, 1);
});

Deno.test("shared budget counts hidden recovery, retries and both phases under twenty", async () => {
  let upstreamCalls = 0;
  let initialRateLimit = true;
  const budget = createReplacementCatalogBudget({
    deadlineMs: 9_000,
    fetchImpl: (input) => {
      upstreamCalls++;
      const url = new URL(String(input));
      if (initialRateLimit) {
        initialRateLimit = false;
        return Promise.resolve(new Response("", { status: 429 }));
      }
      if (url.searchParams.get("page") === "2") {
        return Promise.resolve(json([raw("candidate")], 151));
      }
      return Promise.resolve(json([], 151));
    },
  });
  try {
    const cache: ProductCache = new Map();
    const search = await executeSearchCatalog({
      mode: "by_article",
      article: "ART-candidate",
      per_page: 50,
    }, {
      baseUrl: "https://catalog.test",
      apiToken: "test",
      signal: budget.signal,
      fetchImpl: budget.shortlistFetch,
    }, cache);
    assertEquals(search.ok, true);
    assertEquals(budget.stats().shortlistRequests, 4);
    assertEquals(upstreamCalls, 4);
    // The shortlist can use at most eight physical requests; the fallback
    // shares the same twenty-call pool rather than resetting its own counter.
    for (let i = 0; i < 4; i++) {
      await budget.shortlistFetch("https://catalog.test/extra");
    }
    await assertRejects(() =>
      budget.shortlistFetch("https://catalog.test/over-shortlist")
    );
    assertEquals(budget.stats().shortlistCapReached, true);
    assertEquals(budget.remainingRequests(), 12);
    for (let i = 0; i < 12; i++) {
      await budget.fallbackFetch("https://catalog.test/fallback");
    }
    await assertRejects(() =>
      budget.fallbackFetch("https://catalog.test/over-total")
    );
    assertEquals(budget.stats().totalRequests, 20);
    assertEquals(budget.stats().totalCapReached, true);
    assertEquals(upstreamCalls, 20);
  } finally {
    budget.close();
  }
});

Deno.test("deadline aborts in-flight catalog work without admitting a late shortlist card", async () => {
  const cache: ProductCache = new Map();
  const budget = createReplacementCatalogBudget({
    deadlineMs: 30,
    fetchImpl: (_input, init) =>
      new Promise((_resolve, reject) => {
        const cancel = () => reject(new DOMException("Aborted", "AbortError"));
        init?.signal?.addEventListener("abort", cancel, { once: true });
        if (init?.signal?.aborted) cancel();
      }),
  });
  try {
    const result = await retrieveVerifiedCutoutShortlist({
      hints: selectVerifiedCutoutHints(
        [row("candidate")],
        90,
        "Светильники",
        now,
      ),
      sourceProductId: "original",
      leafCategory: "Светильники",
      deps: {
        baseUrl: "https://catalog.test",
        apiToken: "test",
        signal: budget.signal,
        fetchImpl: budget.shortlistFetch,
      },
      cache,
      remainingMs: () => 9_000,
      hydrate: async () => {},
      accept: () => true,
      target: 3,
    });
    assertEquals(result.products, []);
    assertEquals(result.interrupted, true);
    assertEquals(budget.stats().deadlineExpired, true);
    assertEquals(budget.remainingMs(), 0);
  } finally {
    budget.close();
  }
});

Deno.test("non-cooperative search and hydrate both settle at the shared deadline", async () => {
  for (const hung of ["search", "hydrate"] as const) {
    const cache: ProductCache = new Map();
    const budget = createReplacementCatalogBudget({ deadlineMs: 30 });
    let release: (() => void) | undefined;
    const latch = new Promise<void>((resolve) => {
      release = resolve;
    });
    let lateCache: ProductCache | undefined;
    try {
      const began = Date.now();
      const result = await retrieveVerifiedCutoutShortlist({
        hints: selectVerifiedCutoutHints(
          [row("candidate")],
          90,
          "Светильники",
          now,
        ),
        sourceProductId: "original",
        leafCategory: "Светильники",
        deps: {
          baseUrl: "https://catalog.test",
          apiToken: "test",
          signal: budget.signal,
        },
        cache,
        remainingMs: () => 9_000,
        search: async (_input, _deps, privateCache) => {
          lateCache = privateCache;
          if (hung === "search") await latch;
          privateCache.set("candidate", {
            id: "candidate",
            article: "ART-candidate",
            pagetitle: "Светильник встраиваемый",
            url: liveUrl("candidate"),
            vendor: null,
            price: 1_000,
            stock: "in_stock",
            leaf_category: "Светильники",
            warehouse_evidence: "positive",
            warehouses: [{ city: "Астана", qty: 2 }],
            short_traits: [],
          });
          return {
            tool: "search_catalog",
            ok: true,
            mode: "by_article",
            results: [{
              id: "candidate",
              article: "ART-candidate",
              pagetitle: "Светильник встраиваемый",
              vendor: null,
              price: 1_000,
              stock: "in_stock",
              leaf_category: "Светильники",
              warehouses: [{ city: "Астана", qty: 2 }],
              short_traits: [],
            }],
            total: 1,
          };
        },
        hydrate: async (privateCache) => {
          lateCache = privateCache;
          if (hung === "hydrate") await latch;
          const full = privateCache.get("candidate");
          if (full) full.verified_manufacturer_facts = {} as never;
        },
        accept: () => true,
        target: 3,
      });
      assert(Date.now() - began < 500, hung);
      assertEquals(result.interrupted, true, hung);
      assertEquals(result.products, [], hung);
      assertEquals(cache.size, 0, hung);
      release?.();
      await Promise.resolve();
      await Promise.resolve();
      assertEquals(cache.size, 0, `${hung}: late shared-cache write`);
      assert(lateCache !== cache);
    } finally {
      budget.close();
      release?.();
    }
  }
});

Deno.test("three fast matches hydrate without scheduling a fourth hanging article", async () => {
  const cache: ProductCache = new Map();
  const controller = new AbortController();
  let slowStarted = false;
  const began = Date.now();
  const result = await retrieveVerifiedCutoutShortlist({
    hints: selectVerifiedCutoutHints(
      [row("a"), row("b"), row("c"), row("slow"), row("later")],
      90,
      "Светильники",
      now,
    ),
    sourceProductId: "original",
    leafCategory: "Светильники",
    deps: {
      baseUrl: "https://catalog.test",
      apiToken: "test",
      signal: controller.signal,
    },
    cache,
    remainingMs: () => 9_000,
    search: async (query, _deps, privateCache) => {
      const id = query.article!.slice(4);
      if (id === "slow") {
        slowStarted = true;
        await new Promise<void>(() => {});
      }
      if (id === "c") {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      privateCache.set(id, {
        id,
        article: `ART-${id}`,
        pagetitle: `Светильник ${id}`,
        url: liveUrl(id),
        vendor: null,
        price: 1_000,
        stock: "in_stock",
        leaf_category: "Светильники",
        warehouse_evidence: "positive",
        warehouses: [{ city: "Астана", qty: 2 }],
        short_traits: [],
      });
      return {
        tool: "search_catalog",
        ok: true,
        mode: "by_article",
        total: 1,
        results: [{
          id,
          article: `ART-${id}`,
          pagetitle: `Светильник ${id}`,
          vendor: null,
          price: 1_000,
          stock: "in_stock",
          leaf_category: "Светильники",
          warehouses: [{ city: "Астана", qty: 2 }],
          short_traits: [],
        }],
      };
    },
    hydrate: async (privateCache, ids) => {
      assertEquals(ids.length, 3);
      for (const id of ids) {
        const full = privateCache.get(id);
        if (full) full.verified_manufacturer_facts = {} as never;
      }
    },
    accept: (product) =>
      Boolean(cache.get(product.id)?.verified_manufacturer_facts),
    target: 3,
  });
  assertEquals(slowStarted, false);
  assert(Date.now() - began < 500);
  assertEquals(result.products.map(({ id }) => id).sort(), ["a", "b", "c"]);
  assertEquals(result.interrupted, false);
  assertEquals(cache.size, 3);
});

Deno.test("one fast match survives a hanging sibling using the reserved hydration window", async () => {
  const cache: ProductCache = new Map();
  const budget = createReplacementCatalogBudget({ deadlineMs: 1_500 });
  try {
    const began = Date.now();
    const result = await retrieveVerifiedCutoutShortlist({
      hints: selectVerifiedCutoutHints(
        [row("good"), row("slow")],
        90,
        "Светильники",
        now,
      ),
      sourceProductId: "original",
      leafCategory: "Светильники",
      deps: {
        baseUrl: "https://catalog.test",
        apiToken: "test",
        signal: budget.signal,
      },
      cache,
      remainingMs: budget.remainingMs,
      search: async (query, _deps, privateCache) => {
        if (query.article === "ART-slow") await new Promise<void>(() => {});
        privateCache.set("good", {
          id: "good",
          article: "ART-good",
          pagetitle: "Светильник good",
          url: liveUrl("good"),
          vendor: null,
          price: 1_000,
          stock: "in_stock",
          leaf_category: "Светильники",
          warehouse_evidence: "positive",
          warehouses: [{ city: "Астана", qty: 2 }],
          short_traits: [],
        });
        return {
          tool: "search_catalog",
          ok: true,
          mode: "by_article",
          total: 1,
          results: [{
            id: "good",
            article: "ART-good",
            pagetitle: "Светильник good",
            vendor: null,
            price: 1_000,
            stock: "in_stock",
            leaf_category: "Светильники",
            warehouses: [{ city: "Астана", qty: 2 }],
            short_traits: [],
          }],
        };
      },
      hydrate: async (privateCache) => {
        const full = privateCache.get("good");
        if (full) full.verified_manufacturer_facts = {} as never;
      },
      accept: (product) =>
        Boolean(cache.get(product.id)?.verified_manufacturer_facts),
      target: 3,
    });
    assert(Date.now() - began < 1_200);
    assertEquals(result.products.map(({ id }) => id), ["good"]);
    assertEquals(result.interrupted, true);
    assertEquals(budget.stats().deadlineExpired, false);
  } finally {
    budget.close();
  }
});

Deno.test("later approved hints remain reachable after two rejected hydration waves", async () => {
  const cache: ProductCache = new Map();
  const controller = new AbortController();
  let hydrationCalls = 0;
  const result = await retrieveVerifiedCutoutShortlist({
    hints: selectVerifiedCutoutHints(
      Array.from({ length: 8 }, (_, i) => row(String(i + 1))),
      90,
      "Светильники",
      now,
    ),
    sourceProductId: "original",
    leafCategory: "Светильники",
    deps: {
      baseUrl: "https://catalog.test",
      apiToken: "test",
      signal: controller.signal,
    },
    cache,
    remainingMs: () => 9_000,
    search: async (query, _deps, privateCache) => {
      const id = query.article!.slice(4);
      const full = {
        id,
        article: `ART-${id}`,
        pagetitle: `Светильник ${id}`,
        url: liveUrl(id),
        vendor: null,
        price: 1_000,
        stock: "in_stock" as const,
        leaf_category: "Светильники",
        warehouse_evidence: "positive" as const,
        warehouses: [{ city: "Астана", qty: 2 }],
        short_traits: [],
      };
      privateCache.set(id, full);
      return {
        tool: "search_catalog",
        ok: true,
        mode: "by_article",
        total: 1,
        results: [full],
      };
    },
    hydrate: async (privateCache, ids) => {
      hydrationCalls++;
      for (const id of ids) {
        if (Number(id) >= 7) {
          const full = privateCache.get(id);
          if (full) full.verified_manufacturer_facts = {} as never;
        }
      }
    },
    accept: (product) =>
      Boolean(cache.get(product.id)?.verified_manufacturer_facts),
    target: 3,
  });
  assertEquals(result.products.map(({ id }) => id).sort(), ["7", "8"]);
  assertEquals(hydrationCalls, 3);
  assertEquals(result.interrupted, false);
});

Deno.test("partial shortlist keeps accepted evidence but never declares an empty catalog", async () => {
  const cache: ProductCache = new Map();
  const budget = createReplacementCatalogBudget({
    deadlineMs: 9_000,
    fetchImpl: (input) => {
      const url = new URL(String(input));
      if (url.searchParams.get("article") === "ART-bad") {
        return Promise.resolve(new Response("", { status: 429 }));
      }
      return Promise.resolve(json([raw("good")], 1));
    },
  });
  try {
    const result = await retrieveVerifiedCutoutShortlist({
      hints: selectVerifiedCutoutHints(
        [row("good"), row("bad")],
        90,
        "Светильники",
        now,
      ),
      sourceProductId: "original",
      leafCategory: "Светильники",
      deps: {
        baseUrl: "https://catalog.test",
        apiToken: "test",
        fetchImpl: budget.shortlistFetch,
        signal: budget.signal,
      },
      cache,
      remainingMs: budget.remainingMs,
      hydrate: async () => {},
      accept: () => true,
      target: 3,
    });
    assertEquals(result.products.map(({ id }) => id), ["good"]);
    assertEquals(result.interrupted, true);
    assertEquals(result.catalogErrors, 1);
    assertEquals(budget.stats().shortlistRequests, 4);
    assertEquals(budget.remainingRequests(), 16);
  } finally {
    budget.close();
  }
});

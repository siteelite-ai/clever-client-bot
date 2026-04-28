// chat-consultant-v2 / s-price_test.ts
// Stage 6E tests. Price branch (probe-then-fetch). ZERO real 220volt data.
//
// Покрытие (15 кейсов из плана 6E v2):
//   1. total=0 → empty
//   2. total=5, cheapest → fetch all, ASC, products=5
//   3. total=7, expensive → граница ≤7, DESC
//   4. total=8 → граница, fetch top, return 3, totalCount=8
//   5. total=50 → граница, fetch top, return 3, totalCount=50
//   6. total=51 → граница, clarify
//   7. total=705 → clarify, slot.options=top-5 facet values
//   8. range {min,max}, total=4 → fetch all, ASC, БЕЗ принудительного clarify
//   9. domain_check=out_of_domain → shortcut, БЕЗ API
//  10. all products price=0 → all_zero_price
//  11. probe HTTP error → error
//  12. fetch (после probe.ok) HTTP error → error
//  13. non-ASCII facet key (Q3 recovery) → optionAliases применены
//  14. clarify slot.options[].payload содержит facetKey/facetValue (контракт)
//  15. autoNarrowingAttempts === 0 в любом сценарии (invariant)

import { assertEquals, assert, assertExists } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { priceBranch, sortByPrice, filterPriceZero, pickBestFacetForClarify } from "./s-price.ts";
import type {
  ApiClientDeps,
  RawProduct,
  RawOption,
} from "./catalog/api-client.ts";
import type { Intent } from "./types.ts";

// ─── Helpers ────────────────────────────────────────────────────────────────

function intent(overrides: Partial<Intent> = {}): Intent {
  return {
    intent: "catalog",
    has_sku: false,
    sku_candidate: null,
    price_intent: "cheapest",
    category_hint: null,
    search_modifiers: [],
    critical_modifiers: [],
    is_replacement: false,
    domain_check: "in_domain",
    ...overrides,
  };
}

function p(id: number, price: number, title = `prod-${id}`): RawProduct {
  return {
    id,
    name: title,
    pagetitle: title,
    url: `https://t.local/p/${id}`,
    price,
    vendor: "TBrand",
    article: `SKU${id}`,
  };
}

interface MockResp {
  results: RawProduct[];
  total?: number;
}

/**
 * Мок api-клиента. Каждому call отдаёт результат от handler.
 * Считает вызовы.
 */
function mockApiClient(
  handler: (url: string, params: URLSearchParams, callIdx: number) => MockResp | "http_500" | "timeout",
): { deps: ApiClientDeps; calls: { url: string; params: URLSearchParams }[] } {
  const calls: { url: string; params: URLSearchParams }[] = [];
  const fakeFetch: typeof fetch = (input, init) => {
    const url = typeof input === "string" ? input : (input as URL).toString();
    const qIdx = url.indexOf("?");
    const params = new URLSearchParams(qIdx >= 0 ? url.slice(qIdx + 1) : "");
    const callIdx = calls.length;
    calls.push({ url, params });
    const r = handler(url, params, callIdx);
    if (r === "timeout") {
      return new Promise((_resolve, reject) => {
        const sig = init?.signal;
        sig?.addEventListener("abort", () => {
          const e = new Error("aborted");
          e.name = "AbortError";
          reject(e);
        });
      });
    }
    if (r === "http_500") {
      return Promise.resolve(new Response("err", { status: 500 }));
    }
    const body = JSON.stringify({
      data: { results: r.results, total: r.total ?? r.results.length },
    });
    return Promise.resolve(
      new Response(body, { status: 200, headers: { "content-type": "application/json" } }),
    );
  };
  return {
    deps: {
      baseUrl: "https://t.local/api",
      apiToken: "test",
      fetch: fakeFetch,
      timeoutMs: { products: 100, categoryOptions: 100 },
    },
    calls,
  };
}

function makeFacetOption(
  key: string,
  values: Array<{ value: string; count: number }>,
): RawOption {
  return {
    key,
    caption: key,
    caption_ru: key,
    values: values.map((v) => ({ value_ru: v.value, value: v.value, count: v.count })),
  };
}

// ─── Pure unit-tests первыми ────────────────────────────────────────────────

Deno.test("sortByPrice: ASC stable", () => {
  const arr = [p(1, 200), p(2, 100), p(3, 100), p(4, 50)];
  const sorted = sortByPrice(arr, "asc");
  assertEquals(sorted.map((x) => x.id), [4, 2, 3, 1]);
  // immutability
  assertEquals(arr.map((x) => x.id), [1, 2, 3, 4]);
});

Deno.test("sortByPrice: DESC stable", () => {
  const arr = [p(1, 100), p(2, 300), p(3, 100), p(4, 200)];
  const sorted = sortByPrice(arr, "desc");
  assertEquals(sorted.map((x) => x.id), [2, 4, 1, 3]);
});

Deno.test("filterPriceZero: убирает price<=0, считает leak", () => {
  const arr = [p(1, 100), p(2, 0), p(3, -5), p(4, 200)];
  const [filtered, leak] = filterPriceZero(arr);
  assertEquals(filtered.length, 2);
  assertEquals(leak, 2);
});

Deno.test("pickBestFacetForClarify: выбирает группу с >2 разделяющими значениями", () => {
  const opts: RawOption[] = [
    makeFacetOption("type", [
      { value: "a", count: 100 },
      { value: "b", count: 200 },
      { value: "c", count: 150 },
    ]),
    makeFacetOption("brand", [
      { value: "x", count: 700 }, // count >= total → не разделяет
    ]),
  ];
  const r = pickBestFacetForClarify(opts, 700, 5);
  assertExists(r);
  assertEquals(r!.option.key, "type");
  assertEquals(r!.values.length, 3);
  // ranked by count DESC
  assertEquals(r!.values.map((v) => v.raw), ["b", "c", "a"]);
});

Deno.test("pickBestFacetForClarify: пустой/одно значение → null", () => {
  assertEquals(pickBestFacetForClarify([], 100), null);
  const single = [makeFacetOption("k", [{ value: "v", count: 50 }])];
  assertEquals(pickBestFacetForClarify(single, 100), null);
});

// ─── Integration tests с mock api-client ────────────────────────────────────

Deno.test("Test 1: total=0 → empty", async () => {
  const m = mockApiClient(() => ({ results: [], total: 0 }));
  const r = await priceBranch(
    { pagetitle: "Cat", query: "q", intent: intent({ price_intent: "cheapest" }) },
    { apiClient: m.deps },
  );
  assertEquals(r.status, "empty");
  assertEquals(r.products.length, 0);
  assertEquals(r.totalCount, 0);
  assertEquals(r.clarifySlot, null);
  assertEquals(r.autoNarrowingAttempts, 0);
});

Deno.test("Test 2: total=5, cheapest → fetch all, ASC", async () => {
  // 5 товаров с разной ценой
  const all = [p(1, 500), p(2, 100), p(3, 300), p(4, 200), p(5, 400)];
  const m = mockApiClient((_url, _params, idx) => {
    if (idx === 0) return { results: [all[0]], total: 5 }; // probe perPage=1
    return { results: all, total: 5 }; // fetch all
  });
  const r = await priceBranch(
    { pagetitle: "Cat", query: "q", intent: intent({ price_intent: "cheapest" }) },
    { apiClient: m.deps },
  );
  assertEquals(r.status, "ok");
  assertEquals(r.totalCount, 5);
  assertEquals(r.branch, "show_all");
  assertEquals(r.products.map((x) => x.price), [100, 200, 300, 400, 500]);
  assertEquals(r.autoNarrowingAttempts, 0);
});

Deno.test("Test 3: total=7, expensive → граница ≤7, DESC", async () => {
  const all = [p(1, 100), p(2, 700), p(3, 300), p(4, 500), p(5, 200), p(6, 600), p(7, 400)];
  const m = mockApiClient((_url, _params, idx) => {
    if (idx === 0) return { results: [all[0]], total: 7 };
    return { results: all, total: 7 };
  });
  const r = await priceBranch(
    { pagetitle: "Cat", query: "q", intent: intent({ price_intent: "expensive" }) },
    { apiClient: m.deps },
  );
  assertEquals(r.status, "ok");
  assertEquals(r.branch, "show_all");
  assertEquals(r.products.length, 7);
  assertEquals(r.products[0].price, 700);
  assertEquals(r.products[6].price, 100);
});

Deno.test("Test 4: total=8 → граница >7, fetch top, return 3, totalCount=8", async () => {
  // probe возвращает total=8; fetch top — 8 товаров (или 10 — по запросу)
  const all = Array.from({ length: 8 }, (_, i) => p(i + 1, (i + 1) * 100));
  const m = mockApiClient((_url, _params, idx) => {
    if (idx === 0) return { results: [all[0]], total: 8 };
    return { results: all, total: 8 };
  });
  const r = await priceBranch(
    { pagetitle: "Cat", query: "q", intent: intent({ price_intent: "cheapest" }) },
    { apiClient: m.deps },
  );
  assertEquals(r.status, "ok");
  assertEquals(r.branch, "show_top");
  assertEquals(r.totalCount, 8);
  assertEquals(r.products.length, 3);
  assertEquals(r.products.map((x) => x.price), [100, 200, 300]);
});

Deno.test("Test 5: total=50 → граница ≤50, fetch top, return 3, totalCount=50", async () => {
  const sample = Array.from({ length: 10 }, (_, i) => p(i + 1, (10 - i) * 50));
  const m = mockApiClient((_url, _params, idx) => {
    if (idx === 0) return { results: [sample[0]], total: 50 };
    return { results: sample, total: 50 };
  });
  const r = await priceBranch(
    { pagetitle: "Cat", query: "q", intent: intent({ price_intent: "cheapest" }) },
    { apiClient: m.deps },
  );
  assertEquals(r.status, "ok");
  assertEquals(r.branch, "show_top");
  assertEquals(r.totalCount, 50);
  assertEquals(r.products.length, 3);
});

Deno.test("Test 6: total=51 → граница >50, clarify slot создан", async () => {
  const facetOptions: RawOption[] = [
    makeFacetOption("type", [
      { value: "A", count: 20 },
      { value: "B", count: 31 },
    ]),
  ];
  const m = mockApiClient(() => ({ results: [p(1, 100)], total: 51 }));
  const r = await priceBranch(
    {
      pagetitle: "Cat",
      query: "q",
      intent: intent({ price_intent: "cheapest" }),
      facetOptions,
    },
    { apiClient: m.deps, newSlotId: () => "slot_test_id", now: () => 1_700_000_000_000 },
  );
  assertEquals(r.status, "clarify");
  assertEquals(r.branch, "clarify");
  assertEquals(r.totalCount, 51);
  assertEquals(r.products.length, 0);
  assertExists(r.clarifySlot);
  assertEquals(r.clarifySlot!.type, "price_clarify");
  assertEquals(r.clarifySlot!.options.length, 2);
  // Только probe, никаких fetch.
  assertEquals(m.calls.length, 1);
});

Deno.test("Test 7: total=705 → clarify, top-5 facet values", async () => {
  const facetOptions: RawOption[] = [
    makeFacetOption("kind", [
      { value: "v1", count: 100 },
      { value: "v2", count: 200 },
      { value: "v3", count: 50 },
      { value: "v4", count: 80 },
      { value: "v5", count: 150 },
      { value: "v6", count: 30 },
      { value: "v7", count: 90 },
    ]),
  ];
  const m = mockApiClient(() => ({ results: [p(1, 100)], total: 705 }));
  const r = await priceBranch(
    {
      pagetitle: "Cat",
      query: "q",
      intent: intent({ price_intent: "cheapest" }),
      facetOptions,
    },
    { apiClient: m.deps },
  );
  assertEquals(r.status, "clarify");
  assertEquals(r.totalCount, 705);
  assertExists(r.clarifySlot);
  assertEquals(r.clarifySlot!.options.length, 5); // top-5
  // Top по count DESC: 200, 150, 100, 90, 80 → v2, v5, v1, v7, v4
  assertEquals(r.clarifySlot!.options.map((o) => o.label), ["v2", "v5", "v1", "v7", "v4"]);
});

Deno.test("Test 8: price_intent=range, total=4 → fetch all, ASC, БЕЗ clarify", async () => {
  const all = [p(1, 2200), p(2, 2400), p(3, 2100), p(4, 2300)];
  const m = mockApiClient((_url, params, idx) => {
    // Проверяем, что minPrice/maxPrice пробрасываются.
    if (idx === 1) {
      assertEquals(params.get("min_price"), "2000");
      assertEquals(params.get("max_price"), "2500");
    }
    if (idx === 0) return { results: [all[0]], total: 4 };
    return { results: all, total: 4 };
  });
  const r = await priceBranch(
    {
      pagetitle: "Cat",
      query: "q",
      intent: intent({
        price_intent: "range",
        price_range: { min: 2000, max: 2500 },
      }),
    },
    { apiClient: m.deps },
  );
  // КРИТИЧНО: range НЕ должен принудительно создавать clarify.
  assertEquals(r.status, "ok");
  assertEquals(r.branch, "show_all");
  assertEquals(r.products.length, 4);
  // ASC по умолчанию для range.
  assertEquals(r.products.map((x) => x.price), [2100, 2200, 2300, 2400]);
});

Deno.test("Test 9: domain_check=out_of_domain → shortcut, БЕЗ API", async () => {
  let called = false;
  const m = mockApiClient(() => {
    called = true;
    return { results: [], total: 0 };
  });
  const r = await priceBranch(
    {
      pagetitle: "Cat",
      query: "q",
      intent: intent({ price_intent: "cheapest", domain_check: "out_of_domain" }),
    },
    { apiClient: m.deps },
  );
  assertEquals(r.status, "out_of_domain");
  assertEquals(called, false);
  assertEquals(m.calls.length, 0);
});

Deno.test("Test 10: probe вернул товары, но все price=0 → all_zero_price", async () => {
  const m = mockApiClient(() => ({
    results: [p(1, 0), p(2, 0)],
    total: 2,
  }));
  const r = await priceBranch(
    { pagetitle: "Cat", query: "q", intent: intent({ price_intent: "cheapest" }) },
    { apiClient: m.deps },
  );
  assertEquals(r.status, "all_zero_price");
  assertEquals(r.products.length, 0);
  assert(r.zeroPriceLeak >= 2);
});

Deno.test("Test 11: probe HTTP 500 → error", async () => {
  const m = mockApiClient(() => "http_500");
  const r = await priceBranch(
    { pagetitle: "Cat", query: "q", intent: intent({ price_intent: "cheapest" }) },
    { apiClient: m.deps },
  );
  assertEquals(r.status, "error");
});

Deno.test("Test 12: probe ok, fetch HTTP 500 → error (totalCount preserved)", async () => {
  const m = mockApiClient((_url, _params, idx) => {
    if (idx === 0) return { results: [p(1, 100)], total: 5 };
    return "http_500";
  });
  const r = await priceBranch(
    { pagetitle: "Cat", query: "q", intent: intent({ price_intent: "cheapest" }) },
    { apiClient: m.deps },
  );
  assertEquals(r.status, "error");
  assertEquals(r.totalCount, 5);
});

Deno.test("Test 13: optionAliases пробрасываются в API запрос (Q3)", async () => {
  // Запрос с не-ASCII alias-ключом.
  const m = mockApiClient((_url, params, idx) => {
    if (idx === 0) {
      // Probe должен включать наш фасет-фильтр (через alias).
      // Проверяем, что хотя бы один options[...]= параметр есть.
      const hasOption = Array.from(params.keys()).some((k) => k.startsWith("options["));
      assert(hasOption, "options[*] must be propagated to API");
    }
    return { results: [p(1, 100)], total: 3 };
  });
  const r = await priceBranch(
    {
      pagetitle: "Cat",
      query: "q",
      intent: intent({ price_intent: "cheapest" }),
      optionFilters: { color: ["red"] },
      optionAliases: { color: ["color", "цвет__tүs"] },
    },
    { apiClient: m.deps },
  );
  assertEquals(r.status, "ok");
});

Deno.test("Test 14: clarify slot.options[].payload содержит facetKey/facetValue", async () => {
  const facetOptions: RawOption[] = [
    makeFacetOption("brand", [
      { value: "BrandA", count: 30 },
      { value: "BrandB", count: 25 },
    ]),
  ];
  const m = mockApiClient(() => ({ results: [p(1, 100)], total: 100 }));
  const r = await priceBranch(
    {
      pagetitle: "Cat",
      query: "q",
      intent: intent({ price_intent: "cheapest" }),
      facetOptions,
    },
    { apiClient: m.deps },
  );
  assertEquals(r.status, "clarify");
  const opt0 = r.clarifySlot!.options[0];
  assertEquals(opt0.label, "BrandA");
  assertEquals(opt0.value, "branda");
  assertEquals(opt0.payload?.facetKey, "brand");
  assertEquals(opt0.payload?.facetValue, "BrandA");
});

Deno.test("Test 15: autoNarrowingAttempts === 0 во ВСЕХ статусах (invariant)", async () => {
  const scenarios: Array<{ name: string; mock: () => MockResp | "http_500" }> = [
    { name: "ok", mock: () => ({ results: [p(1, 100)], total: 5 }) },
    { name: "empty", mock: () => ({ results: [], total: 0 }) },
    { name: "clarify", mock: () => ({ results: [p(1, 100)], total: 100 }) },
    { name: "all_zero", mock: () => ({ results: [p(1, 0)], total: 1 }) },
    { name: "error", mock: () => "http_500" },
  ];
  for (const s of scenarios) {
    const m = mockApiClient(() => s.mock());
    const r = await priceBranch(
      { pagetitle: "Cat", query: "q", intent: intent({ price_intent: "cheapest" }) },
      { apiClient: m.deps },
    );
    assertEquals(r.autoNarrowingAttempts, 0, `scenario=${s.name}`);
  }
  // out_of_domain shortcut
  const m2 = mockApiClient(() => ({ results: [], total: 0 }));
  const r2 = await priceBranch(
    {
      pagetitle: "Cat",
      query: "q",
      intent: intent({ price_intent: "cheapest", domain_check: "out_of_domain" }),
    },
    { apiClient: m2.deps },
  );
  assertEquals(r2.autoNarrowingAttempts, 0);
});

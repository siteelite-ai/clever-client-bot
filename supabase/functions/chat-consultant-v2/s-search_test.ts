// chat-consultant-v2 / s-search_test.ts
// Stage 6D tests. ZERO real 220volt data.

import { assertEquals, assert } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { runSearch, type SSearchInput } from "./s-search.ts";
import type { ApiClientDeps, RawProduct } from "./catalog/api-client.ts";
import type { FacetMatchResult } from "./catalog/facet-matcher.ts";
import type { ExpansionResult, QueryAttempt } from "./query-expansion.ts";
import type { Intent } from "./types.ts";

// ─── Helpers ────────────────────────────────────────────────────────────────

function intent(overrides: Partial<Intent> = {}): Intent {
  return {
    intent: "catalog",
    has_sku: false,
    sku_candidate: null,
    price_intent: null,
    category_hint: null,
    search_modifiers: [],
    critical_modifiers: [],
    is_replacement: false,
    domain_check: "in_domain",
    ...overrides,
  };
}

function expansion(forms: Array<Partial<QueryAttempt> & { text: string }>): ExpansionResult {
  return {
    attempts: forms.map((f) => ({ form: f.form ?? "as_is_ru", text: f.text, meta: f.meta })),
    skipped: [],
    ms: 0,
  };
}

function emptyFacets(): FacetMatchResult {
  return {
    status: "no_matches",
    optionFilters: {},
    optionAliases: {},
    facetCaptions: {},
    matchedModifiers: [],
    unmatchedModifiers: [],
    source: "live",
    ms: 0,
  };
}

function withFacets(filters: Record<string, string[]>, captions: Record<string, string>): FacetMatchResult {
  const aliases: Record<string, string[]> = {};
  for (const k of Object.keys(filters)) aliases[k] = [k];
  return {
    status: "ok",
    optionFilters: filters,
    optionAliases: aliases,
    facetCaptions: captions,
    matchedModifiers: [],
    unmatchedModifiers: [],
    source: "live",
    ms: 0,
  };
}

function makeProduct(id: number, pagetitle: string, price = 1000): RawProduct {
  return {
    id,
    name: pagetitle,
    pagetitle,
    url: `https://test.local/p/${id}`,
    price,
    vendor: "TestBrand",
    article: `SKU${id}`,
  };
}

/**
 * Мок api-клиента. Принимает функцию, которая по URL и парсам решает, что вернуть.
 * Возвращает counter числа вызовов.
 */
interface MockResponse {
  results: RawProduct[];
  total?: number;
}
function mockApiClient(
  handler: (url: string, params: URLSearchParams) => MockResponse | "timeout" | "http_500",
): { deps: ApiClientDeps; calls: { url: string; params: URLSearchParams }[] } {
  const calls: { url: string; params: URLSearchParams }[] = [];
  const fakeFetch: typeof fetch = (input, init) => {
    const url = typeof input === "string" ? input : (input as URL).toString();
    const qIdx = url.indexOf("?");
    const params = new URLSearchParams(qIdx >= 0 ? url.slice(qIdx + 1) : "");
    calls.push({ url, params });
    const result = handler(url, params);
    if (result === "timeout") {
      return new Promise((_resolve, reject) => {
        const signal = init?.signal;
        signal?.addEventListener("abort", () => {
          const err = new Error("aborted");
          err.name = "AbortError";
          reject(err);
        });
      });
    }
    if (result === "http_500") {
      return Promise.resolve(new Response("err", { status: 500 }));
    }
    const body = JSON.stringify({
      data: { results: result.results, total: result.total ?? result.results.length },
    });
    return Promise.resolve(
      new Response(body, { status: 200, headers: { "content-type": "application/json" } }),
    );
  };
  return {
    deps: {
      baseUrl: "https://test.local/api",
      apiToken: "test",
      fetch: fakeFetch,
      timeoutMs: { products: 100, categoryOptions: 100 },
    },
    calls,
  };
}

function input(overrides: Partial<SSearchInput>): SSearchInput {
  return {
    pagetitle: "TestCategory",
    expansion: expansion([{ text: "тест", form: "as_is_ru" }]),
    facetMatch: emptyFacets(),
    intent: intent(),
    ...overrides,
  };
}

// ─── Tests ──────────────────────────────────────────────────────────────────

Deno.test("Test 1: первая форма даёт ≥1 → ok, остальные не пробуются", async () => {
  const m = mockApiClient(() => ({ results: [makeProduct(1, "тест продукт")] }));
  const r = await runSearch(
    input({
      expansion: expansion([
        { text: "тест", form: "as_is_ru" },
        { text: "test", form: "en_translation" },
      ]),
    }),
    { apiClient: m.deps },
  );
  assertEquals(r.status, "ok");
  assertEquals(r.products.length, 1);
  assertEquals(r.attempts.length, 1);
  assertEquals(r.winningForm, "as_is_ru");
  assertEquals(m.calls.length, 1);
});

Deno.test("Test 2: as_is_ru=0, lexicon_canonical=≥1 → ok, attempts=2", async () => {
  const m = mockApiClient((_url, params) => {
    const q = params.get("query") ?? "";
    if (q === "тест") return { results: [] };
    if (q === "канонический") return { results: [makeProduct(2, "канонический продукт")] };
    return { results: [] };
  });
  const r = await runSearch(
    input({
      expansion: expansion([
        { text: "тест", form: "as_is_ru" },
        { text: "канонический", form: "lexicon_canonical" },
      ]),
    }),
    { apiClient: m.deps },
  );
  assertEquals(r.status, "ok");
  assertEquals(r.attempts.length, 2);
  assertEquals(r.winningForm, "lexicon_canonical");
});

Deno.test("Test 3: en_translation выручает после двух 0", async () => {
  const m = mockApiClient((_url, params) => {
    const q = params.get("query") ?? "";
    if (q === "english query") return { results: [makeProduct(3, "english query result")] };
    return { results: [] };
  });
  const r = await runSearch(
    input({
      expansion: expansion([
        { text: "тест", form: "as_is_ru" },
        { text: "канон", form: "lexicon_canonical" },
        { text: "english query", form: "en_translation" },
      ]),
    }),
    { apiClient: m.deps },
  );
  assertEquals(r.status, "ok");
  assertEquals(r.winningForm, "en_translation");
  assertEquals(r.attempts.length, 3);
});

Deno.test("Test 4: word-boundary отбрасывает substring (лак ≠ лакокрасочный)", async () => {
  // API возвращает товар с pagetitle="лакокрасочный материал", запрос "лак".
  // catalog/search.ts должен отбросить → status='empty' (фасетов нет, soft fallback не нужен).
  const m = mockApiClient(() => ({
    results: [makeProduct(4, "лакокрасочный материал")],
  }));
  const r = await runSearch(
    input({
      expansion: expansion([{ text: "лак", form: "as_is_ru" }]),
    }),
    { apiClient: m.deps },
  );
  assertEquals(r.status, "empty");
  assertEquals(r.products.length, 0);
  assert(r.postFilterDropped >= 1, "post-filter должен отбросить ≥1 substring-match");
});

Deno.test("Test 5: точный word-match проходит", async () => {
  const m = mockApiClient(() => ({
    results: [makeProduct(5, "лак для пола")],
  }));
  const r = await runSearch(
    input({ expansion: expansion([{ text: "лак", form: "as_is_ru" }]) }),
    { apiClient: m.deps },
  );
  assertEquals(r.status, "ok");
  assertEquals(r.products.length, 1);
});

Deno.test("Test 6: word-boundary с не-ASCII (русское слово)", async () => {
  const m = mockApiClient(() => ({
    results: [
      makeProduct(6, "выключатель белый"),
      makeProduct(7, "выключательный механизм"), // substring-match, должен быть отброшен
    ],
  }));
  const r = await runSearch(
    input({ expansion: expansion([{ text: "выключатель", form: "as_is_ru" }]) }),
    { apiClient: m.deps },
  );
  assertEquals(r.status, "ok");
  assertEquals(r.products.length, 1);
  assertEquals(r.products[0].id, 6);
});

Deno.test("Test 7: все формы=0 + есть фасеты → soft_fallback с droppedCaption", async () => {
  // С фасетами — пусто. Без фасетов (после снятия) — есть товар.
  const m = mockApiClient((_url, params) => {
    const hasFacet = Array.from(params.keys()).some((k) => k.startsWith("options["));
    if (hasFacet) return { results: [] };
    return { results: [makeProduct(8, "тест без фасета")] };
  });
  const r = await runSearch(
    input({
      expansion: expansion([{ text: "тест", form: "as_is_ru" }]),
      facetMatch: withFacets(
        { color: ["Чёрный"] },
        { color: "Цвет" },
      ),
    }),
    { apiClient: m.deps },
  );
  assertEquals(r.status, "soft_fallback");
  assertEquals(r.softFallbackContext?.droppedFacetCaption, "Цвет");
  assertEquals(r.products.length, 1);
  assertEquals(r.winningForm, "as_is_ru");
});

Deno.test("Test 8: все формы=0 + нет фасетов → empty, softFallbackContext=null", async () => {
  const m = mockApiClient(() => ({ results: [] }));
  const r = await runSearch(
    input({
      expansion: expansion([
        { text: "несуществующее", form: "as_is_ru" },
        { text: "nonexistent", form: "en_translation" },
      ]),
    }),
    { apiClient: m.deps },
  );
  assertEquals(r.status, "empty");
  assertEquals(r.softFallbackContext, null);
  assertEquals(r.attempts.length, 2);
});

Deno.test("Test 9: domain_check=out_of_domain → status=out_of_domain, API не вызван", async () => {
  const m = mockApiClient(() => ({ results: [] }));
  const r = await runSearch(
    input({ intent: intent({ domain_check: "out_of_domain" }) }),
    { apiClient: m.deps },
  );
  assertEquals(r.status, "out_of_domain");
  assertEquals(m.calls.length, 0);
  assertEquals(r.attempts.length, 0);
});

Deno.test("Test 10: API all_zero_price → status=all_zero_price, не пробуем след. формы", async () => {
  const m = mockApiClient(() => ({
    results: [
      { ...makeProduct(10, "товар"), price: 0 },
      { ...makeProduct(11, "товар2"), price: 0 },
    ],
  }));
  const r = await runSearch(
    input({
      expansion: expansion([
        { text: "товар", form: "as_is_ru" },
        { text: "item", form: "en_translation" },
      ]),
    }),
    { apiClient: m.deps },
  );
  assertEquals(r.status, "all_zero_price");
  assertEquals(r.attempts.length, 1);  // shortcut, не пробуем en
  assertEquals(r.products.length, 0);
});

Deno.test("Test 11: все формы → http_500 → status=error", async () => {
  const m = mockApiClient(() => "http_500");
  const r = await runSearch(
    input({
      expansion: expansion([
        { text: "a", form: "as_is_ru" },
        { text: "b", form: "en_translation" },
      ]),
    }),
    { apiClient: m.deps },
  );
  assertEquals(r.status, "error");
  assertEquals(r.attempts.length, 2);
});

Deno.test("Test 12: zeroPriceLeak агрегируется по attempts", async () => {
  let call = 0;
  const m = mockApiClient(() => {
    call++;
    if (call === 1) {
      // Первая форма: 1 valid + 2 zero-price → status='ok', zero=2
      return {
        results: [
          makeProduct(20, "тест валид", 500),
          { ...makeProduct(21, "тест zero1"), price: 0 },
          { ...makeProduct(22, "тест zero2"), price: 0 },
        ],
      };
    }
    return { results: [] };
  });
  const r = await runSearch(
    input({ expansion: expansion([{ text: "тест", form: "as_is_ru" }]) }),
    { apiClient: m.deps },
  );
  assertEquals(r.status, "ok");
  assertEquals(r.products.length, 1);
  assertEquals(r.zeroPriceLeak, 2);
});

Deno.test("Test 13: optionAliases передаются в API (Q3 поддержка)", async () => {
  const m = mockApiClient(() => ({ results: [makeProduct(30, "тест alias")] }));
  await runSearch(
    input({
      expansion: expansion([{ text: "тест", form: "as_is_ru" }]),
      facetMatch: {
        status: "ok",
        optionFilters: { color_ascii: ["Синий"] },
        optionAliases: { color_ascii: ["color_ascii", "cvet__tүs"] },
        facetCaptions: { color_ascii: "Цвет" },
        matchedModifiers: ["синий"],
        unmatchedModifiers: [],
        source: "live",
        ms: 0,
      },
    }),
    { apiClient: m.deps },
  );
  // Должны быть отправлены ОБА ключа в options[].
  const params = m.calls[0].params;
  const keys = Array.from(params.keys());
  assert(keys.includes("options[color_ascii][]"), "должен быть canonical key");
  assert(keys.includes("options[cvet__tүs][]"), "должен быть alias key (Q3)");
});

Deno.test("Test 14: пустые формы → empty без вызовов API", async () => {
  const m = mockApiClient(() => ({ results: [makeProduct(40, "должен быть")] }));
  const r = await runSearch(
    input({
      expansion: {
        attempts: [
          { form: "as_is_ru", text: "" },
          { form: "kk_off", text: "   " },
        ],
        skipped: [],
        ms: 0,
      },
    }),
    { apiClient: m.deps },
  );
  assertEquals(r.status, "empty");
  assertEquals(m.calls.length, 0);
  assertEquals(r.attempts.length, 0);
});

Deno.test("Test 15: без modifiers и фасетов поиск идёт только по category, без raw query", async () => {
  const m = mockApiClient((_url, params) => {
    assertEquals(params.get("category"), "Лампы");
    assertEquals(params.get("query"), null);
    return { results: [makeProduct(50, "Школьная лампа")] };
  });

  const r = await runSearch(
    input({
      pagetitle: "Лампы",
      expansion: expansion([{ text: "найди лампы для школы", form: "as_is_ru" }]),
      intent: intent({ search_modifiers: [], critical_modifiers: [] }),
      facetMatch: emptyFacets(),
    }),
    { apiClient: m.deps },
  );

  assertEquals(r.status, "ok");
  assertEquals(r.products.length, 1);
  assertEquals(m.calls.length, 1);
});

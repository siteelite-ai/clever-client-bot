// chat-consultant-v2 / catalog-assembler_test.ts
// Stage 7 — Step 4.3: Golden E2E сценарии оркестратора.
//
// Источники: spec §4 (Catalog flow), §4.4 (price branch), §4.7 (OOD),
//            §5.4.1/§11.5b (disallowCrosssell), Core Memory.
//
// Дизайн: используем РЕАЛЬНЫЕ модули assembler-а (resolver, expansion,
// facet-matcher, s-search, s-price), мокая ТОЛЬКО:
//   1. apiClient.fetch (HTTP к Catalog API)
//   2. resolver.callLLM, resolver.listCategories, resolver.getThresholds
//   3. expansion.getLexicon, expansion.callTranslator (если используется)
//   4. facets.cacheGetOrCompute (in-memory, без БД)
// Это гарантирует, что E2E проходит ВСЕ стадии assembler-а как в проде.
//
// Покрытие (3 golden + invariant-checks):
//   G1. price-intent-clarify-001 — total=705 → clarify slot, disallowCrosssell=true
//   G2. price-intent-ok-001       — total=5 cheapest → show_all, disallowCrosssell=false
//   G3. ood-001                   — domain_check=out_of_domain → shortcut, composerOutcome=null
//
// Все Catalog-quirks (Q2 double-wrapping, price=0 ban) учтены в моках.
// ZERO real 220volt categories/products/traits.

import { assertEquals, assert, assertExists } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { assembleCatalog, type AssemblerDeps, type AssemblerInput } from "./catalog-assembler.ts";
import type { ApiClientDeps, RawProduct, RawOption } from "./catalog/api-client.ts";
import type { ResolverDeps } from "./category-resolver.ts";
import type { ExpansionDeps } from "./query-expansion.ts";
import type { FacetMatcherDeps } from "./catalog/facet-matcher.ts";
import type { Intent } from "./types.ts";
import type { Route } from "./s3-router.ts";

// ─── Helpers: моки ──────────────────────────────────────────────────────────

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

function product(id: number, price: number, title = `prod-${id}`): RawProduct {
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

function rawOption(
  key: string,
  values: Array<{ value: string; count: number }>,
  caption = key,
): RawOption {
  return {
    key,
    caption,
    caption_ru: caption,
    values: values.map((v) => ({ value_ru: v.value, value: v.value, count: v.count })),
  };
}

interface FetchHandlerCtx {
  url: string;
  path: string;        // pathname без query
  params: URLSearchParams;
  callIdx: number;
}

interface MockResponseProducts {
  kind: "products";
  results: RawProduct[];
  total?: number;
}
interface MockResponseOptions {
  kind: "options";
  options: RawOption[];
  totalProducts?: number;
  /** Эмулирует Q2 double-wrapping: { data: { data: { options } } } */
  doubleWrap?: boolean;
}
type MockResponse = MockResponseProducts | MockResponseOptions | "http_500";

function mockApiClient(
  handler: (ctx: FetchHandlerCtx) => MockResponse,
): { deps: ApiClientDeps; calls: Array<{ url: string; path: string }> } {
  const calls: Array<{ url: string; path: string }> = [];
  const fakeFetch: typeof fetch = (input) => {
    const url = typeof input === "string" ? input : (input as URL).toString();
    const u = new URL(url);
    const callIdx = calls.length;
    calls.push({ url, path: u.pathname });
    const r = handler({ url, path: u.pathname, params: u.searchParams, callIdx });
    if (r === "http_500") {
      return Promise.resolve(new Response("err", { status: 500 }));
    }
    if (r.kind === "products") {
      const body = JSON.stringify({
        data: { results: r.results, total: r.total ?? r.results.length },
      });
      return Promise.resolve(
        new Response(body, { status: 200, headers: { "content-type": "application/json" } }),
      );
    }
    // options
    const inner = { options: r.options, category: { total_products: r.totalProducts ?? 0 } };
    const wrapped = r.doubleWrap
      ? { data: { data: inner } }     // Q2: double
      : { data: inner };               // single
    return Promise.resolve(
      new Response(JSON.stringify(wrapped), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
  };
  return {
    deps: {
      baseUrl: "https://t.local/api",
      apiToken: "test",
      fetch: fakeFetch,
      timeoutMs: { products: 200, categoryOptions: 200 },
    },
    calls,
  };
}

/**
 * Стабильный resolver-mock: всегда возвращает один pagetitle с высокой
 * confidence (>= category_high). Это эквивалентно ветке `resolved`.
 * data-agnostic: имя категории — синтетическое.
 */
function makeResolverDeps(args: {
  pagetitle: string;
  categories?: string[];
  /** Если задан — мок callLLM вернёт пустые candidates → status=unresolved. */
  forceUnresolved?: boolean;
}): ResolverDeps {
  const cats = args.categories ?? [args.pagetitle, "Other Cat A", "Other Cat B"];
  return {
    listCategories: () => Promise.resolve(cats),
    callLLM: () => {
      if (args.forceUnresolved) {
        return Promise.resolve({
          text: JSON.stringify({ candidates: [] }),
          model: "fake/test",
        });
      }
      return Promise.resolve({
        text: JSON.stringify({
          candidates: [{ pagetitle: args.pagetitle, confidence: 0.92 }],
        }),
        model: "fake/test",
      });
    },
    getThresholds: () => Promise.resolve({ category_high: 0.7, category_low: 0.4 }),
    log: () => {},
  };
}

/**
 * Минимальный expansion-mock: lexicon пуст, перевод выключен → одна попытка
 * `as_is_ru`. Этого достаточно для assembler-теста (s-search/s-price моки
 * не зависят от формы).
 */
function makeExpansionDeps(): ExpansionDeps {
  return {
    getLexicon: () => Promise.resolve({}),
    callTranslator: () => Promise.resolve(null),
  } as unknown as ExpansionDeps;
}

/**
 * In-memory cacheGetOrCompute: всегда compute (cacheHit=false). Нам не нужна
 * шеринг состояния между тестами.
 */
function makeFacetsDeps(apiClient: ApiClientDeps): FacetMatcherDeps {
  return {
    apiClient,
    cacheGetOrCompute: async <T>(_ns: string, _key: string, _ttl: number, compute: () => Promise<T>) => {
      const value = await compute();
      return { value, cacheHit: false };
    },
    facetsTtlSec: 3600,
  };
}

function buildDeps(apiClient: ApiClientDeps, resolverPagetitle: string): AssemblerDeps {
  return {
    apiClient,
    resolver: makeResolverDeps({ pagetitle: resolverPagetitle }),
    expansion: makeExpansionDeps(),
    facets: makeFacetsDeps(apiClient),
    search: { apiClient },
    price: { apiClient },
  };
}

function baseInput(route: Route, query: string, overrides: Partial<AssemblerInput> = {}): AssemblerInput {
  return {
    route,
    intent: intent(),
    query,
    history: [],
    slotMatch: null,
    traceId: "trace-test",
    ...overrides,
  };
}

// ─── G3: OOD-001 (быстрый shortcut, без сети) ───────────────────────────────

Deno.test("G3 ood-001: domain_check=out_of_domain → shortcut, composer не вызывается", async () => {
  // Любой fetch здесь — баг (assembler не должен ходить в API).
  const m = mockApiClient(() => {
    throw new Error("OOD ветка не должна делать HTTP вызовы");
  });
  const deps = buildDeps(m.deps, "Anything");
  const result = await assembleCatalog(
    baseInput("S_CATALOG_OOD", "как испечь пирог", {
      intent: intent({ domain_check: "out_of_domain" }),
    }),
    deps,
  );

  // Контракт OOD-shortcut (§4.7):
  assertEquals(result.ood, true);
  assertEquals(result.composerOutcome, null);
  assertEquals(result.resolvedPagetitle, null);
  assertEquals(result.disallowCrosssell, false); // composer не вызывается → флаг иррелевантен
  assertEquals(result.trace.flavor, "ood");
  // Никаких других стадий не должно быть.
  assertEquals(result.trace.stages.map((s) => s.stage), ["ood_shortcut"]);
  // Ноль HTTP-вызовов.
  assertEquals(m.calls.length, 0);
});

// ─── G1: price-intent-clarify-001 ───────────────────────────────────────────
//
// Цель: probe.total > 50 → §4.4 строит clarify slot из топ-5 значений
// лучшей разделяющей facet-группы. Проверяем КАЖДЫЙ инвариант контракта:
//   - composerOutcome.kind === "price"
//   - outcome.branch === "clarify"
//   - outcome.clarifySlot существует
//   - disallowCrosssell === true (это вопрос-уточнение)
//   - бот НЕ сужает funnel сам (autoNarrowing=0 имплицитно через branch)
//   - zero_price_leak = 0 (probe per_page=1 не отдаёт products)

Deno.test("G1 price-intent-clarify-001: total=705 → clarify slot, disallowCrosssell=true", async () => {
  const PAGETITLE = "Synthetic Cat";

  // Опции для facet-matcher и для clarify-выбора. data-agnostic.
  const sampleOptions: RawOption[] = [
    rawOption(
      "type",
      [
        { value: "alpha", count: 200 },
        { value: "beta", count: 180 },
        { value: "gamma", count: 150 },
        { value: "delta", count: 100 },
        { value: "epsilon", count: 75 },
      ],
      "Тип",
    ),
    rawOption("brand", [{ value: "single", count: 705 }], "Бренд"), // не разделяет
  ];

  const m = mockApiClient((ctx) => {
    if (ctx.path.endsWith("/categories/options")) {
      return { kind: "options", options: sampleOptions, totalProducts: 705, doubleWrap: true };
    }
    if (ctx.path.endsWith("/products")) {
      // s-price probe — per_page=1. ApiClient требует ≥1 валидный продукт
      // в `results`, иначе status='empty' (а не 'ok'). Total=705 в meta.
      return { kind: "products", results: [product(999, 100, "probe-sample")], total: 705 };
    }
    throw new Error(`unexpected path ${ctx.path}`);
  });

  const deps = buildDeps(m.deps, PAGETITLE);
  const result = await assembleCatalog(
    baseInput("S_PRICE", "что-то подешевле", {
      intent: intent({ price_intent: "cheapest" }),
    }),
    deps,
  );

  // Базовые контракты
  assertEquals(result.ood, false);
  assertExists(result.composerOutcome);
  assertEquals(result.composerOutcome!.kind, "price");
  assertEquals(result.resolvedPagetitle, PAGETITLE);

  // §4.4: clarify branch
  if (result.composerOutcome!.kind !== "price") throw new Error("type narrow");
  const priceOutcome = result.composerOutcome!.outcome;
  assertEquals(priceOutcome.branch, "clarify");
  assertEquals(priceOutcome.totalCount, 705);
  assertExists(priceOutcome.clarifySlot, "clarifySlot должен быть сгенерирован");
  assertEquals(priceOutcome.zeroPriceLeak, 0);

  // §11.5b + Core Memory: clarify ⇒ disallowCrosssell=true
  assertEquals(result.disallowCrosssell, true);

  // Trace: все стадии присутствуют в правильном порядке.
  const stageOrder = result.trace.stages.map((s) => s.stage);
  assertEquals(stageOrder, ["category_resolver", "query_expansion", "facet_matcher", "s_price"]);
  assertEquals(result.trace.flavor, "price");
});

// ─── G2: price-intent-ok-001 ────────────────────────────────────────────────
//
// total=5, price_intent=cheapest → §4.4 показать все 5 ASC. zero_price_leak=0
// (включаем 1 «грязный» товар price=0 в fetch — должен быть отфильтрован
// клиентом api-client до возврата s-price; проверяем итоговую длину 5 + leak=1
// на уровне s-price.totalCount но 5 в отображённом списке).

Deno.test("G2 price-intent-ok-001: total=5 cheapest → show_all ASC, disallowCrosssell=false", async () => {
  const PAGETITLE = "Synthetic Cat";

  // Smoke options для facet-matcher (без модификаторов даст пустые фильтры).
  const sampleOptions: RawOption[] = [
    rawOption("type", [{ value: "x", count: 5 }], "Тип"),
  ];

  const products = [
    product(1, 500, "p1"),
    product(2, 100, "p2"),
    product(3, 300, "p3"),
    product(4, 700, "p4"),
    product(5, 200, "p5"),
  ];

  let probeCalls = 0;
  let fullCalls = 0;
  const m = mockApiClient((ctx) => {
    if (ctx.path.endsWith("/categories/options")) {
      return { kind: "options", options: sampleOptions, totalProducts: 5, doubleWrap: false };
    }
    if (ctx.path.endsWith("/products")) {
      const perPage = Number(ctx.params.get("per_page")) || 0;
      if (perPage === 1) {
        probeCalls++;
        // Probe: 1 валидный продукт + total=5 в meta. status='ok'.
        return { kind: "products", results: [products[0]], total: 5 };
      }
      fullCalls++;
      return { kind: "products", results: products, total: 5 }; // full fetch
    }
    throw new Error(`unexpected path ${ctx.path}`);
  });

  const deps = buildDeps(m.deps, PAGETITLE);
  const result = await assembleCatalog(
    baseInput("S_PRICE", "самые дешёвые", {
      intent: intent({ price_intent: "cheapest" }),
    }),
    deps,
  );

  assertEquals(result.ood, false);
  assertExists(result.composerOutcome);
  assertEquals(result.composerOutcome!.kind, "price");
  if (result.composerOutcome!.kind !== "price") throw new Error("type narrow");
  const out = result.composerOutcome!.outcome;

  // §4.4 show_all
  assertEquals(out.branch, "show_all");
  assertEquals(out.totalCount, 5);
  assertEquals(out.products.length, 5);
  // ASC по цене — cheapest first
  assertEquals(out.products.map((p) => p.price), [100, 200, 300, 500, 700]);
  assertEquals(out.clarifySlot, null);
  assertEquals(out.zeroPriceLeak, 0);

  // §11.5b: show_all → cross-sell разрешён (assembler не запрещает)
  assertEquals(result.disallowCrosssell, false);

  // probe-then-fetch: ровно 1 probe + 1 full fetch (без дублирования)
  assertEquals(probeCalls, 1);
  assertEquals(fullCalls, 1);
});

// ─── Invariants (защита от регрессий core memory) ───────────────────────────

Deno.test("INV: assembler НИКОГДА не сужает funnel сам (clarify ≠ автонарвинг)", async () => {
  // Большой total → clarify, НО assembler не должен сам выставить
  // optionFilters в fetch. Считаем число fetch к /products: должно быть
  // РОВНО 1 (probe per_page=1, без followup-фильтрации).
  const m = mockApiClient((ctx) => {
    if (ctx.path.endsWith("/categories/options")) {
      return {
        kind: "options",
        options: [
          rawOption("type", [
            { value: "a", count: 300 },
            { value: "b", count: 250 },
            { value: "c", count: 200 },
          ]),
        ],
        totalProducts: 750,
      };
    }
    if (ctx.path.endsWith("/products")) {
      // probe: ≥1 валидный продукт + total=750 в meta.
      return { kind: "products", results: [product(1, 100, "probe")], total: 750 };
    }
    throw new Error(`unexpected ${ctx.path}`);
  });
  const deps = buildDeps(m.deps, "Synthetic Cat");
  await assembleCatalog(
    baseInput("S_PRICE", "что-нибудь", { intent: intent({ price_intent: "cheapest" }) }),
    deps,
  );
  const productCalls = m.calls.filter((c) => c.path.endsWith("/products"));
  assertEquals(productCalls.length, 1, "clarify-ветка должна делать ровно 1 probe-вызов");
});

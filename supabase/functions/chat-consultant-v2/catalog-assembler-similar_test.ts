// chat-consultant-v2 / catalog-assembler-similar_test.ts
// Stage 8.4 — интеграция S_SIMILAR в catalog-assembler.
// Источник: spec §4.6, §4.6.5 (INV-S2), Core Memory.
//
// Покрытие:
//   - S_SIMILAR без deps.similar → fallback empty + disallowCrosssell=true
//   - S_SIMILAR с stub-deps возвращает clarify_anchor (нет SKU/last_shown)
//     → adapter маппит status='empty', composerOutcome.kind='search'
//   - INV-S2 cross-cutting: при ЛЮБОМ результате similar — disallowCrosssell=true
//   - flavor='similar' в trace
//
// data-agnostic: ноль реальных категорий/брендов 220volt.

import { assertEquals, assert } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { assembleCatalog, type AssemblerDeps, type AssemblerInput } from "./catalog-assembler.ts";
import type { Intent } from "./types.ts";
import type { SSimilarDeps } from "./s-similar/index.ts";
import { validateClassifyTraitsResult } from "./s-similar/schema.ts";

function intent(overrides: Partial<Intent> = {}): Intent {
  return {
    intent: "catalog",
    has_sku: false,
    sku_candidate: null,
    price_intent: null,
    category_hint: null,
    search_modifiers: [],
    critical_modifiers: [],
    is_replacement: true,        // ключевое: similar-trigger
    domain_check: "in_domain",
    ...overrides,
  };
}

function baseInput(overrides: Partial<AssemblerInput> = {}): AssemblerInput {
  return {
    route: "S_SIMILAR",
    intent: intent(),
    query: "подбери аналог",
    history: [],
    slotMatch: null,
    traceId: "trace-similar",
    ...overrides,
  };
}

/**
 * Минимальные deps без `similar` — assembler должен выдать fallback empty
 * (без падения), но всё равно проставить disallowCrosssell=true.
 */
function depsWithoutSimilar(): AssemblerDeps {
  // Возвращаем заглушки для обязательных полей; они НЕ должны вызываться,
  // т.к. S_SIMILAR-shortcut перехватывает раньше.
  const stub = (name: string) => () => { throw new Error(`should not be called: ${name}`); };
  return {
    resolver: { listCategories: stub("listCategories"), callLLM: stub("callLLM"),
                getThresholds: stub("getThresholds"), log: () => {} },
    expansion: {} as never,
    facets: {} as never,
    search: {} as never,
    price: {} as never,
    apiClient: { baseUrl: "https://t.local/api", apiToken: "x" },
    log: () => {},
  };
}

/**
 * Stub-deps.similar который не вызывает API: anchor сразу = clarify_anchor
 * (нет sku_candidate, нет last_shown_product_sku). Это покрывает быстрый
 * путь без сетевых вызовов.
 */
function stubSimilarDeps(): SSimilarDeps {
  return {
    apiClient: { baseUrl: "https://t.local", apiToken: "x" },
    facetMatcher: {
      apiClient: { baseUrl: "https://t.local", apiToken: "x" },
      cacheGetOrCompute: async <T>(_n: string, _k: string, _ttl: number, c: () => Promise<T>) =>
        ({ value: await c(), cacheHit: false }),
    },
    resolver: { listCategories: async () => [], callLLM: async () => ({ text: "", model: "m" }),
                getThresholds: async () => ({ category_high: 0.7, category_low: 0.4 }),
                log: () => {} },
    callLLM: () => { throw new Error("LLM should not be called for clarify_anchor path"); },
    validateTraits: validateClassifyTraitsResult,
  };
}

// ─── Tests ──────────────────────────────────────────────────────────────────

Deno.test("assembler S_SIMILAR: без deps.similar → fallback empty, disallowCrosssell=true (INV-S2)", async () => {
  const result = await assembleCatalog(baseInput(), depsWithoutSimilar());
  assertEquals(result.disallowCrosssell, true);
  assertEquals(result.ood, false);
  assertEquals(result.composerOutcome?.kind, "search");
  if (result.composerOutcome?.kind === "search") {
    assertEquals(result.composerOutcome.outcome.status, "empty");
    assertEquals(result.composerOutcome.outcome.products.length, 0);
  }
  assertEquals(result.trace.flavor, "similar");
  assert(result.trace.stages.some((s) => s.stage === "s_similar"));
});

Deno.test("assembler S_SIMILAR: clarify_anchor (нет SKU, нет last_shown) → empty + disallowCrosssell=true", async () => {
  const deps = { ...depsWithoutSimilar(), similar: stubSimilarDeps() };
  const result = await assembleCatalog(baseInput(), deps);
  assertEquals(result.disallowCrosssell, true);
  assertEquals(result.composerOutcome?.kind, "search");
  if (result.composerOutcome?.kind === "search") {
    assertEquals(result.composerOutcome.outcome.status, "empty");
    // clarifyQuestion проброшен в errorMessage (адаптер §4.6)
    assert(
      typeof result.composerOutcome.outcome.errorMessage === "string" &&
      result.composerOutcome.outcome.errorMessage.length > 0,
      "clarifyQuestion должен попасть в errorMessage",
    );
  }
  // Trace stage и meta
  const stage = result.trace.stages.find((s) => s.stage === "s_similar");
  assertEquals(stage?.meta?.anchor_status, "clarify_anchor");
  assertEquals(stage?.meta?.classify_calls, 0); // INV-S1: LLM не вызывался
});

Deno.test("assembler S_SIMILAR: INV-S2 cross-cutting — disallowCrosssell=true для любого intent", async () => {
  const variations: Partial<Intent>[] = [
    { is_replacement: true, has_sku: false },
    { is_replacement: true, has_sku: true, sku_candidate: "X-1" }, // anchor try, всё равно clarify т.к. без deps API
    { is_replacement: true, category_hint: "cat-y" },
  ];
  for (const v of variations) {
    const result = await assembleCatalog(
      baseInput({ intent: intent(v) }),
      { ...depsWithoutSimilar(), similar: stubSimilarDeps() },
    );
    assertEquals(result.disallowCrosssell, true, `INV-S2 violated for intent=${JSON.stringify(v)}`);
  }
});

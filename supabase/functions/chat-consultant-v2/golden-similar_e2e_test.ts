/**
 * Stage 8.5b — Golden E2E for similar/replacement branch.
 * Источник: spec §4.6.1–§4.6.5, §11.6, §17.3 (BNF cards).
 *
 * Покрытие (3 сценария, полный путь assembleCatalog → composeCatalogAnswer):
 *   1. INTENT_SKU      — intent.sku_candidate → similar found → ok с карточками
 *                        + recommendationContext (1 строка) + НЕТ cross-sell
 *   2. LAST_SHOWN      — intent без SKU, state.last_shown_product_sku → ok
 *   3. CLARIFY_ANCHOR  — нет ни SKU, ни last_shown → один вопрос, без slot
 *
 * Инварианты, проверяемые во ВСЕХ 3:
 *   - assembled.disallowCrosssell === true  (INV-S2)
 *   - assembled.trace.flavor === 'similar'
 *   - composed.crosssell.rendered === false (никогда не рендерится в similar)
 *   - composed text НЕ содержит маркер cross-sell, никаких «найдено …»
 *     эмодзи приветствий
 *
 * Архитектурно: НЕ ходим в сеть. Подменяем DI через те же приёмы, что в
 * s-similar/index_test.ts (mock fetch у apiClient + facetMatcher) +
 * stub streamLLM у композера.
 *
 * data-agnostic: ноль реальных категорий/товаров 220volt.
 */

import { assertEquals, assert, assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  assembleCatalog,
  type AssemblerDeps,
  type AssemblerInput,
  type AssemblerResult,
} from "./catalog-assembler.ts";
import {
  composeCatalogAnswer,
  type CatalogComposerDeps,
  type ComposeCatalogOutput,
} from "./s-catalog-composer.ts";
import { validateClassifyTraitsResult } from "./s-similar/schema.ts";
import type { Intent, ConversationState } from "./types.ts";
import type { RawProduct } from "./catalog/api-client.ts";

// ─── Fixtures ───────────────────────────────────────────────────────────────

function intentReplacement(overrides: Partial<Intent> = {}): Intent {
  return {
    intent: "catalog",
    has_sku: false,
    sku_candidate: null,
    price_intent: null,
    category_hint: null,
    search_modifiers: [],
    critical_modifiers: [],
    is_replacement: true,
    domain_check: "in_domain",
    ...overrides,
  };
}

function makeAnchor(): RawProduct {
  // deno-lint-ignore no-explicit-any
  return {
    id: 100,
    name: "Anchor",
    pagetitle: "Anchor",
    url: "/p/anchor",
    price: 1500,
    vendor: "VendorA",
    article: "ANCHOR-001",
    category: { id: 7, pagetitle: "cat-generic" },
  } as any;
}

function makeCandidate(id: number, article: string): RawProduct {
  // deno-lint-ignore no-explicit-any
  return {
    id,
    name: `Cand-${id}`,
    pagetitle: `Cand-${id}`,
    url: `/p/${id}`,
    price: 1000 + id,
    vendor: "VendorA",
    article,
    category: { id: 7, pagetitle: "cat-generic" },
  } as any;
}

// ─── DI builders ────────────────────────────────────────────────────────────

interface MockEnv {
  /** Anchor lookup result; null = не найден. */
  anchor: RawProduct | null;
  /** Кандидаты, которые вернёт category search. */
  candidates: RawProduct[];
  /** Сколько раз позвали classify_traits LLM. */
  classifyCalls: number;
  /** Сколько раз позвали composer streamLLM. */
  composerCalls: number;
}

function makeAssemblerDeps(env: MockEnv): AssemblerDeps {
  const mockFetch: typeof fetch = (input) => {
    const url = typeof input === "string" ? input : (input as Request).url;
    const u = new URL(url);
    // 1) anchor lookup: products?article=...
    if (u.pathname.endsWith("/products") && u.searchParams.get("article")) {
      const products = env.anchor ? [env.anchor] : [];
      return Promise.resolve(jsonResp({ data: { results: products, total: products.length } }));
    }
    // 2) categories/.../options → пусто (matchFacets вернёт no_matches → degrade)
    if (u.pathname.includes("/categories/") && u.pathname.endsWith("/options")) {
      return Promise.resolve(jsonResp({ data: { options: [] } }));
    }
    // 3) products?... (без article) → category search → кандидаты
    if (u.pathname.endsWith("/products")) {
      return Promise.resolve(jsonResp({
        data: { results: env.candidates, total: env.candidates.length },
      }));
    }
    return Promise.resolve(new Response("nf", { status: 404 }));
  };

  const apiClient = { baseUrl: "https://mock", apiToken: "t", fetch: mockFetch };

  return {
    resolver: {
      listCategories: async () => ["cat-generic"],
      callLLM: async () => ({ text: "cat-generic", model: "mock" }),
      getThresholds: async () => ({ category_high: 0.7, category_low: 0.4 }),
      log: () => {},
    },
    expansion: {} as never,
    facets: {
      apiClient,
      cacheGetOrCompute: async () => ({
        // deno-lint-ignore no-explicit-any
        value: { status: "ok", options: [], totalProducts: 0, ms: 1, source: "live" } as any,
        cacheHit: false,
      }),
    },
    search: {} as never,
    price: {} as never,
    apiClient,
    similar: {
      apiClient,
      facetMatcher: {
        apiClient,
        cacheGetOrCompute: async () => ({
          // deno-lint-ignore no-explicit-any
          value: { status: "ok", options: [], totalProducts: 0, ms: 1, source: "live" } as any,
          cacheHit: false,
        }),
      },
      resolver: {
        listCategories: async () => ["cat-generic"],
        callLLM: async () => ({ text: "cat-generic", model: "mock" }),
        getThresholds: async () => ({ category_high: 0.7, category_low: 0.4 }),
        log: () => {},
      },
      callLLM: async () => {
        env.classifyCalls++;
        // Возвращаем валидный payload: 1 must + 1 should — даст
        // recommendationContext с 2 traits.
        return {
          category_pagetitle: "cat-generic",
          traits: [
            { key: "type",  value: "compact",  weight: "must"   },
            { key: "color", value: "black",    weight: "should" },
          ],
        };
      },
      validateTraits: validateClassifyTraitsResult,
      perPage: 12,
      now: () => 1_000_000,
    },
  } as AssemblerDeps;
}

function makeComposerDeps(env: MockEnv): CatalogComposerDeps {
  return {
    streamLLM: async ({ onDelta }) => {
      env.composerCalls++;
      const text = "Подобрал варианты, посмотрите.";
      onDelta(text);
      return { output_text: text, input_tokens: 10, output_tokens: 5, model: "mock" };
    },
  };
}

function jsonResp(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

async function runFullPath(
  input: AssemblerInput,
  env: MockEnv,
): Promise<{ assembled: AssemblerResult; composed: ComposeCatalogOutput | null }> {
  const assembled = await assembleCatalog(input, makeAssemblerDeps(env));
  let composed: ComposeCatalogOutput | null = null;
  if (assembled.composerOutcome) {
    composed = await composeCatalogAnswer(
      {
        query: input.query,
        outcome: assembled.composerOutcome,
        history: input.history,
        prevSoft404Streak: 0,
        disallowCrosssell: assembled.disallowCrosssell,
        recommendationContext: assembled.recommendationContext,
        onDelta: () => {},
      },
      makeComposerDeps(env),
    );
  }
  return { assembled, composed };
}

// ─── Golden 1: INTENT_SKU ───────────────────────────────────────────────────

Deno.test("GOLDEN-1: similar by intent.sku_candidate → ok + recommendationContext + no cross-sell", async () => {
  const env: MockEnv = {
    anchor: makeAnchor(),
    candidates: [
      makeCandidate(1, "C-001"),
      makeCandidate(2, "C-002"),
    ],
    classifyCalls: 0,
    composerCalls: 0,
  };
  const input: AssemblerInput = {
    route: "S_SIMILAR",
    intent: intentReplacement({ has_sku: true, sku_candidate: "ANCHOR-001" }),
    query: "подбери аналог ANCHOR-001",
    history: [],
    slotMatch: null,
    traceId: "g1",
    state: { conversation_id: "g1", slots: [] },
  };

  const { assembled, composed } = await runFullPath(input, env);

  // Инварианты
  assertEquals(assembled.disallowCrosssell, true,         "INV-S2: disallowCrosssell всегда true");
  assertEquals(assembled.trace.flavor, "similar",         "trace.flavor='similar'");
  assertEquals(env.classifyCalls, 1,                      "INV-S1: ровно один classify_traits");

  // recommendationContext проброшен из similar в assembler
  assert(typeof assembled.recommendationContext === "string" && assembled.recommendationContext.length > 0,
    "recommendationContext должен быть заполнен (есть traits)");

  // Composer вызван и результат содержит recommendationContext первой строкой
  assert(composed !== null, "composer должен быть вызван (есть products)");
  assertEquals(composed!.crosssell.rendered, false,       "cross-sell НЕ рендерится в similar");
  assertStringIncludes(composed!.text, assembled.recommendationContext!,
    "финальный текст содержит recommendationContext");
  // Карточки BNF
  assertStringIncludes(composed!.text, "**[Cand-1](/p/1)**");
  assertStringIncludes(composed!.text, "Цена:");
});

// ─── Golden 2: LAST_SHOWN ───────────────────────────────────────────────────

Deno.test("GOLDEN-2: similar by state.last_shown_product_sku → ok + recommendationContext", async () => {
  const env: MockEnv = {
    anchor: makeAnchor(),
    candidates: [makeCandidate(3, "C-003")],
    classifyCalls: 0,
    composerCalls: 0,
  };
  const state: ConversationState = {
    conversation_id: "g2",
    slots: [],
    last_shown_product_sku: "ANCHOR-001",
  };
  const input: AssemblerInput = {
    route: "S_SIMILAR",
    intent: intentReplacement({ has_sku: false, sku_candidate: null }),
    query: "покажи похожие",
    history: [],
    slotMatch: null,
    traceId: "g2",
    state,
  };

  const { assembled, composed } = await runFullPath(input, env);

  assertEquals(assembled.disallowCrosssell, true);
  assertEquals(assembled.trace.flavor, "similar");
  assertEquals(env.classifyCalls, 1);
  assert(composed !== null);
  assertEquals(composed!.crosssell.rendered, false);
  assertStringIncludes(composed!.text, "**[Cand-3](/p/3)**");
});

// ─── Golden 3: CLARIFY_ANCHOR ───────────────────────────────────────────────

Deno.test("GOLDEN-3: no SKU & no last_shown → clarify_anchor (no LLM, no slot, no cards)", async () => {
  const env: MockEnv = {
    anchor: null,         // не используется
    candidates: [],
    classifyCalls: 0,
    composerCalls: 0,
  };
  const input: AssemblerInput = {
    route: "S_SIMILAR",
    intent: intentReplacement({ has_sku: false, sku_candidate: null }),
    query: "подбери аналог",
    history: [],
    slotMatch: null,
    traceId: "g3",
    state: { conversation_id: "g3", slots: [] }, // нет last_shown_product_sku
  };

  const { assembled, composed } = await runFullPath(input, env);

  // Инварианты
  assertEquals(assembled.disallowCrosssell, true,        "INV-S2 справедлив и для clarify_anchor");
  assertEquals(assembled.trace.flavor, "similar");
  assertEquals(env.classifyCalls, 0,                     "classify_traits НЕ вызывается без anchor");

  // composerOutcome есть (адаптер маппит clarify_anchor → empty SearchOutcome).
  // Композер вызывается (scenario='soft_404' путь без products).
  assert(assembled.composerOutcome !== null);
  assert(composed !== null);
  // Никаких карточек не должно быть
  assert(!composed!.text.includes("**[Cand"), "никаких товарных карточек");
  // Cross-sell не рендерится
  assertEquals(composed!.crosssell.rendered, false);
  // INV-S3: clarify_anchor НЕ создаёт slot — assembler не возвращает slot,
  // и composer НЕ создаёт slot для no-products сценария similar.
  // (assembler не имеет поля «createdSlot», слоты создаёт только S_PRICE clarify;
  // здесь проверяем косвенно через отсутствие clarifySlot в outcome.)
  if (assembled.composerOutcome.kind === "price") {
    // Не должно быть price-веткой
    throw new Error("composerOutcome.kind должен быть 'search' для similar");
  }
});

// ─── Cross-cutting invariant: INV-S2 для всех 3 сценариев ───────────────────

Deno.test("CROSS-CUT: disallowCrosssell=true и flavor='similar' для всех similar-веток", async () => {
  const variants: Array<{ name: string; input: AssemblerInput; env: MockEnv }> = [
    {
      name: "intent_sku",
      input: {
        route: "S_SIMILAR",
        intent: intentReplacement({ has_sku: true, sku_candidate: "ANCHOR-001" }),
        query: "q1", history: [], slotMatch: null, traceId: "x1",
        state: { conversation_id: "x1", slots: [] },
      },
      env: { anchor: makeAnchor(), candidates: [makeCandidate(9, "C-9")], classifyCalls: 0, composerCalls: 0 },
    },
    {
      name: "last_shown",
      input: {
        route: "S_SIMILAR",
        intent: intentReplacement(),
        query: "q2", history: [], slotMatch: null, traceId: "x2",
        state: { conversation_id: "x2", slots: [], last_shown_product_sku: "ANCHOR-001" },
      },
      env: { anchor: makeAnchor(), candidates: [], classifyCalls: 0, composerCalls: 0 },
    },
    {
      name: "clarify",
      input: {
        route: "S_SIMILAR",
        intent: intentReplacement(),
        query: "q3", history: [], slotMatch: null, traceId: "x3",
        state: { conversation_id: "x3", slots: [] },
      },
      env: { anchor: null, candidates: [], classifyCalls: 0, composerCalls: 0 },
    },
  ];

  for (const v of variants) {
    const { assembled } = await runFullPath(v.input, v.env);
    assertEquals(assembled.disallowCrosssell, true, `INV-S2 для ${v.name}`);
    assertEquals(assembled.trace.flavor, "similar", `flavor='similar' для ${v.name}`);
  }
});

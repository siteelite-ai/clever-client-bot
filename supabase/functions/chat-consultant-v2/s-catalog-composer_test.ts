/**
 * Tests for s-catalog-composer.ts
 * Источник: spec §5.4.1 (CROSSSELL marker), §5.6.1 (soft404 state-machine),
 *           §11.5 / §11.5b (cross-sell rules), §17.3 (BNF cards via formatter).
 *
 * Стратегия: всё через DI (фиктивный streamLLM), без сети.
 */

import {
  assert,
  assertEquals,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  composeCatalogAnswer,
  type CatalogComposerDeps,
  CROSSSELL_MARKER,
  decideScenario,
  nextSoft404Streak,
  splitByMarker,
  stripGreeting,
  trimHistory,
  validateCrosssell,
} from "./s-catalog-composer.ts";
import type { SearchOutcome } from "./catalog/search.ts";
import type { RawProduct } from "./catalog/api-client.ts";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function mockProduct(overrides: Partial<RawProduct> = {}): RawProduct {
  return {
    id: 1,
    name: null,
    pagetitle: "Тестовый товар",
    url: "https://220volt.kz/p/test",
    price: 12990,
    vendor: "TestBrand",
    warehouses: [{ city: "Алматы", amount: 5 }],
    ...overrides,
  } as RawProduct;
}

function mockOutcome(
  status: SearchOutcome["status"],
  products: RawProduct[] = [],
): SearchOutcome {
  return {
    status,
    products,
    postFilterDropped: 0,
  };
}

function mockDeps(llmOutput: string): CatalogComposerDeps {
  return {
    streamLLM: async ({ onDelta }) => {
      onDelta(llmOutput);
      return {
        output_text: llmOutput,
        input_tokens: 100,
        output_tokens: 50,
        model: "google/gemini-2.5-flash",
      };
    },
  };
}

// ─── decideScenario ──────────────────────────────────────────────────────────

Deno.test("decideScenario: ok → normal", () => {
  assertEquals(decideScenario(mockOutcome("ok", [mockProduct()])), "normal");
});

Deno.test("decideScenario: soft_fallback → soft_fallback", () => {
  assertEquals(decideScenario(mockOutcome("soft_fallback", [mockProduct()])), "soft_fallback");
});

Deno.test("decideScenario: empty → soft_404", () => {
  assertEquals(decideScenario(mockOutcome("empty")), "soft_404");
});

Deno.test("decideScenario: empty_degraded → soft_404", () => {
  assertEquals(decideScenario(mockOutcome("empty_degraded")), "soft_404");
});

Deno.test("decideScenario: all_zero_price → all_zero_price", () => {
  assertEquals(decideScenario(mockOutcome("all_zero_price")), "all_zero_price");
});

Deno.test("decideScenario: error → error", () => {
  assertEquals(decideScenario(mockOutcome("error")), "error");
});

// ─── nextSoft404Streak (§5.6.1) ──────────────────────────────────────────────

Deno.test("soft404: 0 + empty → 1", () => {
  assertEquals(nextSoft404Streak(0, mockOutcome("empty")), 1);
});

Deno.test("soft404: 1 + empty → 2", () => {
  assertEquals(nextSoft404Streak(1, mockOutcome("empty")), 2);
});

Deno.test("soft404: 2 + empty → 2 (clamped)", () => {
  assertEquals(nextSoft404Streak(2, mockOutcome("empty")), 2);
});

Deno.test("soft404: 1 + ok with products → 0 (reset)", () => {
  assertEquals(nextSoft404Streak(1, mockOutcome("ok", [mockProduct()])), 0);
});

Deno.test("soft404: 2 + soft_fallback with products → 0 (reset)", () => {
  assertEquals(
    nextSoft404Streak(2, mockOutcome("soft_fallback", [mockProduct()])),
    0,
  );
});

Deno.test("soft404: 0 + all_zero_price → 1", () => {
  assertEquals(nextSoft404Streak(0, mockOutcome("all_zero_price")), 1);
});

Deno.test("soft404: 1 + error (no products) → 1 (no change, infra failure)", () => {
  assertEquals(nextSoft404Streak(1, mockOutcome("error")), 1);
});

// ─── splitByMarker (§5.4.1) ─────────────────────────────────────────────────

Deno.test("splitByMarker: no marker → all intro", () => {
  const r = splitByMarker("Просто intro без маркера.");
  assertEquals(r.intro, "Просто intro без маркера.");
  assertEquals(r.crosssell, null);
});

Deno.test("splitByMarker: with marker → split clean", () => {
  const text = `Подобрали несколько вариантов.\n${CROSSSELL_MARKER}\nК таким товарам обычно докупают расходники.`;
  const r = splitByMarker(text);
  assertEquals(r.intro, "Подобрали несколько вариантов.");
  assertEquals(r.crosssell, "К таким товарам обычно докупают расходники.");
});

Deno.test("splitByMarker: marker present but cross-sell empty → null", () => {
  const text = `Intro.\n${CROSSSELL_MARKER}\n   `;
  const r = splitByMarker(text);
  assertEquals(r.crosssell, null);
});

Deno.test("splitByMarker: tolerates extra equals signs", () => {
  const r = splitByMarker("Intro.\n====CROSSSELL====\nTail.");
  assertEquals(r.intro, "Intro.");
  assertEquals(r.crosssell, "Tail.");
});

// ─── validateCrosssell (§11.5b) ─────────────────────────────────────────────

Deno.test("validateCrosssell: valid text passes", () => {
  assertEquals(
    validateCrosssell("К таким приборам обычно докупают расходные материалы."),
    null,
  );
});

Deno.test("validateCrosssell: rejects markdown links", () => {
  assertEquals(
    validateCrosssell("Посмотрите [перчатки](https://x.kz/g)."),
    "markdown_link",
  );
});

Deno.test("validateCrosssell: rejects bare URLs", () => {
  assertEquals(
    validateCrosssell("Подробности на https://220volt.kz."),
    "bare_url",
  );
});

Deno.test("validateCrosssell: rejects currency ₸", () => {
  assertEquals(
    validateCrosssell("Стоит около тысячи ₸."),
    "currency",
  );
});

Deno.test("validateCrosssell: rejects 'тенге'", () => {
  assertEquals(
    validateCrosssell("Цена в тенге невысокая."),
    "currency",
  );
});

Deno.test("validateCrosssell: rejects 4+ digit number (price)", () => {
  assertEquals(
    validateCrosssell("Дополнительно потребуется 1500 на расходники."),
    "price_number",
  );
});

Deno.test("validateCrosssell: rejects spaced thousands (12 990)", () => {
  assertEquals(
    validateCrosssell("Это обойдётся в 12 990 примерно."),
    "price_number",
  );
});

Deno.test("validateCrosssell: rejects CTA 'нажмите'", () => {
  assertEquals(
    validateCrosssell("Нажмите кнопку для заказа."),
    "cta_phrase",
  );
});

Deno.test("validateCrosssell: rejects CTA 'по ссылке'", () => {
  assertEquals(
    validateCrosssell("Подробности по ссылке выше."),
    "cta_phrase",
  );
});

Deno.test("validateCrosssell: rejects SKU-like AC-1234", () => {
  assertEquals(
    validateCrosssell("Совместимо с моделью AC-1234."),
    "sku_like",
  );
});

Deno.test("validateCrosssell: rejects empty", () => {
  assertEquals(validateCrosssell("   "), "empty");
});

// ─── stripGreeting (§5.2 L2) ─────────────────────────────────────────────────

Deno.test("stripGreeting: 'Здравствуйте, ...' is stripped", () => {
  const r = stripGreeting("Здравствуйте, подобрал вам товары.");
  assertEquals(r.text, "подобрал вам товары.");
  assert(r.stripped !== null);
});

Deno.test("stripGreeting: 'Добрый день! ...' is stripped", () => {
  const r = stripGreeting("Добрый день, вот варианты.");
  assertEquals(r.text, "вот варианты.");
});

Deno.test("stripGreeting: no greeting → unchanged", () => {
  const r = stripGreeting("Подобрал варианты по запросу.");
  assertEquals(r.text, "Подобрал варианты по запросу.");
  assertEquals(r.stripped, null);
});

// ─── trimHistory (§7.2) ──────────────────────────────────────────────────────

Deno.test("trimHistory: ≤8 messages preserved", () => {
  const h = Array.from({ length: 5 }, (_, i) => ({
    role: "user" as const,
    content: `msg${i}`,
  }));
  assertEquals(trimHistory(h).length, 5);
});

Deno.test("trimHistory: >8 trimmed to last 8", () => {
  const h = Array.from({ length: 12 }, (_, i) => ({
    role: "user" as const,
    content: `msg${i}`,
  }));
  const out = trimHistory(h);
  assertEquals(out.length, 8);
  assertEquals(out[0].content, "msg4");
});

Deno.test("trimHistory: respects char budget", () => {
  const big = "x".repeat(2000);
  const h = [
    { role: "user" as const, content: big },
    { role: "assistant" as const, content: big },
    { role: "user" as const, content: "tail" },
  ];
  const out = trimHistory(h);
  // Должны оставить хвост ('tail') гарантированно, остальное — по бюджету.
  assertEquals(out[out.length - 1].content, "tail");
});

// ─── composeCatalogAnswer: integration ──────────────────────────────────────

Deno.test("compose normal: cards injected between intro and crosssell", async () => {
  const llm = `Подобрали несколько вариантов.\n${CROSSSELL_MARKER}\nК таким приборам обычно докупают расходные материалы.`;
  const deltas: string[] = [];
  const out = await composeCatalogAnswer(
    {
      query: "тестер",
      outcome: mockOutcome("ok", [mockProduct()]),
      history: [],
      prevSoft404Streak: 0,
      onDelta: (d) => deltas.push(d),
    },
    mockDeps(llm),
  );
  assertEquals(out.scenario, "normal");
  assertEquals(out.newSoft404Streak, 0);
  assertEquals(out.contactManager, false);
  // Структура: intro → cards (BNF) → crosssell
  assertStringIncludes(out.text, "Подобрали несколько вариантов.");
  assertStringIncludes(out.text, "**[Тестовый товар]");
  assertStringIncludes(out.text, "К таким приборам");
  assertEquals(out.crosssell.rendered, true);
  assertEquals(out.crosssell.violation, null);
  assertEquals(out.formatter.rendered, 1);
  // Маркер вырезан.
  assert(!out.text.includes(CROSSSELL_MARKER));
});

Deno.test("compose normal: invalid crosssell is cut, intro+cards remain", async () => {
  const llm = `Подобрали варианты.\n${CROSSSELL_MARKER}\nЦена 1500 ₸ — нажмите для заказа.`;
  const out = await composeCatalogAnswer(
    {
      query: "лампа",
      outcome: mockOutcome("ok", [mockProduct()]),
      history: [],
      prevSoft404Streak: 0,
      onDelta: () => {},
    },
    mockDeps(llm),
  );
  assertEquals(out.crosssell.presentInLLM, true);
  assertEquals(out.crosssell.rendered, false);
  assert(out.crosssell.violation !== null);
  assertStringIncludes(out.text, "Подобрали варианты.");
  assertStringIncludes(out.text, "**[Тестовый товар]");
  // Запрещённый абзац НЕ попал.
  assert(!out.text.includes("нажмите"));
});

Deno.test("compose soft_fallback: crosssell cut even if valid; tail line added", async () => {
  const llm = `Вот ближайшие варианты.\n${CROSSSELL_MARKER}\nДокупают расходники.`;
  const out = await composeCatalogAnswer(
    {
      query: "розетка с таймером",
      outcome: mockOutcome("soft_fallback", [mockProduct()]),
      history: [],
      prevSoft404Streak: 0,
      onDelta: () => {},
    },
    mockDeps(llm),
  );
  assertEquals(out.scenario, "soft_fallback");
  assertEquals(out.crosssell.rendered, false);
  assertEquals(out.crosssell.violation, "soft_fallback_disallowed");
  assertStringIncludes(out.text, "Если важно уточнить");
  // Cross-sell-абзац НЕ выведен.
  assert(!out.text.includes("Докупают расходники"));
});

Deno.test("compose empty: scenario=soft_404, streak 0→1, no contact", async () => {
  const out = await composeCatalogAnswer(
    {
      query: "несуществующий товар",
      outcome: mockOutcome("empty"),
      history: [],
      prevSoft404Streak: 0,
      onDelta: () => {},
    },
    mockDeps("По запросу ничего не нашли. Уточните параметры."),
  );
  assertEquals(out.scenario, "soft_404");
  assertEquals(out.newSoft404Streak, 1);
  assertEquals(out.contactManager, false);
  assertEquals(out.formatter.rendered, 0);
  assertStringIncludes(out.text, "Уточните");
});

Deno.test("compose empty (second turn): streak 1→2, contactManager=true", async () => {
  const out = await composeCatalogAnswer(
    {
      query: "снова несуществующий",
      outcome: mockOutcome("empty"),
      history: [],
      prevSoft404Streak: 1,
      onDelta: () => {},
    },
    mockDeps("Снова ничего не нашли. Свяжем с менеджером."),
  );
  assertEquals(out.newSoft404Streak, 2);
  assertEquals(out.contactManager, true);
});

Deno.test("compose all_zero_price: contactManager=true regardless of streak", async () => {
  const out = await composeCatalogAnswer(
    {
      query: "товары без цен",
      outcome: mockOutcome("all_zero_price"),
      history: [],
      prevSoft404Streak: 0,
      onDelta: () => {},
    },
    mockDeps("Нужно уточнить цены — менеджер поможет."),
  );
  assertEquals(out.scenario, "all_zero_price");
  assertEquals(out.contactManager, true);
  assertEquals(out.formatter.rendered, 0);
});

Deno.test("compose error: contactManager=true; streak unchanged", async () => {
  const out = await composeCatalogAnswer(
    {
      query: "что угодно",
      outcome: mockOutcome("error"),
      history: [],
      prevSoft404Streak: 1,
      onDelta: () => {},
    },
    mockDeps("Технический сбой, свяжитесь с менеджером."),
  );
  assertEquals(out.scenario, "error");
  assertEquals(out.contactManager, true);
  assertEquals(out.newSoft404Streak, 1);
});

Deno.test("compose: GreetingsGuard L2 strips greeting before parsing marker", async () => {
  const llm = `Здравствуйте, подобрали варианты.\n${CROSSSELL_MARKER}\nДокупают расходники.`;
  const out = await composeCatalogAnswer(
    {
      query: "лампа",
      outcome: mockOutcome("ok", [mockProduct()]),
      history: [],
      prevSoft404Streak: 0,
      onDelta: () => {},
    },
    mockDeps(llm),
  );
  assert(out.greeting_stripped !== null);
  assert(!out.text.toLowerCase().startsWith("здравствуйте"));
  assertStringIncludes(out.text, "подобрали варианты");
});

Deno.test("compose: cross-sell absent in LLM output (no marker) → not rendered", async () => {
  const out = await composeCatalogAnswer(
    {
      query: "выключатель",
      outcome: mockOutcome("ok", [mockProduct()]),
      history: [],
      prevSoft404Streak: 0,
      onDelta: () => {},
    },
    mockDeps("Подобрали варианты."),
  );
  assertEquals(out.crosssell.presentInLLM, false);
  assertEquals(out.crosssell.rendered, false);
  assertEquals(out.crosssell.violation, null);
});

Deno.test("compose: emits final text via onDelta exactly once", async () => {
  const deltas: string[] = [];
  await composeCatalogAnswer(
    {
      query: "x",
      outcome: mockOutcome("ok", [mockProduct()]),
      history: [],
      prevSoft404Streak: 0,
      onDelta: (d) => deltas.push(d),
    },
    mockDeps("Intro."),
  );
  assertEquals(deltas.length, 1);
  assertStringIncludes(deltas[0], "Intro.");
  assertStringIncludes(deltas[0], "**[Тестовый товар]");
});

Deno.test("compose normal with no_results products → fallback to formatter handles 0", async () => {
  // Edge-case: status=ok но products пуст (sanity).
  const out = await composeCatalogAnswer(
    {
      query: "x",
      outcome: mockOutcome("ok", []),
      history: [],
      prevSoft404Streak: 1,
      onDelta: () => {},
    },
    mockDeps("Intro."),
  );
  assertEquals(out.formatter.rendered, 0);
  // ok с 0 товаров → streak не reset (по контракту: products.length>0 → 0).
  // Текущая реализация: не reset, остаётся prev.
  assertEquals(out.newSoft404Streak, 1);
});

// chat-consultant-v2 / catalog-assembler-disallow_test.ts
//
// Stage F.5.8 — defense-in-depth тесты для disallowCrosssell.
//
// Покрытие:
//   • Pure helpers shouldDisallowCrosssellForPrice / shouldDisallowCrosssellForSearch:
//     все статусы, все ветки, никаких побочных эффектов.
//   • Регрессионная защита: G1/G2 контракты сохранены через прямой helper-вызов
//     (без полного assembler-моков, которые уже покрыты catalog-assembler_test.ts).
//
// Контракт спецификации (§5.4.1 + §11.5b + Core memory):
//   Cross-sell разрешён ТОЛЬКО при scenario='normal' = «есть валидная выдача».
//   Все остальные сценарии (clarify, error, soft_404, soft_fallback,
//   all_zero_price, out_of_domain) — запрет.

import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  shouldDisallowCrosssellForPrice,
  shouldDisallowCrosssellForSearch,
} from "./catalog-assembler.ts";
import type { SPriceOutcome } from "./s-price.ts";
import type { SearchOutcome } from "./catalog/search.ts";
import type { RawProduct } from "./catalog/api-client.ts";

// ─── Helpers ────────────────────────────────────────────────────────────────

const P = (id: number, price = 100): RawProduct => ({
  id,
  name: `p-${id}`,
  pagetitle: `p-${id}`,
  url: `/p/${id}`,
  price,
  vendor: "BrandX",
  article: `SKU${id}`,
});

function priceOutcome(overrides: Partial<SPriceOutcome>): SPriceOutcome {
  return {
    status: "ok",
    products: [],
    totalCount: 0,
    clarifySlot: null,
    zeroPriceLeak: 0,
    autoNarrowingAttempts: 0,
    branch: null,
    ms: 1,
    ...overrides,
  };
}

function searchOutcome(overrides: Partial<SearchOutcome>): SearchOutcome {
  return {
    status: "ok",
    products: [],
    totalFromApi: 0,
    zeroPriceFiltered: 0,
    postFilterDropped: 0,
    attempts: [],
    softFallbackContext: null,
    ms: 1,
    ...overrides,
  };
}

// ─── shouldDisallowCrosssellForPrice ────────────────────────────────────────

Deno.test("F.5.8 price: ok + show_all → cross-sell РАЗРЕШЁН (G2 контракт)", () => {
  const out = priceOutcome({ status: "ok", branch: "show_all", products: [P(1)] });
  assertEquals(shouldDisallowCrosssellForPrice(out), false);
});

Deno.test("F.5.8 price: ok + show_top → cross-sell РАЗРЕШЁН", () => {
  const out = priceOutcome({ status: "ok", branch: "show_top", products: [P(1)] });
  assertEquals(shouldDisallowCrosssellForPrice(out), false);
});

Deno.test("F.5.8 price: ok + clarify (status=clarify) → ЗАПРЕТ (G1 контракт)", () => {
  // В коде status='clarify' идёт со branch='clarify'. Status важнее.
  const out = priceOutcome({ status: "clarify", branch: "clarify" });
  assertEquals(shouldDisallowCrosssellForPrice(out), true);
});

Deno.test("F.5.8 price: status=error (breaker OPEN) → ЗАПРЕТ (главная цель F.5.8)", () => {
  const out = priceOutcome({ status: "error", branch: null });
  assertEquals(shouldDisallowCrosssellForPrice(out), true);
});

Deno.test("F.5.8 price: status=all_zero_price → ЗАПРЕТ", () => {
  const out = priceOutcome({ status: "all_zero_price", branch: null });
  assertEquals(shouldDisallowCrosssellForPrice(out), true);
});

Deno.test("F.5.8 price: status=empty → ЗАПРЕТ", () => {
  const out = priceOutcome({ status: "empty", branch: null });
  assertEquals(shouldDisallowCrosssellForPrice(out), true);
});

Deno.test("F.5.8 price: status=out_of_domain → ЗАПРЕТ", () => {
  const out = priceOutcome({ status: "out_of_domain", branch: null });
  assertEquals(shouldDisallowCrosssellForPrice(out), true);
});

Deno.test("F.5.8 price: ok + branch=null (защитный edge case) → ЗАПРЕТ", () => {
  // Если status='ok', но branch не выставлен — это аномалия (баг кода).
  // Помимо assertion в самом коде, helper страхует: запрещаем cross-sell.
  const out = priceOutcome({ status: "ok", branch: null });
  assertEquals(shouldDisallowCrosssellForPrice(out), true);
});

// ─── shouldDisallowCrosssellForSearch ───────────────────────────────────────

Deno.test("F.5.8 search: ok + товары → cross-sell РАЗРЕШЁН (S_CATALOG normal)", () => {
  const out = searchOutcome({ status: "ok", products: [P(1), P(2)] });
  assertEquals(shouldDisallowCrosssellForSearch(out), false);
});

Deno.test("F.5.8 search: ok + ноль товаров (degenerate) → ЗАПРЕТ", () => {
  // Защитный edge: api-client может вернуть ok+пусто (например, всё отфильтровано
  // post-filter'ом до возврата в assembler). Без товаров cross-sell не имеет смысла.
  const out = searchOutcome({ status: "ok", products: [] });
  assertEquals(shouldDisallowCrosssellForSearch(out), true);
});

Deno.test("F.5.8 search: soft_fallback → ЗАПРЕТ (§4.8: уточнение, не место для cross-sell)", () => {
  const out = searchOutcome({
    status: "soft_fallback",
    products: [P(1)],
    softFallbackContext: { droppedFacetCaption: "Цвет" },
  });
  assertEquals(shouldDisallowCrosssellForSearch(out), true);
});

Deno.test("F.5.8 search: empty → ЗАПРЕТ (Soft 404)", () => {
  const out = searchOutcome({ status: "empty", products: [] });
  assertEquals(shouldDisallowCrosssellForSearch(out), true);
});

Deno.test("F.5.8 search: empty_degraded → ЗАПРЕТ (Q3 quirk recovery)", () => {
  const out = searchOutcome({ status: "empty_degraded", products: [] });
  assertEquals(shouldDisallowCrosssellForSearch(out), true);
});

Deno.test("F.5.8 search: all_zero_price → ЗАПРЕТ (HARD BAN price=0)", () => {
  const out = searchOutcome({ status: "all_zero_price", products: [] });
  assertEquals(shouldDisallowCrosssellForSearch(out), true);
});

Deno.test("F.5.8 search: error (breaker OPEN) → ЗАПРЕТ (главная цель F.5.8)", () => {
  const out = searchOutcome({ status: "error", products: [], errorMessage: "circuit_breaker_open" });
  assertEquals(shouldDisallowCrosssellForSearch(out), true);
});

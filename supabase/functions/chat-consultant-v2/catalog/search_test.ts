// Deno-тесты для catalog/search.ts.
// Все API-вызовы замокированы; никакого live HTTP.
// Покрытие: word-boundary post-filter, статусы (ok/empty/soft_fallback/
// all_zero_price/empty_degraded/error), pagination, soft fallback gating.

import {
  assertEquals,
  assertExists,
  assert,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  search,
  tokenize,
  matchesWordBoundary,
  computeRemovalOrder,
  resolveDroppedCaption,
  type SearchInput,
  type SearchOutcome,
} from "./search.ts";
import type { ApiClientDeps, RawProduct } from "./api-client.ts";

// ─── helpers ────────────────────────────────────────────────────────────────

function makeFetch(
  handler: (url: string, init: RequestInit) => Promise<Response> | Response,
): typeof fetch {
  return ((url: string, init: RequestInit = {}) =>
    Promise.resolve(handler(String(url), init))) as unknown as typeof fetch;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function deps(fetchFn: typeof fetch): ApiClientDeps {
  return {
    baseUrl: "https://api.test",
    apiToken: "t",
    fetch: fetchFn,
    timeoutMs: { products: 500, categoryOptions: 500 },
  };
}

const P = (id: number, pagetitle: string, price = 100): RawProduct => ({
  id,
  name: pagetitle,
  pagetitle,
  url: `https://x.test/${id}`,
  price,
});

// ─── tokenize ───────────────────────────────────────────────────────────────

Deno.test("tokenize: latin + digits + spaces", () => {
  assertEquals(tokenize("abc 123 d"), ["abc", "123"]);
});

Deno.test("tokenize: cyrillic", () => {
  assertEquals(tokenize("Привет, мир"), ["привет", "мир"]);
});

Deno.test("tokenize: пунктуация считается разделителем", () => {
  assertEquals(tokenize("розетка-с-кабелем"), ["розетка", "кабелем"]);
});

Deno.test("tokenize: токены <2 chars дропаются", () => {
  assertEquals(tokenize("a bb ccc"), ["bb", "ccc"]);
});

Deno.test("tokenize: пустая строка → []", () => {
  assertEquals(tokenize(""), []);
});

// ─── matchesWordBoundary ────────────────────────────────────────────────────

Deno.test("WB: товар содержит слово запроса целиком → true", () => {
  const ok = matchesWordBoundary(P(1, "Widget Alpha 220V"), ["widget"]);
  assertEquals(ok, true);
});

Deno.test("WB: подстрочный матч НЕ считается (защита от шума API)", () => {
  // 'cat' внутри 'category' → не матчится.
  const ok = matchesWordBoundary(P(1, "Category Gamma"), ["cat"]);
  assertEquals(ok, false);
});

Deno.test("WB: пустые queryTokens → пропускаем всё (поиск без query)", () => {
  const ok = matchesWordBoundary(P(1, "anything"), []);
  assertEquals(ok, true);
});

Deno.test("WB: товар без pagetitle/name → отбрасываем", () => {
  const p: RawProduct = { id: 1, name: null, pagetitle: null, url: "/x", price: 1 };
  const ok = matchesWordBoundary(p, ["widget"]);
  assertEquals(ok, false);
});

Deno.test("WB: case-insensitive (cyrillic)", () => {
  const ok = matchesWordBoundary(P(1, "ЛАМПА Edison E27"), ["лампа"]);
  assertEquals(ok, true);
});

// ─── search: ok happy path ─────────────────────────────────────────────────

Deno.test("search: ok — strict вернул товары, post-filter оставил релевантные", async () => {
  const f = makeFetch(() => jsonResponse({
    data: {
      results: [P(1, "Widget Alpha"), P(2, "Other Beta"), P(3, "Widget Gamma")],
      total: 3,
    },
  }));

  const out = await search({ query: "widget", perPage: 12 }, deps(f));

  assertEquals(out.status, "ok");
  assertEquals(out.products.map((p) => p.id), [1, 3]);
  assertEquals(out.postFilterDropped, 1);
  assertExists(out.pagination);
  assertEquals(out.pagination!.page, 1);
  assertEquals(out.pagination!.perPage, 12);
  assertEquals(out.attempts.length, 1);
  assertEquals(out.attempts[0].label, "strict");
});

Deno.test("search: ok — без query пропускает всё (фасеты-only)", async () => {
  const f = makeFetch(() => jsonResponse({
    data: { results: [P(1, "X"), P(2, "Y")], total: 2 },
  }));
  const out = await search({ category: "some-cat" }, deps(f));
  assertEquals(out.status, "ok");
  assertEquals(out.products.length, 2);
  assertEquals(out.postFilterDropped, 0);
});

// ─── search: empty без soft fallback ────────────────────────────────────────

Deno.test("search: empty — без optionFilters soft fallback не вызывается", async () => {
  let calls = 0;
  const f = makeFetch(() => {
    calls++;
    return jsonResponse({ data: { results: [], total: 0 } });
  });
  const out = await search({ query: "abc" }, deps(f));
  assertEquals(out.status, "empty");
  assertEquals(calls, 1);
  assertEquals(out.attempts.length, 1);
});

Deno.test("search: empty — post-filter отбросил всё, без фильтров → 'empty'", async () => {
  let calls = 0;
  const f = makeFetch(() => {
    calls++;
    return jsonResponse({ data: { results: [P(1, "Other")], total: 1 } });
  });
  const out = await search({ query: "widget" }, deps(f));
  assertEquals(out.status, "empty");
  assertEquals(out.postFilterDropped, 1);
  assertEquals(calls, 1);
});

// ─── search: soft_fallback ─────────────────────────────────────────────────

Deno.test("search: soft_fallback — strict 0 с фильтрами, soft без фильтров даёт результат", async () => {
  let callIndex = 0;
  const f = makeFetch((url) => {
    callIndex++;
    if (callIndex === 1) {
      // Strict: с optionFilters.
      assert(url.includes("options%5Bk%5D%5B%5D=v"));
      return jsonResponse({ data: { results: [], total: 0 } });
    }
    // Soft fallback: без optionFilters.
    assert(!url.includes("options%5B"));
    return jsonResponse({
      data: { results: [P(1, "Widget Alpha"), P(2, "Widget Beta")], total: 2 },
    });
  });
  const out = await search({
    query: "widget",
    optionFilters: { k: ["v"] },
    optionFilterCaptions: { k: "Цвет" },
  }, deps(f));
  assertEquals(out.status, "soft_fallback");
  assertEquals(out.products.length, 2);
  assertEquals(out.attempts.length, 2);
  assertEquals(out.attempts[1].label, "soft_fallback");
  // §4.8.1: softFallbackContext заполнен caption-ом.
  assertExists(out.softFallbackContext);
  assertEquals(out.softFallbackContext!.droppedFacetCaption, "Цвет");
  assertEquals(out.attempts[1].droppedFacetKey, "k");
});

Deno.test("search: empty — strict 0 с фильтрами, soft тоже 0", async () => {
  const f = makeFetch(() => jsonResponse({ data: { results: [], total: 0 } }));
  const out = await search({
    query: "widget",
    optionFilters: { k: ["v"] },
  }, deps(f));
  assertEquals(out.status, "empty");
  assertEquals(out.attempts.length, 2);
  assertEquals(out.softFallbackContext, null);
});

// ─── §4.8.1: softFallbackContext invariants ─────────────────────────────────

Deno.test("§4.8.1: softFallbackContext === null при status='ok'", async () => {
  const f = makeFetch(() => jsonResponse({
    data: { results: [P(1, "Widget X")], total: 1 },
  }));
  const out = await search({ query: "widget" }, deps(f));
  assertEquals(out.status, "ok");
  assertEquals(out.softFallbackContext, null);
});

Deno.test("§4.8.1: softFallbackContext === null при status='empty' без фильтров", async () => {
  const f = makeFetch(() => jsonResponse({ data: { results: [], total: 0 } }));
  const out = await search({ query: "abc" }, deps(f));
  assertEquals(out.status, "empty");
  assertEquals(out.softFallbackContext, null);
});

Deno.test("§4.8.1: softFallbackContext === null при error/all_zero_price", async () => {
  // error
  const fErr = makeFetch(() => new Response("x", { status: 500 }));
  const oErr = await search({ query: "abc" }, deps(fErr));
  assertEquals(oErr.status, "error");
  assertEquals(oErr.softFallbackContext, null);

  // all_zero_price
  const fZ = makeFetch(() => jsonResponse({
    data: { results: [P(1, "X", 0)], total: 1 },
  }));
  const oZ = await search({ query: "abc" }, deps(fZ));
  assertEquals(oZ.status, "all_zero_price");
  assertEquals(oZ.softFallbackContext, null);
});

Deno.test("§4.8: прогрессивное снятие — по optionFilterOrder с конца, фиксируется ПЕРВЫЙ успех", async () => {
  // 2 фильтра: brand, color. Order = [brand, color]. Снимаем сначала color,
  // если empty — снимаем brand. На втором soft attempt API даёт товар.
  let callIndex = 0;
  const seenUrls: string[] = [];
  const f = makeFetch((url) => {
    callIndex++;
    seenUrls.push(url);
    if (callIndex === 1) {
      // strict: brand+color
      return jsonResponse({ data: { results: [], total: 0 } });
    }
    if (callIndex === 2) {
      // soft #1: сняли color, остался brand → ещё пусто
      return jsonResponse({ data: { results: [], total: 0 } });
    }
    // soft #2: сняли brand → есть товары
    return jsonResponse({ data: { results: [P(1, "Widget X")], total: 1 } });
  });
  const out = await search({
    query: "widget",
    optionFilters: { brand: ["acme"], color: ["red"] },
    optionFilterCaptions: { brand: "Бренд", color: "Цвет" },
    optionFilterOrder: ["brand", "color"],
  }, deps(f));
  assertEquals(out.status, "soft_fallback");
  assertEquals(out.products.length, 1);
  assertEquals(out.attempts.length, 3);
  // первый снятый — color (последний в order), второй — brand
  assertEquals(out.attempts[1].droppedFacetKey, "color");
  assertEquals(out.attempts[2].droppedFacetKey, "brand");
  // фиксируется caption ПОСЛЕДНЕГО снятого фильтра, который дал успех
  assertEquals(out.softFallbackContext!.droppedFacetCaption, "Бренд");
});

Deno.test("§4.8.1: caption fallback к key, если captions не передан", async () => {
  let callIndex = 0;
  const f = makeFetch(() => {
    callIndex++;
    if (callIndex === 1) return jsonResponse({ data: { results: [], total: 0 } });
    return jsonResponse({ data: { results: [P(1, "Widget X")], total: 1 } });
  });
  const out = await search({
    query: "widget",
    optionFilters: { brand: ["acme"] },
    // optionFilterCaptions НЕ передан
  }, deps(f));
  assertEquals(out.status, "soft_fallback");
  assertEquals(out.softFallbackContext!.droppedFacetCaption, "brand");
});

// ─── computeRemovalOrder unit ───────────────────────────────────────────────

Deno.test("computeRemovalOrder: order задан → reverse + дозаполнение осиротевших", () => {
  const out = computeRemovalOrder(["a", "b", "c"], ["a", "b", "c", "d"]);
  // c, b, a — из order в обратном порядке; d — осиротевший в конец
  assertEquals(out, ["c", "b", "a", "d"]);
});

Deno.test("computeRemovalOrder: order не задан → reverse filterKeys", () => {
  const out = computeRemovalOrder(undefined, ["a", "b", "c"]);
  assertEquals(out, ["c", "b", "a"]);
});

Deno.test("computeRemovalOrder: order содержит ключи, которых нет → они отбрасываются", () => {
  const out = computeRemovalOrder(["x", "a", "y"], ["a"]);
  assertEquals(out, ["a"]);
});

// ─── resolveDroppedCaption unit ─────────────────────────────────────────────

Deno.test("resolveDroppedCaption: возвращает caption из карты", () => {
  assertEquals(resolveDroppedCaption("brand", { brand: "Бренд" }), "Бренд");
});

Deno.test("resolveDroppedCaption: пустой caption → fallback к key", () => {
  assertEquals(resolveDroppedCaption("brand", { brand: "  " }), "brand");
});

Deno.test("resolveDroppedCaption: caption отсутствует → fallback к key", () => {
  assertEquals(resolveDroppedCaption("brand", {}), "brand");
});

// ─── search: статусы from api-client ────────────────────────────────────────

Deno.test("search: error — strict вернул HTTP 500 → escalation", async () => {
  const f = makeFetch(() => new Response("x", { status: 500 }));
  const out = await search({ query: "abc" }, deps(f));
  assertEquals(out.status, "error");
  assertEquals(out.products.length, 0);
});

Deno.test("search: all_zero_price — все товары price=0", async () => {
  const f = makeFetch(() => jsonResponse({
    data: { results: [P(1, "X", 0), P(2, "Y", 0)], total: 2 },
  }));
  const out = await search({ query: "abc" }, deps(f));
  assertEquals(out.status, "all_zero_price");
  assertEquals(out.products.length, 0);
});

// (REMOVED Q3 empty_degraded test) — non-ASCII keys валидны, recovery удалён.

// ─── pagination ────────────────────────────────────────────────────────────

Deno.test("search: pagination — totalPages = ceil(total/perPage)", async () => {
  const f = makeFetch(() => jsonResponse({
    data: { results: [P(1, "Widget X")], total: 25 },
  }));
  const out = await search({ query: "widget", perPage: 12, page: 2 }, deps(f));
  assertEquals(out.status, "ok");
  assertEquals(out.pagination!.totalPages, 3); // ceil(25/12)=3
  assertEquals(out.pagination!.page, 2);
});

// ─── HARD invariant K1: search не добавляет min/max_price сам ───────────────

Deno.test("K1: search НЕ добавляет min_price/max_price если их нет на входе", async () => {
  let calledUrl = "";
  const f = makeFetch((url) => {
    calledUrl = url;
    return jsonResponse({ data: { results: [P(1, "Widget X")], total: 1 } });
  });
  await search({ query: "widget" }, deps(f));
  assert(!calledUrl.includes("min_price="));
  assert(!calledUrl.includes("max_price="));
});

Deno.test("K1: search прокидывает minPrice/maxPrice ТОЛЬКО когда заданы пользователем", async () => {
  let calledUrl = "";
  const f = makeFetch((url) => {
    calledUrl = url;
    return jsonResponse({ data: { results: [P(1, "Widget X")], total: 1 } });
  });
  await search({ query: "widget", minPrice: 100, maxPrice: 500 }, deps(f));
  assert(calledUrl.includes("min_price=100"));
  assert(calledUrl.includes("max_price=500"));
});

// ─── article (SKU) — пропускает word-boundary post-filter ──────────────────

Deno.test("search: article — post-filter не применяется (SKU-направленный поиск)", async () => {
  const f = makeFetch(() => jsonResponse({
    data: { results: [P(1, "Anything Random")], total: 1 },
  }));
  const out = await search({ article: "ABC-123" }, deps(f));
  assertEquals(out.status, "ok");
  assertEquals(out.products.length, 1);
  assertEquals(out.postFilterDropped, 0);
});

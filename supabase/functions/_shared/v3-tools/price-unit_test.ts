import { assertEquals, assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { extractUnit } from "./search-catalog.ts";
import { executeRenderProducts, formatPriceUnitSuffix, prioritizeWarehouses } from "./render.ts";
import type { ProductCache } from "./types.ts";

Deno.test("extractUnit: по подписи характеристики", () => {
  assertEquals(
    extractUnit({ options: [{ key: "cvet", caption_ru: "Цвет", value_ru: "белый" }, { key: "x", caption_ru: "Единица измерения", value_ru: "м" }] }),
    "м",
  );
});

Deno.test("extractUnit: по ключу характеристики", () => {
  assertEquals(
    extractUnit({ options: [{ key: "edinica_izmereniya__Өlsheu_bіrlіgі", caption_ru: "Өlsheu", value_ru: "шт" }] }),
    "шт",
  );
});

Deno.test("extractUnit: нет характеристики → null", () => {
  assertEquals(extractUnit({ options: [{ key: "cvet", caption_ru: "Цвет", value_ru: "белый" }] }), null);
  assertEquals(extractUnit({}), null);
});

Deno.test("суффикс: метры показываем, штуки нет", () => {
  assertEquals(formatPriceUnitSuffix("м"), "/м");
  assertEquals(formatPriceUnitSuffix("компл"), "/компл");
  assertEquals(formatPriceUnitSuffix("шт"), "");
  assertEquals(formatPriceUnitSuffix("шт."), "");
  assertEquals(formatPriceUnitSuffix(null), "");
});

function cacheWith(unit: string | null, warehouses?: Array<{ city: string; qty: number }>): ProductCache {
  const m = new Map();
  m.set("1", {
    id: "1", pagetitle: "Кабель", vendor: "X", price: 309, unit,
    stock: "in_stock" as const, short_traits: [], url: "https://e.x/1", warehouses,
  });
  return m as unknown as ProductCache;
}

Deno.test("render: цена за метр", () => {
  const r = executeRenderProducts({ product_ids: ["1"] }, cacheWith("м"));
  if (!r.ok) throw new Error("expected ok");
  assertStringIncludes(r.markdown, "Цена: *309* ₸/м");
});

Deno.test("render: штучный товар без суффикса", () => {
  const r = executeRenderProducts({ product_ids: ["1"] }, cacheWith("шт"));
  if (!r.ok) throw new Error("expected ok");
  assertStringIncludes(r.markdown, "Цена: *309* ₸\n");
});

Deno.test("render: остатки используют метры из API", () => {
  const r = executeRenderProducts(
    { product_ids: ["1"] },
    cacheWith("м", [{ city: "Караганда", qty: 4648 }]),
  );
  if (!r.ok) throw new Error("expected ok");
  assertStringIncludes(r.markdown, "Цена: *309* ₸/м");
  assertStringIncludes(r.markdown, "Наличие: Караганда (4648 м)");
});

Deno.test("render: остатки штучного товара используют штуки из API", () => {
  const r = executeRenderProducts(
    { product_ids: ["1"] },
    cacheWith("шт", [{ city: "Алматы", qty: 12 }]),
  );
  if (!r.ok) throw new Error("expected ok");
  assertStringIncludes(r.markdown, "Наличие: Алматы (12 шт)");
});

Deno.test("render: остатки используют другую единицу буквально", () => {
  const r = executeRenderProducts(
    { product_ids: ["1"] },
    cacheWith("компл", [{ city: "Астана", qty: 3 }]),
  );
  if (!r.ok) throw new Error("expected ok");
  assertStringIncludes(r.markdown, "Цена: *309* ₸/компл");
  assertStringIncludes(r.markdown, "Наличие: Астана (3 компл)");
});

Deno.test("render: при неизвестной единице остатки не выдумывают штуки", () => {
  const r = executeRenderProducts(
    { product_ids: ["1"] },
    cacheWith(null, [{ city: "Шымкент", qty: 7 }]),
  );
  if (!r.ok) throw new Error("expected ok");
  assertStringIncludes(r.markdown, "Наличие: Шымкент (7)");
});

Deno.test("render: не обещает непроверенные дополнительные варианты", () => {
  const r = executeRenderProducts(
    { product_ids: ["1"], total_available: 25 },
    cacheWith("шт"),
  );
  if (!r.ok) throw new Error("expected ok");
  if (r.markdown.includes("И ещё")) throw new Error(r.markdown);
});

Deno.test("render: бизнес-склады показываются после обычных складов независимо от остатка", () => {
  const ordered = prioritizeWarehouses([
    { city: "Иргели", qty: 5000 },
    { city: "Алматы", qty: 12 },
    { city: "Чинт Астана", qty: 7000 },
    { city: "Караганда", qty: 7 },
  ]);
  assertEquals(ordered.map((item) => item.city), ["Алматы", "Караганда", "Чинт Астана", "Иргели"]);
});

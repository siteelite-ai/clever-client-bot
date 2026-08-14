import { assertEquals, assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { extractUnit } from "./search-catalog.ts";
import { executeRenderProducts, formatPriceUnitSuffix } from "./render.ts";
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

function cacheWith(unit: string | null): ProductCache {
  const m = new Map();
  m.set("1", {
    id: "1", pagetitle: "Кабель", vendor: "X", price: 309, unit,
    stock: "in_stock" as const, short_traits: [], url: "https://e.x/1",
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

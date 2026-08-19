import { assert, assertEquals, assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { deterministicSeriesExplanation, safeSeriesTraits } from "./series-explanation.ts";

Deno.test("series explanation fallback uses only current catalog evidence", () => {
  const text = deterministicSeriesExplanation("Расскажи, чем хороша серия Галант?", [
    {
      id: "1",
      pagetitle: "Розетка Gallant с заземлением и шторками",
      vendor: "Werkel",
      price: 100,
      stock: "in_stock",
      url: "https://220volt.kz/catalog/test/item/",
      short_traits: [
        "Материал: поликарбонат",
        "Заземление: есть",
        "Файл: /uploads/product_docs/catalog_item.pdf",
        "Идентификатор сайта: ITEM_123_ABC",
      ],
    },
  ]);

  assertStringIncludes(text, "Серия Галант");
  assertStringIncludes(text, "Werkel");
  assertStringIncludes(text, "особенности и преимущества");
  assertStringIncludes(text, "Материал: поликарбонат");
  assert(!text.includes("100"));
  assert(!text.includes("https://"));
  assert(!text.includes("uploads"));
  assert(!text.includes("ITEM_123_ABC"));
  assertEquals(text.includes("Schneider"), false);
});

Deno.test("series evidence removes file paths but preserves customer traits", () => {
  assertEquals(safeSeriesTraits([
    "Диапазон температур: -40...80",
    "Файл: /uploads/product_docs/item.pdf",
    "Ссылка: https://example.test/file.pdf",
  ]), ["Диапазон температур: -40...80"]);
});

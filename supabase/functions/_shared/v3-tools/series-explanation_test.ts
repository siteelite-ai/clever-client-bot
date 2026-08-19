import { assert, assertEquals, assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { deterministicSeriesExplanation } from "./series-explanation.ts";

Deno.test("series explanation fallback uses only current catalog evidence", () => {
  const text = deterministicSeriesExplanation("Расскажи, чем хороша серия Галант?", [
    {
      id: "1",
      pagetitle: "Розетка Gallant с заземлением и шторками",
      vendor: "Werkel",
      price: 100,
      stock: "in_stock",
      url: "https://220volt.kz/catalog/test/item/",
      short_traits: ["Материал: поликарбонат", "Заземление: есть"],
    },
  ]);

  assertStringIncludes(text, "Серия Галант");
  assertStringIncludes(text, "Werkel");
  assertStringIncludes(text, "особенности и преимущества");
  assertStringIncludes(text, "Материал: поликарбонат");
  assert(!text.includes("100"));
  assert(!text.includes("https://"));
  assertEquals(text.includes("Schneider"), false);
});

import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { classifyShrinkFitRequest, extractDimensionalSpan, selectDimensionallyCompatibleProducts } from "./dimensional-fit-policy.ts";
import type { ProductRef } from "./types.ts";

function product(id: string, title: string): ProductRef {
  return { id, pagetitle: title, vendor: null, price: Number(id) || 1, stock: "in_stock", short_traits: [] };
}

Deno.test("shrink-fit classifier extracts the object dimension from both client phrasings", () => {
  assertEquals(classifyShrinkFitRequest("подбери термоусадочную трубку для кабеля диаметром 12 мм")?.objectDiameterMm, 12);
  assertEquals(classifyShrinkFitRequest("подбери трубку ТТУ на кабель диаметром 10 мм")?.objectDiameterMm, 10);
  assertEquals(classifyShrinkFitRequest("покажи трубку 12/6"), null);
});

Deno.test("dimensional fit uses both sides of the catalog size pair", () => {
  const candidates = [
    product("1", "Трубка ТТУ 12/6"),
    product("2", "Трубка ТТУ 16/8"),
    product("3", "Трубка 19,1/9,55"),
    product("4", "Трубка 16,0/4,0 мм"),
  ];
  assertEquals(extractDimensionalSpan(candidates[2]), { before: 19.1, after: 9.55 });
  assertEquals(selectDimensionallyCompatibleProducts(candidates, 12).map((item) => item.id), ["2", "3", "4"]);
  assertEquals(selectDimensionallyCompatibleProducts(candidates, 10).map((item) => item.id), ["1", "2", "3", "4"]);
});

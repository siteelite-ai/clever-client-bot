import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  classifyExactCompoundMarkingRequest,
  selectExactCompoundMarkedProducts,
} from "./exact-compound-marking-policy.ts";
import type { ProductRef } from "./types.ts";

const product = (id: string, pagetitle: string, price: number): ProductRef => ({
  id,
  pagetitle,
  price,
  vendor: null,
  stock: "in_stock",
  short_traits: [],
});

Deno.test("exact compound route extracts a price-sorted catalog query", () => {
  assertEquals(classifyExactCompoundMarkingRequest("найди кабель ввг 2*1,5 самый дешевый"), {
    query: "кабель ввг 2*1,5",
    first: 2,
    second: 1.5,
    priceDirection: "cheapest",
  });
  assertEquals(classifyExactCompoundMarkingRequest("Подойдёт ли кабель ВВГ 2×1,5?"), null);
});

Deno.test("exact compound shortcut yields semantic multi-attribute requests to the consultant", () => {
  assertEquals(classifyExactCompoundMarkingRequest("какой есть кабель ввг 3*1,5 негорючий покажи все позиции"), null);
  assertEquals(classifyExactCompoundMarkingRequest("нужен медный кабель негорючий 2*1,5"), null);
});

Deno.test("exact compound route rejects a nearby size and returns the cheapest exact match", () => {
  const request = classifyExactCompoundMarkingRequest("найди кабель ввг 2*1,5 самый дешевый")!;
  const selected = selectExactCompoundMarkedProducts([
    product("wrong", "Кабель ВВГ нг 4*2,5", 100),
    product("exact-expensive", "Кабель ВВГ 2×1.5", 316),
    product("exact-cheapest", "Кабель ВВГ нг LS 2*1,5", 283),
  ], request);

  assertEquals(selected.map((item) => item.id), ["exact-cheapest"]);
});

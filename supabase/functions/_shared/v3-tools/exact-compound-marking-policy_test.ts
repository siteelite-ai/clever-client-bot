import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  canonicalizeCompoundMarkingForCatalog,
  classifyExactCompoundMarkingRequest,
  extractExplicitCompoundMarking,
  productTitleMatchesExplicitCompoundMarking,
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

Deno.test("explicit compound marking is a generic final-render invariant", () => {
  const marking = extractExplicitCompoundMarking("нужен медный огнестойкий кабель 2*1,5");
  assertEquals(marking, { first: 2, second: 1.5 });

  assertEquals(productTitleMatchesExplicitCompoundMarking("Кабель ВВГнг 2×1.5", marking!), true);
  assertEquals(productTitleMatchesExplicitCompoundMarking("Кабель КПСнг 2х1,50", marking!), true);
  assertEquals(productTitleMatchesExplicitCompoundMarking("Кабель ВВГнг 4*1,5", marking!), false);
  assertEquals(productTitleMatchesExplicitCompoundMarking("Провод СИП 2*16", marking!), false);
  assertEquals(productTitleMatchesExplicitCompoundMarking("Кабель огнестойкий без размера в названии", marking!), false);
});

Deno.test("ordinary numeric requirements do not become compound marking constraints", () => {
  assertEquals(extractExplicitCompoundMarking("светильник для комнаты 25 м² до 5000 тенге"), null);
});

Deno.test("compound catalog syntax changes punctuation without changing the model's words", () => {
  assertEquals(canonicalizeCompoundMarkingForCatalog("ВВГнг 2х1.5"), "ВВГнг 2*1,5");
  assertEquals(canonicalizeCompoundMarkingForCatalog("кабель ВВГ нг 2 × 1,50"), "кабель ВВГ нг 2*1,50");
  assertEquals(canonicalizeCompoundMarkingForCatalog("светильник 5000 лм"), "светильник 5000 лм");
});

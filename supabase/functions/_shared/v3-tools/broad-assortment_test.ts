import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { broadAssortmentNeedsClarification, buildBroadAssortmentClarification, extractBroadAssortmentScope, isBroadAssortmentRequest, resolvePendingBroadAssortmentScope } from "./broad-assortment.ts";
import type { DiscoverCategoryOk } from "./types.ts";

const discover: DiscoverCategoryOk = {
  ok: true,
  category: { id: 1, pagetitle: "Gallant", total_products: 84 },
  facets: [],
  leaf_categories: [
    { id: 2, pagetitle: "Розетки" },
    { id: 3, pagetitle: "Выключатели" },
  ],
};

Deno.test("broad assortment is structural and does not capture an exact all-items filter", () => {
  assert(isBroadAssortmentRequest("покажи ассортимент Gallant на сайте"));
  assertEquals(isBroadAssortmentRequest("покажи все позиции ВВГнг 3×1,5"), false);
  assert(broadAssortmentNeedsClarification(true, discover, 3));
  assert(buildBroadAssortmentClarification(discover).includes("Розетки"));
});

Deno.test("broad assortment scope is extracted structurally without a brand dictionary", () => {
  assertEquals(extractBroadAssortmentScope("покажи ассортимент Gallant на сайте"), "Gallant");
  assertEquals(extractBroadAssortmentScope("Покажи ассортимент бренда Schneider Electric в каталоге"), "Schneider Electric");
  assertEquals(extractBroadAssortmentScope("покажи весь модельный ряд «Atlas Design»"), "Atlas Design");
  assertEquals(extractBroadAssortmentScope("покажи ассортимент на сайте"), null);
});

Deno.test("pending broad scope is accepted only when customer history proves it", () => {
  const slots = { pending_clarification: { question: "Какой раздел?", options: ["Розетки", "Выключатели"], scope: { kind: "broad_assortment", token: "Gallant" } } };
  assertEquals(resolvePendingBroadAssortmentScope(slots, [
    { role: "user", content: "покажи ассортимент Gallant на сайте" },
    { role: "assistant", content: "Какой раздел?" },
  ]), "Gallant");
  assertEquals(resolvePendingBroadAssortmentScope(slots, [
    { role: "user", content: "покажи ассортимент другой марки" },
  ]), null);
});

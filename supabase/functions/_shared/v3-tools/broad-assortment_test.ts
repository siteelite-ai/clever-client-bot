import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { broadAssortmentNeedsClarification, buildBroadAssortmentClarification, isBroadAssortmentRequest } from "./broad-assortment.ts";
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


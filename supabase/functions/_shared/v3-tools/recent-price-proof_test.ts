import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { compactRecentProducts } from "./recent-product-evidence.ts";
import {
  exactRecentPriceSkuFromSearch,
  proveRecentPriceSet,
} from "./recent-price-proof.ts";
import type { ProductFull } from "./types.ts";

function product(
  id: string,
  price: number,
  overrides: Partial<ProductFull> = {},
): ProductFull {
  return {
    id,
    pagetitle: "Кабель с одинаковым названием",
    vendor: null,
    price,
    stock: "in_stock",
    unit: "м",
    short_traits: [],
    url: `https://220volt.kz/catalog/kabeli/provoda/product-${id}/`,
    warehouse_evidence: "positive",
    warehouses: [{ city: "Караганда", qty: 2 }],
    ...overrides,
  };
}

const products = [product("a", 400), product("b", 300), product("c", 500)];
const evidence = compactRecentProducts(products, "2026-10-09T10:00:00.000Z");

Deno.test("recent price proof compares all three refreshed identities and both directions", () => {
  const cheapest = proveRecentPriceSet(evidence, products, "cheapest");
  assertEquals(cheapest.ok, true);
  if (cheapest.ok) {
    assertEquals(cheapest.winner.id, "b");
    assertEquals(cheapest.compared_count, 3);
    assertEquals(cheapest.unit, "м");
  }
  const expensive = proveRecentPriceSet(evidence, products, "expensive");
  assertEquals(expensive.ok, true);
  if (expensive.ok) assertEquals(expensive.winner.id, "c");
});

Deno.test("recent price proof cannot choose a minimum after one of three refreshes is missing", () => {
  assertEquals(
    proveRecentPriceSet(evidence, [products[0], null, products[2]], "cheapest"),
    { ok: false, reason: "incomplete_set" },
  );
});

Deno.test("recent price proof refuses to compare metres and pieces", () => {
  assertEquals(
    proveRecentPriceSet(evidence, [
      products[0],
      product("b", 300, { unit: "шт" }),
      products[2],
    ], "cheapest"),
    { ok: false, reason: "mixed_units" },
  );
});

Deno.test("recent price proof rejects a different SKU with the same title or a changed URL", () => {
  const cache = new Map(products.map((item) => [item.id, item]));
  assertEquals(
    exactRecentPriceSkuFromSearch(evidence[0], [products[1], products[0]], cache)?.id,
    "a",
  );
  assertEquals(
    exactRecentPriceSkuFromSearch(evidence[0], [products[1]], cache),
    null,
  );
  assertEquals(
    proveRecentPriceSet(evidence, [products[1], products[1], products[2]], "cheapest"),
    { ok: false, reason: "identity_mismatch" },
  );
  assertEquals(
    proveRecentPriceSet(evidence, [
      products[0],
      product("b", 300, {
        url: "https://220volt.kz/catalog/kabeli/provoda/other-product-b/",
      }),
      products[2],
    ], "cheapest"),
    { ok: false, reason: "identity_mismatch" },
  );
});

Deno.test("recent price proof needs positive live warehouse evidence and known units", () => {
  assertEquals(
    proveRecentPriceSet(evidence, [
      products[0],
      product("b", 300, { warehouse_evidence: "missing", warehouses: [] }),
      products[2],
    ], "cheapest"),
    { ok: false, reason: "unverified_stock" },
  );
  assertEquals(
    proveRecentPriceSet(evidence, [
      products[0],
      product("b", 300, { unit: null }),
      products[2],
    ], "cheapest"),
    { ok: false, reason: "unverified_unit" },
  );
});

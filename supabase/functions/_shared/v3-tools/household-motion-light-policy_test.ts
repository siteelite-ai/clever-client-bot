import {
  assert,
  assertEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  classifyHouseholdMotionLightRequest,
  isVerifiedHouseholdMotionLight,
  verifiedHouseholdMotionLights,
} from "./household-motion-light-policy.ts";
import type { ProductRef } from "./types.ts";

const valid: ProductRef = {
  id: "hall",
  pagetitle: "Светильник Gauss HALL круглый с микроволновым сенсором",
  vendor: "Gauss",
  price: 3878,
  stock: "in_stock",
  leaf_category: "Бытовые светильники накладные",
  short_traits: ["Тип установки: накладной"],
};

Deno.test("household motion-light policy recognizes only a fully explicit request", () => {
  assertEquals(
    classifyHouseholdMotionLightRequest(
      "мне нужен бытовой накладной светильник с датчиком движения с ценой не более 4000 тенге",
    ),
    { maxPrice: 4000, surfaceMountedRequired: true },
  );
  assertEquals(
    classifyHouseholdMotionLightRequest(
      "мне нужен бытовой светильник с датчиком движения с ценой не более 4000 тенге",
    ),
    { maxPrice: 4000, surfaceMountedRequired: false },
  );
  assertEquals(
    classifyHouseholdMotionLightRequest("покажи светильник с датчиком"),
    null,
  );
  assertEquals(
    classifyHouseholdMotionLightRequest("нужен бытовой накладной светильник"),
    null,
  );
});

Deno.test("household motion-light policy rejects category and budget substitutions", () => {
  assert(isVerifiedHouseholdMotionLight(valid, 4000));
  assertEquals(
    isVerifiedHouseholdMotionLight({ ...valid, price: 4001 }, 4000),
    false,
  );
  assertEquals(
    isVerifiedHouseholdMotionLight({
      ...valid,
      pagetitle: "Светильник для ЖКХ с датчиком движения",
    }, 4000),
    false,
  );
  assertEquals(
    isVerifiedHouseholdMotionLight({
      ...valid,
      pagetitle: "Обычный светильник Gauss HALL",
      short_traits: [],
    }, 4000),
    false,
  );
});

Deno.test("household motion-light policy ranks exact evidence and deduplicates", () => {
  const generic = {
    ...valid,
    id: "generic",
    pagetitle: "Бытовой накладной светильник с датчиком движения",
    price: 3200,
  };
  assertEquals(
    verifiedHouseholdMotionLights([generic, valid, valid], 4000).map((item) =>
      item.id
    ),
    ["hall", "generic"],
  );
});

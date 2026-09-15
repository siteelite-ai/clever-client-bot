import {
  assert,
  assertEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  classifyHouseholdMotionLightRequest,
  HOUSEHOLD_MOTION_LIGHT_CATALOG_QUERIES,
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

Deno.test("motion-light retrieval uses class and feature terms without product identities", () => {
  assertEquals(HOUSEHOLD_MOTION_LIGHT_CATALOG_QUERIES, [
    "светильник с датчиком",
    "светильник с микроволновым сенсором",
    "датчик движения",
  ]);
  assertEquals(
    HOUSEHOLD_MOTION_LIGHT_CATALOG_QUERIES.some((query) => /gauss|hall/iu.test(query)),
    false,
  );
});

Deno.test("motion-light policy preserves optional household and mount constraints", () => {
  assertEquals(
    classifyHouseholdMotionLightRequest(
      "мне нужен бытовой накладной светильник с датчиком движения с ценой не более 4000 тенге",
    ),
    { maxPrice: 4000, surfaceMountedRequired: true, householdRequired: true },
  );
  assertEquals(
    classifyHouseholdMotionLightRequest(
      "мне нужен бытовой светильник с датчиком движения с ценой не более 4000 тенге",
    ),
    { maxPrice: 4000, surfaceMountedRequired: false, householdRequired: true },
  );
  assertEquals(
    classifyHouseholdMotionLightRequest(
      "мне нужен светильник с датчиком движения с ценой не более 4000 тенге",
    ),
    { maxPrice: 4000, surfaceMountedRequired: false, householdRequired: false },
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
  assertEquals(
    isVerifiedHouseholdMotionLight({
      ...valid,
      id: "standalone-sensor",
      pagetitle: "Датчик движения бытовой",
      leaf_category: "Датчики движения",
      short_traits: ["Способ монтажа: накладной"],
      description_excerpt: "Автоматически включает светильник при движении.",
    }, 4000),
    false,
  );
});

Deno.test("household motion-light policy ranks exact evidence and deduplicates", () => {
  const residential = {
    ...valid,
    id: "residential",
    pagetitle: "Светильник настенно-потолочный с датчиком движения",
    leaf_category: "Светильники",
    short_traits: ["Способ монтажа: настенно-потолочный", "С датчиком движения: да"],
    description_excerpt: "Для внутреннего освещения жилых и общественных помещений.",
    price: 3719,
  };
  const industrialSurface = {
    ...valid,
    id: "industrial",
    pagetitle: "Светильник накладной с датчиком движения",
    leaf_category: "Светильники",
    short_traits: ["Способ монтажа: накладной", "С датчиком движения: да"],
    description_excerpt: "Для наружного освещения производственных и складских помещений.",
    price: 2800,
  };
  assertEquals(
    verifiedHouseholdMotionLights([industrialSurface, residential, valid, valid], 4000).map((item) =>
      item.id
    ),
    ["residential", "hall"],
  );
});

Deno.test("generic motion-light policy requires the feature without inventing a use class", () => {
  const utilitySensor = {
    ...valid,
    id: "utility",
    pagetitle: "Светильник для ЖКХ с датчиком движения SNR",
    leaf_category: "Светильники",
    short_traits: [],
    price: 2500,
  };
  assertEquals(isVerifiedHouseholdMotionLight(utilitySensor, 4000, false, false), true);
  assertEquals(isVerifiedHouseholdMotionLight(utilitySensor, 4000, false, true), false);
  assertEquals(isVerifiedHouseholdMotionLight({
    ...utilitySensor,
    pagetitle: "Обычный светильник",
  }, 4000, false, false), false);
});

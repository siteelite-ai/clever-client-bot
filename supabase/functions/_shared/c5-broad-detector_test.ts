import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { detectUnderspecifiedBroad } from "./c5-broad-detector.ts";

Deno.test("C5 detector: canonical case «светодиод 25м²» (single-word category + 1 modifier)", () => {
  const r = detectUnderspecifiedBroad({
    intent: "catalog",
    has_product_name: false,
    is_replacement: false,
    sub_intent: null,
    product_category: "светодиод",
    search_modifiers: ["25м2"],
  });
  assertEquals(r.triggered, true);
  assertEquals(r.reason, "broad_single_word_category");
});

Deno.test("C5 detector: trigger when no category + 1+ modifiers", () => {
  const r = detectUnderspecifiedBroad({
    intent: "catalog",
    has_product_name: false,
    search_modifiers: ["25м²"],
  });
  assertEquals(r.triggered, true);
  assertEquals(r.reason, "no_category");
});

Deno.test("C5 detector: trigger when single-word category + ≥2 modifiers (multi-mods reason)", () => {
  const r = detectUnderspecifiedBroad({
    intent: "catalog",
    has_product_name: false,
    sub_intent: "facets",
    product_category: "светильник",
    search_modifiers: ["светодиод", "потолочный"],
  });
  assertEquals(r.triggered, true);
  assertEquals(r.reason, "broad_single_word_category_multi_mods");
});

Deno.test("C5 detector: NO trigger when has_product_name=true", () => {
  const r = detectUnderspecifiedBroad({
    intent: "catalog",
    has_product_name: true,
    product_category: "автомат",
    search_modifiers: ["IEK", "16А", "C"],
  });
  assertEquals(r.triggered, false);
  assertEquals(r.reason, "has_product_name");
});

Deno.test("C5 detector: NO trigger when intent != catalog", () => {
  const r = detectUnderspecifiedBroad({
    intent: "info",
    has_product_name: false,
    search_modifiers: ["a", "b"],
  });
  assertEquals(r.triggered, false);
  assertEquals(r.reason, "intent_not_catalog");
});

Deno.test("C5 detector: NO trigger when is_replacement=true", () => {
  const r = detectUnderspecifiedBroad({
    intent: "catalog",
    has_product_name: false,
    is_replacement: true,
    search_modifiers: ["a"],
  });
  assertEquals(r.triggered, false);
  assertEquals(r.reason, "is_replacement");
});

Deno.test("C5 detector: NO trigger when sub_intent='accessory_for'", () => {
  const r = detectUnderspecifiedBroad({
    intent: "catalog",
    has_product_name: false,
    sub_intent: "accessory_for",
    search_modifiers: ["a"],
  });
  assertEquals(r.triggered, false);
});

Deno.test("C5 detector: NO trigger when 0 modifiers", () => {
  const r = detectUnderspecifiedBroad({
    intent: "catalog",
    has_product_name: false,
    product_category: null,
    search_modifiers: [],
  });
  assertEquals(r.triggered, false);
  assertEquals(r.reason, "no_modifiers");
});

Deno.test("C5 detector: NO trigger when multi-word category (specific enough)", () => {
  const r = detectUnderspecifiedBroad({
    intent: "catalog",
    has_product_name: false,
    product_category: "автоматический выключатель",
    search_modifiers: ["IEK", "16А", "C"],
  });
  assertEquals(r.triggered, false);
  assertEquals(r.reason, "category_specific_enough");
});

Deno.test("C5 detector: handles non-array modifiers gracefully", () => {
  const r = detectUnderspecifiedBroad({
    intent: "catalog",
    has_product_name: false,
    search_modifiers: "not an array" as unknown,
  });
  assertEquals(r.triggered, false);
  assertEquals(r.modifiersCount, 0);
  assertEquals(r.reason, "no_modifiers");
});

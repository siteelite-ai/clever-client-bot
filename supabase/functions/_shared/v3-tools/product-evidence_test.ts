import { assertEquals, assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { normalizeProductUrl, sanitizeCatalogDescription } from "./search-catalog.ts";

Deno.test("sanitizeCatalogDescription: HTML превращается в ограниченный плоский текст", () => {
  const value = sanitizeCatalogDescription(
    '<p>Модель оборудована <b>микроволновым сенсором</b>.</p><script>alert(1)</script>',
  );
  assertEquals(value, "Модель оборудована микроволновым сенсором.");
});

Deno.test("sanitizeCatalogDescription: пустое значение остаётся неизвестным", () => {
  assertEquals(sanitizeCatalogDescription(null), null);
  assertEquals(sanitizeCatalogDescription("   "), null);
});

Deno.test("normalizeProductUrl: принимает только глубокую карточку 220volt", () => {
  assertEquals(
    normalizeProductUrl("https://www.220volt.kz/catalog/a/b/product-name/?utm_source=x#top"),
    "https://220volt.kz/catalog/a/b/product-name/",
  );
  assertEquals(
    normalizeProductUrl("/catalog/a/b/product-name"),
    "https://220volt.kz/catalog/a/b/product-name/",
  );
});

Deno.test("normalizeProductUrl: категории и внешние ссылки блокируются", () => {
  assertEquals(normalizeProductUrl("https://220volt.kz/catalog/a/b/"), null);
  assertEquals(normalizeProductUrl("https://evil.example/catalog/a/b/product/"), null);
  assertEquals(normalizeProductUrl("javascript:alert(1)"), null);
});

Deno.test("sanitizeCatalogDescription: сохраняет доказательный признак", () => {
  const value = sanitizeCatalogDescription("Данная модель оборудована микроволновым сенсором движения");
  if (!value) throw new Error("description missing");
  assertStringIncludes(value, "микроволновым сенсором");
});

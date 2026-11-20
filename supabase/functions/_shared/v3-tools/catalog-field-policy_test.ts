import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { isAdministrativeCatalogField } from "./catalog-field-policy.ts";

Deno.test("catalog field policy removes administrative schema across languages", () => {
  for (const field of [
    { key: "naimenovanie_na_kazahskom_yazyke", caption: "Наименование на казахском языке" },
    { key: "identifikator_sayta", caption: "Идентификатор сайта" },
    { key: "kodnomenklatury", caption: "Код номенклатуры" },
    { key: "fayl", caption: "Файл" },
    { key: "videofayly", caption: "Видеофайлы" },
    { key: "video_files", caption: "Video files" },
    { key: "populyarnyy", caption: "Популярный" },
    { key: "poiskovyy_zapros", caption: "Поисковый запрос" },
    { key: "search_keywords", caption: "Search keywords" },
  ]) assertEquals(isAdministrativeCatalogField(field), true, JSON.stringify(field));
});

Deno.test("catalog field policy preserves selectable and identity facets", () => {
  for (const field of [
    { key: "kolichestvo_ghil", caption: "Количество жил" },
    { key: "nominalynoe_napryaghenie", caption: "Номинальное напряжение" },
    { key: "brend", caption: "Бренд" },
    { key: "seriya", caption: "Серия" },
    { key: "cvet", caption: "Цвет" },
  ]) assertEquals(isAdministrativeCatalogField(field), false, JSON.stringify(field));
});

Deno.test("schema role memo includes both current strings and never product/object identity", () => {
  const field = { key: "property", caption: "Файл" };
  assertEquals(isAdministrativeCatalogField(field), true);
  assertEquals(isAdministrativeCatalogField({ ...field }), true);
  field.caption = "Цвет";
  assertEquals(isAdministrativeCatalogField(field), false);
  field.key = "site_identifier";
  assertEquals(isAdministrativeCatalogField(field), true);
  field.key = "property";
  assertEquals(isAdministrativeCatalogField(field), false);
  // Delimiter-bearing input must not alias a different tuple.
  assertEquals(isAdministrativeCatalogField({ key: "property\u0000Файл", caption: "Цвет" }), false);
  assertEquals(isAdministrativeCatalogField({ key: "property", caption: "Файл\u0000Цвет" }), true);
});

Deno.test("schema role memo bounds do not change long-input or evicted-field decisions", () => {
  const longKey = "property_".repeat(100);
  assertEquals(isAdministrativeCatalogField({ key: longKey, caption: "Цвет" }), false);
  assertEquals(isAdministrativeCatalogField({ key: longKey, caption: "Файл" }), true);
  for (let i = 0; i < 700; i++) {
    assertEquals(isAdministrativeCatalogField({ key: `selectable_field_${i}`, caption: "Напряжение" }), false);
  }
  assertEquals(isAdministrativeCatalogField({ key: "property", caption: "Файл" }), true);
  assertEquals(isAdministrativeCatalogField({ key: "property", caption: "Цвет" }), false);
  assertEquals(isAdministrativeCatalogField({ key: null, caption: undefined }), false);
});

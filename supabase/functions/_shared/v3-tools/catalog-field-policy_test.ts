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

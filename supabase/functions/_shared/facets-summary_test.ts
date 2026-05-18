// _shared/facets-summary_test.ts
import { assertEquals, assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { buildFacetsSummaryContent, __FACET_BLACKLIST_KEYS_FOR_TEST } from "./facets-summary.ts";

function mkSchema(entries: Array<[string, string, string[]]>): Map<string, { caption: string; values: Set<string> }> {
  const m = new Map<string, { caption: string; values: Set<string> }>();
  for (const [key, caption, values] of entries) {
    m.set(key, { caption, values: new Set(values) });
  }
  return m;
}

Deno.test("facets-summary: empty schema → empty string", () => {
  assertEquals(buildFacetsSummaryContent({ categoryName: "X", schema: new Map() }), "");
});

Deno.test("facets-summary: renders bullets with caption + values", () => {
  const schema = mkSchema([
    ["brand", "Бренд", ["A", "B", "C"]],
    ["power", "Мощность", ["10 Вт", "20 Вт"]],
  ]);
  const out = buildFacetsSummaryContent({ categoryName: "Светильники", schema });
  assertStringIncludes(out, "В категории «Светильники»");
  assertStringIncludes(out, "**Бренд**");
  assertStringIncludes(out, "**Мощность**");
  assertStringIncludes(out, "10 Вт, 20 Вт");
  assertStringIncludes(out, "Подскажите");
});

Deno.test("facets-summary: blacklisted keys are filtered out", () => {
  const schema = mkSchema([
    ["fayl", "Файл", ["1.pdf"]],
    ["kodnomenklatury", "КодНоменклатуры", ["X"]],
    ["brand", "Бренд", ["A"]],
  ]);
  const out = buildFacetsSummaryContent({ categoryName: "Розетки", schema });
  assertEquals(out.includes("Файл"), false);
  assertEquals(out.includes("КодНоменклатуры"), false);
  assertStringIncludes(out, "**Бренд**");
});

Deno.test("facets-summary: blacklist mirrors v2 facet-filter set", () => {
  for (const k of [
    "kodnomenklatury",
    "identifikator_sayta__sayt_identifikatory",
    "soputstvuyuschiytovar",
    "tovar_internet_magazina",
    "poiskovyy_zapros",
    "naimenovanie_na_kazahskom_yazyke",
    "opisanie_na_kazahskom_yazyke",
    "fayl",
  ]) {
    assertEquals(__FACET_BLACKLIST_KEYS_FOR_TEST.has(k), true, `missing key: ${k}`);
  }
});

Deno.test("facets-summary: facets with no values are skipped", () => {
  const schema = mkSchema([
    ["empty", "Пусто", []],
    ["brand", "Бренд", ["A"]],
  ]);
  const out = buildFacetsSummaryContent({ categoryName: "X", schema });
  assertEquals(out.includes("**Пусто**"), false);
  assertStringIncludes(out, "**Бренд**");
});

Deno.test("facets-summary: truncates values per facet with overflow note", () => {
  const many = Array.from({ length: 12 }, (_, i) => `v${i}`);
  const schema = mkSchema([["k", "Параметр", many]]);
  const out = buildFacetsSummaryContent({ categoryName: "X", schema, maxValuesPerFacet: 3 });
  assertStringIncludes(out, "… (всего 12)");
});

Deno.test("facets-summary: topN limits number of facets, ordered by value count", () => {
  const schema = mkSchema([
    ["a", "A", ["1"]],
    ["b", "B", ["1", "2", "3"]],
    ["c", "C", ["1", "2"]],
  ]);
  const out = buildFacetsSummaryContent({ categoryName: "X", schema, topN: 2 });
  // B (3 values) and C (2 values) should be picked, A skipped
  assertStringIncludes(out, "**B**");
  assertStringIncludes(out, "**C**");
  assertEquals(out.includes("**A**"), false);
});

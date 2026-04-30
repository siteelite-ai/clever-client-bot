// chat-consultant-v2 / soft-suggest_test.ts
// Тесты §22.3 + инварианты QF-2, QF-3, QF-5, QF-6 (spec).

import { assertEquals, assert } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { runSoftSuggest } from "./soft-suggest.ts";
import type { RawOption } from "./catalog/api-client.ts";

const sampleSchema: RawOption[] = [
  {
    key: "tip_lampochki",
    caption_ru: "Тип лампочки",
    caption_kz: "Шам түрі",
    values: [
      { value_ru: "LED", value_kz: "LED" },
      { value_ru: "Накаливания", value_kz: "Қыздыру" },
    ],
  },
  {
    key: "regulirovka_yarkosti",
    caption_ru: "Регулировка яркости",
    values: [
      { value_ru: "Есть", value_kz: "Бар" },
      { value_ru: "Нет", value_kz: "Жоқ" },
    ],
  },
];

function mockDeps(rv: unknown, throwError = false) {
  return {
    callLLMTool: () =>
      throwError
        ? Promise.reject(new Error("LLM down"))
        : Promise.resolve(rv),
  };
}

Deno.test("soft-suggest: пустой modifier → skipped_empty_modifier", async () => {
  const r = await runSoftSuggest(
    { unmatchedModifier: "", facetSchema: sampleSchema, pagetitle: "Лампы", locale: "ru" },
    mockDeps({ suggestions: [] }),
  );
  assertEquals(r.source, "skipped_empty_modifier");
  assertEquals(r.hintText, null);
});

Deno.test("soft-suggest: пустая schema → skipped_empty_schema", async () => {
  const r = await runSoftSuggest(
    { unmatchedModifier: "для школьника", facetSchema: [], pagetitle: "X", locale: "ru" },
    mockDeps({ suggestions: [] }),
  );
  assertEquals(r.source, "skipped_empty_schema");
});

Deno.test("soft-suggest: валидные suggestions → ok + hintText", async () => {
  const r = await runSoftSuggest(
    { unmatchedModifier: "для школьника", facetSchema: sampleSchema, pagetitle: "Лампы", locale: "ru" },
    mockDeps({
      suggestions: [
        {
          facet_key: "tip_lampochki",
          facet_caption: "Тип лампочки",
          value: "LED",
          value_caption: "LED",
          rationale_short: "безопаснее, не греется",
        },
        {
          facet_key: "regulirovka_yarkosti",
          facet_caption: "Регулировка яркости",
          value: "Есть",
          value_caption: "Есть",
          rationale_short: "комфорт глаз",
        },
      ],
    }),
  );
  assertEquals(r.source, "ok");
  assertEquals(r.suggestions.length, 2);
  assertEquals(r.invalidDropped, 0);
  assert(r.hintText !== null);
  assert(r.hintText!.includes("Для «для школьника»"));
  assert(r.hintText!.includes("Тип лампочки: LED"));
  assert(r.hintText!.includes("Хотите применить"));
});

Deno.test("QF-3: suggestions с несуществующим facet_key молча отбрасываются", async () => {
  const r = await runSoftSuggest(
    { unmatchedModifier: "x", facetSchema: sampleSchema, pagetitle: "Y", locale: "ru" },
    mockDeps({
      suggestions: [
        { facet_key: "tip_lampochki", facet_caption: "Тип", value: "LED", value_caption: "LED", rationale_short: "ok" },
        { facet_key: "fake_facet", facet_caption: "Fake", value: "X", value_caption: "X", rationale_short: "bad" },
      ],
    }),
  );
  assertEquals(r.suggestions.length, 1);
  assertEquals(r.suggestions[0].facet_key, "tip_lampochki");
  assertEquals(r.invalidDropped, 1);
  assertEquals(r.rawCount, 2);
});

Deno.test("QF-3: suggestions с несуществующим value молча отбрасываются", async () => {
  const r = await runSoftSuggest(
    { unmatchedModifier: "x", facetSchema: sampleSchema, pagetitle: "Y", locale: "ru" },
    mockDeps({
      suggestions: [
        { facet_key: "tip_lampochki", facet_caption: "Тип", value: "Галогенная", value_caption: "Гал.", rationale_short: "?" },
      ],
    }),
  );
  assertEquals(r.suggestions.length, 0);
  assertEquals(r.invalidDropped, 1);
  assertEquals(r.source, "all_invalid");
  assertEquals(r.hintText, null);
});

Deno.test("LLM error → llm_error, не бросает", async () => {
  const r = await runSoftSuggest(
    { unmatchedModifier: "x", facetSchema: sampleSchema, pagetitle: "Y", locale: "ru" },
    mockDeps(null, true),
  );
  assertEquals(r.source, "llm_error");
  assertEquals(r.hintText, null);
});

Deno.test("locale='kk' использует value_kz при матчинге", async () => {
  const r = await runSoftSuggest(
    { unmatchedModifier: "оқушы үшін", facetSchema: sampleSchema, pagetitle: "Шамдар", locale: "kk" },
    mockDeps({
      suggestions: [
        { facet_key: "regulirovka_yarkosti", facet_caption: "Жарықтық", value: "Бар", value_caption: "Бар", rationale_short: "ыңғайлы" },
      ],
    }),
  );
  assertEquals(r.suggestions.length, 1);
  assertEquals(r.source, "ok");
});

Deno.test("max 3 suggestions — лишние отрезаются", async () => {
  const r = await runSoftSuggest(
    { unmatchedModifier: "x", facetSchema: sampleSchema, pagetitle: "Y", locale: "ru" },
    mockDeps({
      suggestions: Array.from({ length: 5 }).map(() => ({
        facet_key: "tip_lampochki", facet_caption: "T", value: "LED", value_caption: "LED", rationale_short: "ok",
      })),
    }),
  );
  assert(r.suggestions.length <= 3);
});

Deno.test("QF-5: пустой suggestions array → ok с hintText=null", async () => {
  const r = await runSoftSuggest(
    { unmatchedModifier: "x", facetSchema: sampleSchema, pagetitle: "Y", locale: "ru" },
    mockDeps({ suggestions: [] }),
  );
  assertEquals(r.source, "ok");
  assertEquals(r.hintText, null);
  assertEquals(r.rawCount, 0);
});

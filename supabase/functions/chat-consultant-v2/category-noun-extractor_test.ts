// chat-consultant-v2 / category-noun-extractor_test.ts
// Тесты §22.2 (spec): Branch A extractor.

import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { extractCategoryNoun } from "./category-noun-extractor.ts";

function mockDeps(returnValue: unknown, throwError = false) {
  return {
    callLLMTool: () =>
      throwError
        ? Promise.reject(new Error("LLM down"))
        : Promise.resolve(returnValue),
  };
}

Deno.test("extractor: пустой query → source='empty'", async () => {
  const r = await extractCategoryNoun(
    { userQuery: "", locale: "ru" },
    mockDeps({ category_noun: "лампа" }),
  );
  assertEquals(r.categoryNoun, "");
  assertEquals(r.source, "empty");
});

Deno.test("extractor: валидное существительное → source='llm'", async () => {
  const r = await extractCategoryNoun(
    { userQuery: "настольная лампа для школьника", locale: "ru" },
    mockDeps({ category_noun: "лампа" }),
  );
  assertEquals(r.categoryNoun, "лампа");
  assertEquals(r.source, "llm");
});

Deno.test("extractor: lowercase + trim", async () => {
  const r = await extractCategoryNoun(
    { userQuery: "розетка", locale: "ru" },
    mockDeps({ category_noun: "  Розетка  " }),
  );
  assertEquals(r.categoryNoun, "розетка");
});

Deno.test("extractor: пустая строка от LLM → source='empty'", async () => {
  const r = await extractCategoryNoun(
    { userQuery: "привет", locale: "ru" },
    mockDeps({ category_noun: "" }),
  );
  assertEquals(r.categoryNoun, "");
  assertEquals(r.source, "empty");
});

Deno.test("extractor: словосочетание → invalid (regex отбрасывает пробелы)", async () => {
  const r = await extractCategoryNoun(
    { userQuery: "x", locale: "ru" },
    mockDeps({ category_noun: "настольная лампа" }),
  );
  assertEquals(r.categoryNoun, "");
  assertEquals(r.source, "invalid");
});

Deno.test("extractor: с цифрами → invalid", async () => {
  const r = await extractCategoryNoun(
    { userQuery: "x", locale: "ru" },
    mockDeps({ category_noun: "lamp123" }),
  );
  assertEquals(r.source, "invalid");
});

Deno.test("extractor: слишком короткое → invalid", async () => {
  const r = await extractCategoryNoun(
    { userQuery: "x", locale: "ru" },
    mockDeps({ category_noun: "л" }),
  );
  assertEquals(r.source, "invalid");
});

Deno.test("extractor: LLM error → source='invalid', не бросает", async () => {
  const r = await extractCategoryNoun(
    { userQuery: "лампа", locale: "ru" },
    mockDeps(null, true),
  );
  assertEquals(r.categoryNoun, "");
  assertEquals(r.source, "invalid");
});

Deno.test("extractor: невалидный JSON-ответ → source='empty'", async () => {
  const r = await extractCategoryNoun(
    { userQuery: "лампа", locale: "ru" },
    mockDeps({ wrong_field: "foo" }),
  );
  assertEquals(r.categoryNoun, "");
  assertEquals(r.source, "empty");
});

Deno.test("extractor: казахская локаль работает", async () => {
  const r = await extractCategoryNoun(
    { userQuery: "шам", locale: "kk" },
    mockDeps({ category_noun: "шам" }),
  );
  assertEquals(r.categoryNoun, "шам");
  assertEquals(r.source, "llm");
});

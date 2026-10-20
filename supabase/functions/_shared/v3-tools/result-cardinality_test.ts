import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  capResultCandidateIds,
  ensureSearchCapacity,
  expandResultCandidateIds,
  resolveResultCardinality,
  resultCardinalityCandidateWindow,
  resultCardinalityShortfallText,
} from "./result-cardinality.ts";

Deno.test("cardinality distinguishes card counts from product measurements", () => {
  assertEquals(
    resolveResultCardinality("найди кабель ВВГ 3*1,5 на 25 метров", {
      selection: true,
    }),
    { target: 4, minimum: 3, mode: "selection", explicit: false },
  );
  assertEquals(
    resolveResultCardinality("покажи автомат 16 А на 3 полюса", {
      selection: true,
    }),
    { target: 4, minimum: 3, mode: "selection", explicit: false },
  );
});

Deno.test("cardinality honors alternatives, explicit counts and exhaustive requests", () => {
  assertEquals(
    resolveResultCardinality("Дай несколько подходящих вариантов", {
      selection: true,
    }),
    { target: 5, minimum: 3, mode: "alternatives", explicit: true },
  );
  assertEquals(
    resolveResultCardinality("Покажи 6 моделей", { selection: true }),
    { target: 6, minimum: 6, mode: "explicit", explicit: true },
  );
  assertEquals(
    resolveResultCardinality("Покажи все варианты", { selection: true }),
    { target: 8, minimum: 3, mode: "exhaustive", explicit: true },
  );
});

Deno.test("an explicit request for choices survives a model-like technical code", () => {
  assertEquals(
    resolveResultCardinality(
      "Подбери несколько уличных прожекторов IP65 для двора",
      { selection: true, exactLookup: true },
    ),
    { target: 5, minimum: 3, mode: "alternatives", explicit: true },
  );
  assertEquals(
    resolveResultCardinality("Покажи 4 варианта с IP65", {
      selection: true,
      exactLookup: true,
    }),
    { target: 4, minimum: 4, mode: "explicit", explicit: true },
  );
  assertEquals(
    resolveResultCardinality(
      "Предложи аналоги на светильник DN027B; 929002070102",
      { selection: true, exactLookup: true },
    ),
    { target: 5, minimum: 3, mode: "alternatives", explicit: true },
  );
  assertEquals(
    resolveResultCardinality("Предложи 3 аналога DN027B", {
      selection: true,
      exactLookup: true,
    }),
    { target: 3, minimum: 3, mode: "explicit", explicit: true },
  );
});

Deno.test("single-result intents remain single", () => {
  assertEquals(
    resolveResultCardinality("найди самый дешевый кабель", {
      selection: true,
      superlative: true,
    }),
    { target: 1, minimum: 1, mode: "single", explicit: false },
  );
  assertEquals(
    resolveResultCardinality("покажи один вариант", { selection: true }),
    { target: 1, minimum: 1, mode: "single", explicit: true },
  );
  assertEquals(
    resolveResultCardinality("покажи товар по артикулу 929002070102", {
      selection: true,
      exactLookup: true,
    }),
    { target: 1, minimum: 1, mode: "single", explicit: false },
  );
});

Deno.test("plural price superlatives sort a selection instead of collapsing it to one card", () => {
  assertEquals(
    resolveResultCardinality("Покажи самые дешевые светильники Philips для офиса", {
      selection: true,
      superlative: true,
    }),
    { target: 4, minimum: 3, mode: "selection", explicit: false },
  );
  assertEquals(
    resolveResultCardinality("Покажи несколько самых дешевых вариантов", {
      selection: true,
      superlative: true,
    }),
    { target: 5, minimum: 3, mode: "alternatives", explicit: true },
  );
  assertEquals(
    resolveResultCardinality("Покажи все самые дешевые модели", {
      selection: true,
      superlative: true,
    }),
    { target: 8, minimum: 3, mode: "exhaustive", explicit: true },
  );
});

Deno.test("candidate expansion preserves the model choice and fills from the same pool", () => {
  assertEquals(
    expandResultCandidateIds(["b"], ["a", "b", "c", "d", "e"], 4),
    ["b", "a", "c", "d"],
  );
  assertEquals(
    expandResultCandidateIds(["a", "b", "c", "d", "e", "f", "g"], [], 5),
    ["a", "b", "c", "d", "e"],
  );
});

Deno.test("candidate window is gated before the final target-sized cap", () => {
  const contract = resolveResultCardinality("дай несколько вариантов", {
    selection: true,
  });
  assertEquals(resultCardinalityCandidateWindow(contract), 15);
  const candidateIds = Array.from(
    { length: 20 },
    (_, index) => String(index + 1),
  );
  assertEquals(
    expandResultCandidateIds(
      [],
      candidateIds,
      resultCardinalityCandidateWindow(contract),
    ).length,
    15,
  );
  assertEquals(
    capResultCandidateIds(["a", "b", "c", "d", "e", "f"], contract),
    ["a", "b", "c", "d", "e"],
  );
});

Deno.test("search capacity is widened only for non-exact multi-result retrieval", () => {
  const contract = resolveResultCardinality("подбери варианты", {
    selection: true,
  });
  assertEquals(
    ensureSearchCapacity({ mode: "by_filter", per_page: 2 }, contract),
    {
      mode: "by_filter",
      per_page: 15,
    },
  );
  assertEquals(
    ensureSearchCapacity({ mode: "by_article", per_page: 1 }, contract),
    {
      mode: "by_article",
      per_page: 1,
    },
  );
});

Deno.test("shortfall is disclosed only below the promised minimum", () => {
  const contract = resolveResultCardinality("дай несколько вариантов", {
    selection: true,
  });
  assertEquals(
    resultCardinalityShortfallText(2, contract),
    "По заданным условиям удалось подтвердить только 2 варианта. Если хотите больше вариантов, скажите, какое условие можно изменить; без вашего согласия я не расширю подбор.",
  );
  assertEquals(
    resultCardinalityShortfallText(1, contract),
    "По заданным условиям удалось подтвердить только 1 вариант. Если хотите больше вариантов, скажите, какое условие можно изменить; без вашего согласия я не расширю подбор.",
  );
  assertEquals(
    resultCardinalityShortfallText(1, contract, { unverifiedCriteria: true }),
    "По нужному типу нашёл только 1 вариант. Не все обязательные свойства заполнены в карточках; непроверенный параметр указан отдельно перед товарами. Если хотите больше вариантов, скажите, какое условие можно изменить; без вашего согласия я не расширю подбор.",
  );
  assertEquals(resultCardinalityShortfallText(3, contract), null);
  assertEquals(
    resultCardinalityShortfallText(1, contract, { candidateCoverage: "partial" }),
    "Пока удалось подтвердить 1 вариант в проверенной части каталога. Полноту поиска подтвердить не удалось; это не означает, что других подходящих товаров нет. Могу продолжить проверку каталога или, с вашего согласия, ослабить условия.",
  );
  assertEquals(
    resultCardinalityShortfallText(1, contract, { candidateCoverage: "unknown" }),
    "Пока удалось подтвердить 1 вариант в проверенной части каталога. Полноту поиска подтвердить не удалось; это не означает, что других подходящих товаров нет. Могу продолжить проверку каталога или, с вашего согласия, ослабить условия.",
  );
  assertEquals(
    resultCardinalityShortfallText(1, contract, {
      candidateCoverage: "partial",
      unverifiedCriteria: true,
    }),
    "По нужному типу пока удалось подтвердить 1 вариант в проверенной части каталога. Не все обязательные свойства заполнены в карточках; непроверенный параметр указан отдельно перед товарами. Полноту поиска подтвердить не удалось; это не означает, что других подходящих товаров нет. Могу продолжить проверку каталога или, с вашего согласия, ослабить условия.",
  );
  assertEquals(
    resultCardinalityShortfallText(1, contract, { candidateCoverage: "complete_query_window" }),
    "В выполненном поиске удалось подтвердить 1 вариант. Если хотите больше вариантов, скажите, какое условие можно изменить; без вашего согласия я не расширю подбор.",
  );
});

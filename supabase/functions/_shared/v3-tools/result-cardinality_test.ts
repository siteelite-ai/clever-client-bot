import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  ensureSearchCapacity,
  expandResultCandidateIds,
  resolveResultCardinality,
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
    resolveResultCardinality("цена товара по артикулу", {
      selection: true,
      exactLookup: true,
    }),
    { target: 1, minimum: 1, mode: "single", explicit: false },
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
    "По заданным условиям удалось подтвердить только 2 варианта; остальные найденные карточки не прошли те же обязательные критерии.",
  );
  assertEquals(resultCardinalityShortfallText(3, contract), null);
});

import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  canonicalizeCompoundMarkingForCatalog,
  classifyExactCompoundMarkingRequest,
  compoundRecoveryQueries,
  extractExplicitCompoundMarking,
  isExhaustiveCompoundRequest,
  partitionSemanticCompoundSourceByLiveTaxonomy,
  productTitleMatchesExplicitCompoundMarking,
  requiresSemanticCompoundEvidence,
  semanticCompoundSourceQuery,
  selectBestMatchingSemanticCompoundCategories,
  selectExactCompoundMarkedProducts,
  shouldTerminateAfterGroundedCompoundSearch,
  subsumeCriteriaProvenByExplicitCompound,
} from "./exact-compound-marking-policy.ts";
import type { ProductRef } from "./types.ts";

const product = (id: string, pagetitle: string, price: number): ProductRef => ({
  id,
  pagetitle,
  price,
  vendor: null,
  stock: "in_stock",
  short_traits: [],
});

Deno.test("exact compound route extracts a price-sorted catalog query", () => {
  assertEquals(classifyExactCompoundMarkingRequest("найди кабель ввг 2*1,5 самый дешевый"), {
    query: "кабель ввг 2*1,5",
    first: 2,
    second: 1.5,
    priceDirection: "cheapest",
  });
  assertEquals(classifyExactCompoundMarkingRequest("Подойдёт ли кабель ВВГ 2×1,5?"), null);
});

Deno.test("exact compound shortcut yields semantic multi-attribute requests to the consultant", () => {
  assertEquals(classifyExactCompoundMarkingRequest("какой есть кабель ввг 3*1,5 негорючий покажи все позиции"), null);
  assertEquals(classifyExactCompoundMarkingRequest("нужен медный кабель негорючий 2*1,5"), null);
});

Deno.test("compound semantic evidence classifier is structural and product-agnostic", () => {
  assertEquals(requiresSemanticCompoundEvidence("найди кабель ВВГ 2*1,5"), false);
  assertEquals(requiresSemanticCompoundEvidence("нужен медный кабель негорючий 2*1,5"), true);
  assertEquals(requiresSemanticCompoundEvidence("покажи изделие для улицы стойкое 3×2,5"), true);
  assertEquals(requiresSemanticCompoundEvidence("нужен товар без составного размера"), false);
  assertEquals(
    semanticCompoundSourceQuery("Нужен медный кабель негорючий 2*1,5, пожалуйста!"),
    "медный кабель негорючий",
  );
  assertEquals(
    semanticCompoundSourceQuery("какой есть кабель ввг 3*1,5 негорючий покажи все позиции"),
    "кабель ввг негорючий",
  );
});

Deno.test("semantic compound source is partitioned by live taxonomy without a product dictionary", () => {
  assertEquals(partitionSemanticCompoundSourceByLiveTaxonomy(
    "медный кабель негорючий",
    ["Кабели силовые", "Кабели монтажные"],
  ), {
    query: "кабель",
    semanticModifiers: ["медный", "негорючий"],
  });
  assertEquals(partitionSemanticCompoundSourceByLiveTaxonomy(
    "кабель ввг негорючий",
    ["Кабели силовые"],
  ), {
    query: "кабель",
    semanticModifiers: ["ввг", "негорючий"],
  });
});

Deno.test("semantic compound partition fails closed when live taxonomy has no class anchor", () => {
  assertEquals(partitionSemanticCompoundSourceByLiveTaxonomy(
    "изделие стойкое для улицы",
    ["Кабели силовые"],
  ), {
    query: "изделие стойкое для улицы",
    semanticModifiers: [],
  });
});

Deno.test("semantic compound category scope keeps the most specific live class and drops same-size siblings", () => {
  assertEquals(selectBestMatchingSemanticCompoundCategories(
    "кабель ввг негорючий",
    [
      "Кабель ВВГ",
      "Удлинители",
      "Кабель и провод разного назначения",
      "Кабель КГ",
      "Провод ПВС",
    ],
  ), ["Кабель ВВГ"]);
  assertEquals(selectBestMatchingSemanticCompoundCategories(
    "медный кабель негорючий",
    ["Кабель ВВГ", "Кабель КГ", "Удлинители"],
  ), ["Кабель ВВГ", "Кабель КГ"]);
});

Deno.test("exact compound route rejects a nearby size and returns the cheapest exact match", () => {
  const request = classifyExactCompoundMarkingRequest("найди кабель ввг 2*1,5 самый дешевый")!;
  const selected = selectExactCompoundMarkedProducts([
    product("wrong", "Кабель ВВГ нг 4*2,5", 100),
    product("exact-expensive", "Кабель ВВГ 2×1.5", 316),
    product("exact-cheapest", "Кабель ВВГ нг LS 2*1,5", 283),
  ], request);

  assertEquals(selected.map((item) => item.id), ["exact-cheapest"]);
});

Deno.test("explicit compound marking is a generic final-render invariant", () => {
  const marking = extractExplicitCompoundMarking("нужен медный огнестойкий кабель 2*1,5");
  assertEquals(marking, { first: 2, second: 1.5 });

  assertEquals(productTitleMatchesExplicitCompoundMarking("Кабель ВВГнг 2×1.5", marking!), true);
  assertEquals(productTitleMatchesExplicitCompoundMarking("Кабель КПСнг 2х1,50", marking!), true);
  assertEquals(productTitleMatchesExplicitCompoundMarking("Кабель ВВГнг 4*1,5", marking!), false);
  assertEquals(productTitleMatchesExplicitCompoundMarking("Провод СИП 2*16", marking!), false);
  assertEquals(productTitleMatchesExplicitCompoundMarking("Кабель огнестойкий без размера в названии", marking!), false);
});

Deno.test("ordinary numeric requirements do not become compound marking constraints", () => {
  assertEquals(extractExplicitCompoundMarking("светильник для комнаты 25 м² до 5000 тенге"), null);
});

Deno.test("literal compound title evidence subsumes only its duplicate criteria", () => {
  const marking = extractExplicitCompoundMarking("кабель 3*1,5 негорючий")!;
  const adjusted = subsumeCriteriaProvenByExplicitCompound([
    { key: "Количество жил", op: "eq", value: 3, level: "A" },
    { key: "Сечение жилы", op: "eq", value: 1.5, unit: "мм²", level: "A" },
    { key: "Негорючесть", op: "eq", value: "Да", level: "A" },
  ], marking);
  assertEquals(adjusted.subsumed.map((criterion) => criterion.key), ["Количество жил", "Сечение жилы"]);
  assertEquals(adjusted.criteria.map((criterion) => criterion.key), ["Негорючесть"]);
});

Deno.test("compound criterion subsumption does not remove unrelated equal numbers", () => {
  const marking = extractExplicitCompoundMarking("изделие 3*1,5")!;
  const adjusted = subsumeCriteriaProvenByExplicitCompound([
    { key: "Количество", op: "eq", value: 3, level: "A" },
    { key: "Напряжение", op: "eq", value: 1.5, unit: "В", level: "A" },
    { key: "Размер", op: "eq", value: "3×1,5", level: "A" },
  ], marking);
  assertEquals(adjusted.subsumed.map((criterion) => criterion.key), ["Размер"]);
  assertEquals(adjusted.criteria.map((criterion) => criterion.key), ["Количество", "Напряжение"]);
});

Deno.test("grounded compound search terminates only a non-exhaustive exact-title pool", () => {
  const marking = extractExplicitCompoundMarking("нужен медный кабель негорючий 2*1,5")!;
  assertEquals(shouldTerminateAfterGroundedCompoundSearch(
    "нужен медный кабель негорючий 2*1,5",
    ["Кабель ВВГ нг 2*1,5", "Кабель ВВГ нг LS 2×1.5"],
    marking,
  ), true);
  assertEquals(shouldTerminateAfterGroundedCompoundSearch(
    "покажи все позиции кабеля 2*1,5",
    ["Кабель ВВГ нг 2*1,5"],
    marking,
  ), false);
  assertEquals(shouldTerminateAfterGroundedCompoundSearch(
    "нужен кабель 2*1,5",
    ["Кабель ВВГ нг 4*1,5"],
    marking,
  ), false);
});

Deno.test("exhaustive compound intent bypasses bounded direct selection", () => {
  assertEquals(isExhaustiveCompoundRequest("покажи все позиции кабеля 3*1,5"), true);
  assertEquals(isExhaustiveCompoundRequest("нужен полный список кабелей 3×1,5"), true);
  assertEquals(isExhaustiveCompoundRequest("покажи кабель 3*1,5"), false);
});

Deno.test("compound catalog syntax changes punctuation without changing the model's words", () => {
  assertEquals(canonicalizeCompoundMarkingForCatalog("ВВГнг 2х1.5"), "ВВГнг 2*1,5");
  assertEquals(canonicalizeCompoundMarkingForCatalog("кабель ВВГ нг 2 × 1,50"), "кабель ВВГ нг 2*1,50");
  assertEquals(canonicalizeCompoundMarkingForCatalog("светильник 5000 лм"), "светильник 5000 лм");
});

Deno.test("compound recovery ladder uses only model wording plus the user's literal marking", () => {
  const marking = extractExplicitCompoundMarking("нужен кабель 2×1,5")!;
  assertEquals(compoundRecoveryQueries(marking, [
    "кабель",
    "Кабель силовой с медными жилами",
    "Кабель ВВГ",
  ], 6), [
    "кабель 2*1,5",
    "кабель силовой с медными жилами 2*1,5",
    "кабель ввг 2*1,5",
    "силовой 2*1,5",
    "медными 2*1,5",
    "жилами 2*1,5",
  ]);
});

import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  resolveGroundedCategoryHeadToken,
  resolveHeadCategoryByFacetEvidence,
  resolveLocalCategoryPagetitles,
} from "./discover-category.ts";

const LIVE_TITLES = [
  "Светильники",
  "Уличные светильники",
  "Светильники для ЖКХ",
  "Датчики",
  "Средства для удаления наклеек",
  "Прожекторы",
  "Кабели силовые",
  "Кабели сигнальные",
  "Трубки термоусаживаемые",
  "Автоматические выключатели",
];

Deno.test("local live-taxonomy resolver handles an obvious inflected class without a model", () => {
  assertEquals(resolveLocalCategoryPagetitles({
    noun: "мне нужен бытовой светильник с датчиком движения",
    semantic_query: "мне нужен бытовой светильник с датчиком движения до 4000 тенге",
  }, LIVE_TITLES), ["Светильники"]);
});

Deno.test("local live-taxonomy resolver treats a prepositional class as a modifier, not the head product", () => {
  assertEquals(resolveLocalCategoryPagetitles({
    noun: "светильник с датчиком",
    semantic_query: "мне нужен светильник с датчиком движения",
  }, LIVE_TITLES), ["Светильники"]);
  assertEquals(resolveLocalCategoryPagetitles({
    noun: "датчик движения",
    semantic_query: "мне нужен датчик движения",
  }, LIVE_TITLES), ["Датчики"]);
});

Deno.test("local live-taxonomy resolver prefers a fully customer-grounded specific class", () => {
  assertEquals(resolveLocalCategoryPagetitles({
    noun: "уличный светильник",
    semantic_query: "Нужен уличный светильник во двор",
  }, LIVE_TITLES), ["Уличные светильники"]);
  assertEquals(resolveLocalCategoryPagetitles({
    noun: "термоусадочная трубка",
    semantic_query: "Найди термоусадочную трубку диаметром 12 мм",
  }, LIVE_TITLES), ["Трубки термоусаживаемые"]);
});

Deno.test("local live-taxonomy resolver fails closed on a shared ambiguous class", () => {
  assertEquals(resolveLocalCategoryPagetitles({
    noun: "кабель",
    semantic_query: "Нужен кабель",
  }, LIVE_TITLES), []);
});

Deno.test("local live-taxonomy resolver accepts a unique compound category head", () => {
  assertEquals(resolveLocalCategoryPagetitles({
    noun: "Найди автомат до 1000 тенге 1 полюсной, 16 А характеристика С",
    semantic_query: "Найди автомат до 1000 тенге 1 полюсной, 16 А характеристика С",
  }, LIVE_TITLES), ["Автоматические выключатели"]);
  assertEquals(resolveGroundedCategoryHeadToken(
    "Найди автомат до 1000 тенге 1 полюсной, 16 А характеристика С",
    "Автоматические выключатели",
  ), "автомат");
});

Deno.test("partial live-taxonomy heads remain fail-closed for modifiers and ambiguity", () => {
  assertEquals(resolveLocalCategoryPagetitles({
    noun: "нужно для автоматического включения света",
    semantic_query: "нужно устройство для автоматического включения света",
  }, LIVE_TITLES), []);
  assertEquals(resolveGroundedCategoryHeadToken(
    "нужно устройство для автоматического включения света",
    "Автоматические выключатели",
  ), null);
  assertEquals(resolveGroundedCategoryHeadToken(
    "не хочу автомат, нужен другой аппарат",
    "Автоматические выключатели",
  ), null);
  assertEquals(resolveLocalCategoryPagetitles({
    noun: "не хочу средство для наклеек",
    semantic_query: "не хочу средство для наклеек, нужна лампа",
  }, LIVE_TITLES), []);
  assertEquals(resolveLocalCategoryPagetitles({
    noun: "нужен кабель",
    semantic_query: "нужен кабель",
  }, ["Кабели силовые", "Кабели сигнальные"]), []);
});

Deno.test("ambiguous live heads require unique evidence from at least two facet axes", () => {
  const candidates = [
    {
      pagetitle: "Автоматические выключатели",
      facets: [
        { caption: "Количество полюсов" },
        { caption: "Характеристика срабатывания" },
        { caption: "Номинальный ток" },
      ],
    },
    {
      pagetitle: "Автоматы защиты двигателя",
      facets: [
        { caption: "Номинальный ток" },
        { caption: "Мощность двигателя" },
      ],
    },
  ];
  assertEquals(resolveHeadCategoryByFacetEvidence(
    "Найди автомат 1 полюсной, 16 А характеристика С",
    candidates,
  ), "Автоматические выключатели");
  assertEquals(resolveHeadCategoryByFacetEvidence("Найди автомат 16 А", candidates), null);
  assertEquals(resolveHeadCategoryByFacetEvidence("Найди автомат по номинальному току", [
    candidates[0],
    { ...candidates[1], facets: [{ caption: "Номинальный ток" }, { caption: "Номинальная мощность" }] },
  ]), null);
});

Deno.test("local live-taxonomy resolver does not translate jargon or invent a category", () => {
  assertEquals(resolveLocalCategoryPagetitles({
    noun: "кукуруза",
    semantic_query: "Есть лампы кукуруза?",
  }, LIVE_TITLES), []);
  assertEquals(resolveLocalCategoryPagetitles({
    noun: "наклейка",
    semantic_query: "Нужна лампа, похожая на кукурузный початок, а не средство для наклеек",
  }, LIVE_TITLES), []);
});

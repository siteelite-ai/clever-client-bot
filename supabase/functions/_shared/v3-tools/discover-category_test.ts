import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { resolveLocalCategoryPagetitles } from "./discover-category.ts";

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

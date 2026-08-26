import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  buildVisibleRequestContract,
  titleSupportsVisibleRequestContract,
} from "./visible-request-contract.ts";

Deno.test("literal linear length requires an actual unit in the title", () => {
  const contract = buildVisibleRequestContract("подбери удлинитель на 50 м");
  assertEquals(titleSupportsVisibleRequestContract("Удлинитель УК-50 /50м", contract), true);
  assertEquals(titleSupportsVisibleRequestContract("Удлинитель EB-50-007", contract), false);
});

Deno.test("room area is not treated as a product length", () => {
  assertEquals(buildVisibleRequestContract("светильник для гостиной 25 м²").length, 0);
});

Deno.test("explicit place count and double socket stay visible", () => {
  const places = buildVisibleRequestContract("удлинитель на 3 места");
  assertEquals(titleSupportsVisibleRequestContract("Удлинитель У03 3 места", places), true);
  assertEquals(titleSupportsVisibleRequestContract("Удлинитель 4 гн.", places), false);

  const doubleSocket = buildVisibleRequestContract("черная двойная розетка");
  assertEquals(titleSupportsVisibleRequestContract("Розетка двойная, цвет черный", doubleSocket), true);
  assertEquals(titleSupportsVisibleRequestContract("Розетка одинарная, цвет черный", doubleSocket), false);
});

Deno.test("directional measurements remain visible and preserve their bound", () => {
  const contract = buildVisibleRequestContract("Покажите прожекторы мощностью от 100 Вт");
  assertEquals(titleSupportsVisibleRequestContract("Прожектор LED 150W", contract), true);
  assertEquals(titleSupportsVisibleRequestContract("Прожектор LED 100Вт", contract), true);
  assertEquals(titleSupportsVisibleRequestContract("Прожектор LED 70W", contract), false);
  assertEquals(titleSupportsVisibleRequestContract("Прожектор модель 06-150", contract), false);
});

Deno.test("strict directional measurements do not accept their boundary", () => {
  const contract = buildVisibleRequestContract("Нужен товар больше 10 А");
  assertEquals(titleSupportsVisibleRequestContract("Товар 16A", contract), true);
  assertEquals(titleSupportsVisibleRequestContract("Товар 10 А", contract), false);
});

Deno.test("a live literal class modifier survives a later mixed recovery pool", () => {
  const contract = buildVisibleRequestContract(
    "Покажите светодиодные прожекторы мощностью от 100 Вт",
    {
      productClass: "Прожекторы",
      candidateTitles: [
        "Прожектор светодиодный 70W",
        "Прожектор ИО 150Вт",
        "Прожектор светодиодный 150Вт",
      ],
    },
  );
  assertEquals(titleSupportsVisibleRequestContract("Прожектор светодиодный 150Вт", contract), true);
  assertEquals(titleSupportsVisibleRequestContract("Прожектор светодиодный 70W", contract), false);
  assertEquals(titleSupportsVisibleRequestContract("Прожектор ИО 150Вт", contract), false);
});

Deno.test("a modifier absent from live titles is not guessed as catalog vocabulary", () => {
  const contract = buildVisibleRequestContract(
    "Покажите умные контроллеры",
    { productClass: "Контроллеры", candidateTitles: ["Контроллер ALPHA"] },
  );
  assertEquals(titleSupportsVisibleRequestContract("Контроллер ALPHA", contract), true);
});

import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  buildVisibleRequestContract,
  shouldContinueVisibleRecoveryPage,
  shouldExpandVisibleRecoverySearch,
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
      productClass: "светодиодные прожекторы",
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

Deno.test("a measurement descriptor is not duplicated as a literal title modifier", () => {
  const contract = buildVisibleRequestContract(
    "Покажите светодиодные прожекторы мощностью от 100 Вт",
    {
      productClass: "Прожекторы",
      candidateTitles: [
        "Прожектор светодиодный мощностью 70W",
        "Прожектор светодиодный MFL 01-150 150W",
      ],
    },
  );
  assertEquals(contract.map((requirement) => requirement.label), ["от 100 Вт", "светодиодные"]);
  assertEquals(
    titleSupportsVisibleRequestContract("Прожектор светодиодный MFL 01-150 150W", contract),
    true,
  );
});

Deno.test("a modifier absent from live titles is not guessed as catalog vocabulary", () => {
  const contract = buildVisibleRequestContract(
    "Покажите умные контроллеры",
    { productClass: "Контроллеры", candidateTitles: ["Контроллер ALPHA"] },
  );
  assertEquals(titleSupportsVisibleRequestContract("Контроллер ALPHA", contract), true);
});

Deno.test("a non-empty rejected leaf permits one grounded full-text recovery", () => {
  assertEquals(shouldExpandVisibleRecoverySearch(true, 0), true);
  assertEquals(shouldExpandVisibleRecoverySearch(true, 1), false);
  assertEquals(shouldExpandVisibleRecoverySearch(false, 0), false);
});

Deno.test("visible recovery pagination is bounded and stops after confirmation", () => {
  assertEquals(shouldContinueVisibleRecoveryPage({ page: 1, pageSize: 50, total: 145, confirmedCount: 0, maxPages: 4 }), true);
  assertEquals(shouldContinueVisibleRecoveryPage({ page: 2, pageSize: 50, total: 145, confirmedCount: 2, maxPages: 4 }), false);
  assertEquals(shouldContinueVisibleRecoveryPage({ page: 3, pageSize: 50, total: 145, confirmedCount: 0, maxPages: 4 }), false);
  assertEquals(shouldContinueVisibleRecoveryPage({ page: 4, pageSize: 50, total: 500, confirmedCount: 0, maxPages: 4 }), false);
});

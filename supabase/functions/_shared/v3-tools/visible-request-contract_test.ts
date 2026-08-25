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

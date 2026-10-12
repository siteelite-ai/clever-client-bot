import { assertEquals, assertMatch } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { buildMeasuredBreakerGuidance } from "./measured-breaker-guidance.ts";

Deno.test("measured single-phase breaker guidance exposes calculation, standard rating and safety bounds", () => {
  const result = buildMeasuredBreakerGuidance(
    "Какой автоматический выключатель мне нужен для квартиры с нагрузкой 7 кВт?",
  );
  assertEquals(result?.supply, "single_phase");
  assertEquals(result?.conditional_supply, true);
  assertEquals(result?.suggested_rating_a, 32);
  assertMatch(result?.answer ?? "", /30[,.]4\s*А/iu);
  assertMatch(result?.answer ?? "", /32\s*А/iu);
  assertMatch(result?.answer ?? "", /однофаз|230\s*В/iu);
  assertMatch(result?.answer ?? "", /характеристик\p{L}*\s+C/iu);
  assertMatch(result?.answer ?? "", /кабел/iu);
});

Deno.test("explicit single-phase installation wording stays on measured safety guidance", () => {
  for (
    const message of [
      "Какой автомат поставить в однофазной квартире при нагрузке 7 кВт?",
      "Какой автомат лучше ставить в однофазной квартире при нагрузке 7 кВт?",
      "Какой автомат установить в однофазной квартире при нагрузке 7 кВт?",
      "Какой автомат выбрать в однофазной квартире при нагрузке 7 кВт?",
    ]
  ) {
    const result = buildMeasuredBreakerGuidance(message);
    assertEquals(result?.supply, "single_phase", message);
    assertEquals(result?.conditional_supply, false, message);
    assertEquals(result?.suggested_rating_a, 32, message);
    assertMatch(result?.answer ?? "", /7\s*кВт\s*\/\s*230\s*В/iu);
    assertMatch(result?.answer ?? "", /только после проверки сечения и материала кабеля/iu);
  }
});

Deno.test("explicit three-phase measured load uses phase-current formula", () => {
  const result = buildMeasuredBreakerGuidance(
    "Какой автомат нужен для нагрузки 7 кВт при трёхфазном вводе 400 В?",
  );
  assertEquals(result?.supply, "three_phase");
  assertEquals(result?.conditional_supply, false);
  assertEquals(result?.suggested_rating_a, 16);
  assertMatch(result?.answer ?? "", /10[,.]1\s*А/iu);
  assertMatch(result?.answer ?? "", /трёхфаз|400\s*В/iu);
});

Deno.test("direct catalogue selection and unrelated measurements stay outside guidance", () => {
  assertEquals(buildMeasuredBreakerGuidance("Подбери автомат для квартиры с нагрузкой 7 кВт"), null);
  assertEquals(buildMeasuredBreakerGuidance("Подбери, какой автомат поставить в однофазной квартире при нагрузке 7 кВт"), null);
  assertEquals(buildMeasuredBreakerGuidance("Какой кабель нужен для нагрузки 7 кВт?"), null);
  assertEquals(buildMeasuredBreakerGuidance("Какой автомат нужен для квартиры?"), null);
});

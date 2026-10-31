import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { joinCustomerTurns } from "./criteria-consistency.ts";
import { selectReadinessClarification } from "./selection-readiness.ts";

const underground = "Нужен кабель прямо в земле, 220 В, 16 А, 3 жилы, PE есть";
const pump = "Нужен кабель для насоса, 220 В, рабочий ток 6 А, стационарно на улице";

for (const request of [underground, pump]) {
  Deno.test(`line readiness requires an actual cable-route length: ${request}`, () => {
    assertEquals(selectReadinessClarification(request)?.facet_key, "line_length");
    for (const fact of ["Длина линии 25 м", "Линия 35 метров", "Расстояние до насоса 15 м", "Кабель длиной 40 м"]) {
      assertEquals(selectReadinessClarification(`${request}, ${fact}`), null, fact);
    }
    assertEquals(selectReadinessClarification(joinCustomerTurns([request, "25 м"])), null);
  });

  Deno.test(`line readiness rejects invalid or unrelated lengths: ${request}`, () => {
    for (const fact of ["Длина линии 0 м", "Длина линии -25 м", "Длина линии −25 м", "Длина линии 0–25 м", "Длина линии 50–25 м", "Высота установки 4 м", "Наружный диаметр 25 мм", "Длина не знаю"]) {
      assertEquals(selectReadinessClarification(`${request}, ${fact}`)?.facet_key, "line_length", fact);
    }
  });
}

Deno.test("a stated length range is a planning input, never a certified voltage-drop calculation", () => {
  for (const fact of ["До 25 м", "25–50 м", "Более 50 м"]) {
    assertEquals(selectReadinessClarification(joinCustomerTurns([pump, fact])), null, fact);
  }
});

Deno.test("route length does not borrow a metre unit from a different customer turn", () => {
  assertEquals(selectReadinessClarification(joinCustomerTurns([pump, "Длина линии 25", "м"]))?.facet_key, "line_length");
  assertEquals(selectReadinessClarification(`${pump}, длина линии 25\nм`), null);
});

Deno.test("a revoked or invalid later route length does not reuse an earlier customer value", () => {
  for (const correction of ["Длина линии не знаю", "Длина линии неизвестна", "Длина линии 0 м", "Длина линии -25 м"]) {
    assertEquals(selectReadinessClarification(joinCustomerTurns([pump, "Длина линии 25 м", correction]))?.facet_key, "line_length", correction);
  }
  assertEquals(selectReadinessClarification(joinCustomerTurns([pump, "Длина линии неизвестна", "Длина линии 35 м"])), null);
});

Deno.test("line collection does not create readiness for exact cable browsing or other products", () => {
  for (const request of ["Найди кабель ВВГ 3*1,5 самый дешевый", "Покажи кабель КГ 3*2,5", "Найди автомат 1P C16", "Покажи лампу Korn E27 20W"]) {
    assertEquals(selectReadinessClarification(request), null, request);
  }
});

import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { selectReadinessClarification } from "./selection-readiness.ts";

const cases = [
  ["Мне нужен кабель для насоса", "pump_cable"],
  ["Какой кабель подойдет для прокладки в земле?", "underground_cable"],
  ["Подберите автомат для двигателя", "motor_breaker"],
  ["Подбери автомат 25А для квартиры", "apartment_breaker"],
  ["Чем можно заменить кабель КГ?", "kg_cable_replacement"],
  ["Какие наконечники нужны для кабеля 35 мм²", "cable_lug"],
  ["Есть ли у вас кабель для видеонаблюдения?", "surveillance_cable"],
  ["Есть ли светодиодные лампы с теплым светом 3000К?", "warm_led_lamp"],
  ["Нужен прожектор на улицу.", "outdoor_floodlight"],
  ["Какие прожекторы подойдут для освещения парковки?", "parking_floodlight"],
] as const;

for (const [message, profile] of cases) {
  Deno.test(`selection readiness blocks incomplete ${profile}`, () => {
    assertEquals(selectReadinessClarification(message)?.profile, profile);
  });
}

Deno.test("selection readiness allows a completed pump-cable context", () => {
  assertEquals(
    selectReadinessClarification(
      "Мне нужен кабель для насоса",
      "Насос 2 кВт, линия 35 м, 380 В три фазы, стационарно на улице",
    ),
    null,
  );
});

Deno.test("selection readiness does not block a precise floodlight search", () => {
  assertEquals(
    selectReadinessClarification("Покажите светодиодные прожекторы мощностью от 100 Вт"),
    null,
  );
});

Deno.test("explicit exploratory variants with application context may browse before exact sizing", () => {
  assertEquals(
    selectReadinessClarification("Нужен прожектор на улицу. Предложи варианты для освещения во дворе частного дома"),
    null,
  );
});

Deno.test("specific readiness profile wins over an overlapping generic profile", () => {
  assertEquals(
    selectReadinessClarification("Нужен уличный прожектор для парковки")?.profile,
    "parking_floodlight",
  );
});

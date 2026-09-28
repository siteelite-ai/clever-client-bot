import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  resolveSelectionReadinessRequest,
  measuredLoadGuidanceCanProceed,
  selectReadinessClarification,
  specifiedAvailabilityBrowseIsActionable,
} from "./selection-readiness.ts";

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

Deno.test("a measured load guidance question reaches visible reasoning before catalog readiness", () => {
  const message = "Какой автоматический выключатель мне нужен для квартиры с нагрузкой 7 кВт?";
  assertEquals(measuredLoadGuidanceCanProceed(message), true);
  assertEquals(selectReadinessClarification(message), null);
});

Deno.test("a direct catalog order with the same load remains readiness-protected", () => {
  const message = "Подбери автомат для квартиры с нагрузкой 7 кВт";
  assertEquals(measuredLoadGuidanceCanProceed(message), false);
  assertEquals(selectReadinessClarification(message)?.profile, "apartment_breaker");
});

Deno.test("a question without a measured load still receives an essential clarification", () => {
  const message = "Какой кабель подойдет для прокладки в земле?";
  assertEquals(measuredLoadGuidanceCanProceed(message), false);
  assertEquals(selectReadinessClarification(message)?.profile, "underground_cable");
});

Deno.test("specified availability browse proceeds without optional preference questions", () => {
  const message = "Есть ли светодиодные лампы с теплым светом 3000К? на цоколь Е27";
  assertEquals(specifiedAvailabilityBrowseIsActionable(message), true);
  assertEquals(selectReadinessClarification(message), null);
});

Deno.test("compatibility browse remains blocked despite several measurements", () => {
  const message = "Есть ли кабель для насоса 2 кВт, длина 35 м?";
  assertEquals(specifiedAvailabilityBrowseIsActionable(message), false);
  assertEquals(selectReadinessClarification(message)?.profile, "pump_cable");
});

Deno.test("selection readiness does not block a precise floodlight search", () => {
  assertEquals(
    selectReadinessClarification("Покажите светодиодные прожекторы мощностью от 100 Вт"),
    null,
  );
});

Deno.test("asking for variants does not bypass missing selection parameters", () => {
  const clarification = selectReadinessClarification(
    "Нужен прожектор на улицу. Предложи варианты для освещения во дворе частного дома",
  );
  assertEquals(clarification?.profile, "outdoor_floodlight");
  assertEquals(clarification?.scope?.kind, "selection_readiness");
});

Deno.test("variant wording does not bypass readiness in another product domain", () => {
  assertEquals(
    selectReadinessClarification("Предложи варианты кабеля для насоса")?.profile,
    "pump_cable",
  );
});

Deno.test("selection readiness allows a completed outdoor-floodlight context", () => {
  assertEquals(
    selectReadinessClarification(
      "Нужен прожектор на улицу для двора площадью 120 м², высота установки 4 м",
    ),
    null,
  );
});

Deno.test("outdoor protection is derived after the customer supplies parking geometry", () => {
  assertEquals(
    selectReadinessClarification(
      "Какие прожекторы подойдут для освещения парковки?",
      "500 м², высота установки 3 м",
    ),
    null,
  );
});

Deno.test("free-form clarification answer retains the original selection request", () => {
  const original = "Нужен прожектор на улицу. Предложи варианты для освещения во дворе частного дома";
  const resolved = resolveSelectionReadinessRequest(
    "Площадь около 120 м², высота установки 4 м",
    {
      pending_clarification: {
        scope: { kind: "selection_readiness", token: original },
      },
    },
  );
  assertEquals(resolved, {
    message: `${original}\nУточнение клиента: Площадь около 120 м², высота установки 4 м`,
    scoped: true,
  });
});

Deno.test("specific readiness profile wins over an overlapping generic profile", () => {
  assertEquals(
    selectReadinessClarification("Нужен уличный прожектор для парковки")?.profile,
    "parking_floodlight",
  );
});

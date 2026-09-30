import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  resolveSelectionReadinessRequest,
  measuredLoadGuidanceCanProceed,
  selectionReadinessEvidenceFromHistory,
  selectReadinessClarification,
  specifiedAvailabilityBrowseIsActionable,
} from "./selection-readiness.ts";

const cases = [
  ["Сколько автоматов нужно поставить в щит для дома?", "electrical_distribution_plan"],
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

Deno.test("distribution-board sizing always asks for topology, power and major loads", () => {
  for (const message of [
    "Сколько автоматов нужно поставить в щит для частного дома площадью 180 квадратов?",
    "Для коттеджа 240 м² какое количество автоматов должно быть в электрощите?",
    "Щит дома: сколько УЗО и автоматов предусмотреть?",
  ]) {
    const clarification = selectReadinessClarification(message);
    assertEquals(clarification?.profile, "electrical_distribution_plan");
    assertEquals(/однофаз|трёхфаз|220|380/iu.test(clarification?.question ?? ""), true);
    assertEquals(/мощн/iu.test(clarification?.question ?? ""), true);
    assertEquals(/плит|бойлер|кот[её]л|насос|саун/iu.test(clarification?.question ?? ""), true);
  }
});

Deno.test("distribution-board sizing can proceed only after all three input groups", () => {
  assertEquals(selectReadinessClarification(
    "Сколько автоматов нужно поставить в щит для дома?",
    "Ввод 380 В трёхфазный, выделено 25 кВт, есть плита, бойлер и насос",
  ), null);
});

Deno.test("selection readiness evidence never treats assistant prompts as customer facts", () => {
  assertEquals(
    selectionReadinessEvidenceFromHistory([
      { role: "user", content: "Мне нужен кабель для насоса" },
      {
        role: "assistant",
        content: "Уточните мощность, длину, напряжение, число фаз и способ прокладки",
      },
      { role: "user", content: "7 кВт, стационарно на улице" },
    ]),
    "Мне нужен кабель для насоса\n7 кВт, стационарно на улице",
  );
});

Deno.test("progressive pump clarification asks only for customer facts still missing", () => {
  const clarification = selectReadinessClarification(
    "Мне нужен кабель для насоса\nУточнение клиента: поверхностный, стационарный, на улице, 7КВт",
    "Мне нужен кабель для насоса\nповерхностный, стационарный, на улице, 7КВт",
    { progressive: true },
  );
  assertEquals(clarification?.profile, "pump_cable");
  assertEquals(clarification?.facet_key, "supply_phase");
  assertEquals(/длин|расстоян/iu.test(clarification?.question ?? ""), true);
  assertEquals(/напряж|фаз/iu.test(clarification?.question ?? ""), true);
});

Deno.test("progressive motor clarification advances from phase to nameplate current and start", () => {
  const clarification = selectReadinessClarification(
    "Подберите автомат для двигателя асинхронный 3 кВт\nУточнение клиента: 3 фазы",
    "Подберите автомат для двигателя асинхронный 3 кВт\n3 фазы",
    { progressive: true },
  );
  assertEquals(clarification?.profile, "motor_breaker");
  assertEquals(clarification?.facet_key, "motor_start_method");
  assertEquals(/номинальн|шильдик|рабоч/iu.test(clarification?.question ?? ""), true);
  assertEquals(/пуск/iu.test(clarification?.question ?? ""), true);
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
  assertEquals(
    selectReadinessClarification(
      "Подберите варианты уличного прожектора для двора частного дома",
    )?.profile,
    "outdoor_floodlight",
  );
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

Deno.test("numeric area and mounting height satisfy outdoor-floodlight readiness without repeated nouns", () => {
  assertEquals(
    selectReadinessClarification(
      "Нужен прожектор на улицу для двора\nУточнение клиента: 35м2 и высота примерно 1,5м",
      "Нужен прожектор на улицу для двора\n35м2 и высота примерно 1,5м",
      { progressive: true },
    ),
    null,
  );
});

Deno.test("apartment breaker proceeds after current, pole count and curve are customer-provided", () => {
  assertEquals(
    selectReadinessClarification(
      "Мне нужен автоматический выключатель на 25 А для квартиры\nУточнение клиента: характеристика С, 1 полюс",
      "Мне нужен автоматический выключатель на 25 А для квартиры\nхарактеристика С, 1 полюс",
      { progressive: true },
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

Deno.test("surveillance route length satisfies the distance requirement", () => {
  assertEquals(
    selectReadinessClarification(
      "Подберите кабель для камер видеонаблюдения\nУточнение клиента: Система аналоговая, улица, длина трассы 30 м",
      "",
      { progressive: true },
    ),
    null,
  );
});

Deno.test("specific readiness profile wins over an overlapping generic profile", () => {
  assertEquals(
    selectReadinessClarification("Нужен уличный прожектор для парковки")?.profile,
    "parking_floodlight",
  );
});

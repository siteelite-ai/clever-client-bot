import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  measuredLoadGuidanceCanProceed,
  resolveScopedCatalogSelectionContinuation,
  resolveSelectionReadinessRequest,
  resolveServerIssuedSelectionReadinessPending,
  selectionReadinessEvidenceFromHistory,
  selectionReadinessScope,
  selectReadinessClarification,
  specifiedAvailabilityBrowseIsActionable,
} from "./selection-readiness.ts";

const cases = [
  [
    "Сколько автоматов нужно поставить в щит для дома?",
    "electrical_distribution_plan",
  ],
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

Deno.test("every readiness profile leaves its opening facet after a valid first chip", () => {
  for (const [message, profile] of cases) {
    const first = selectReadinessClarification(message);
    const selected = first?.options[0]?.value;
    assertEquals(Boolean(selected), true, profile);
    const next = selectReadinessClarification(
      `${message}\nУточнение клиента: ${selected}`,
      `${message}\n${selected}`,
      { progressive: true },
    );
    assertEquals(next?.facet_key === first?.facet_key, false, profile);
  }
});

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
  for (
    const message of [
      "Сколько автоматов нужно поставить в щит для частного дома площадью 180 квадратов?",
      "Для коттеджа 240 м² какое количество автоматов должно быть в электрощите?",
      "Щит дома: сколько УЗО и автоматов предусмотреть?",
    ]
  ) {
    const clarification = selectReadinessClarification(message);
    assertEquals(clarification?.profile, "electrical_distribution_plan");
    assertEquals(
      /однофаз|трёхфаз|220|380/iu.test(clarification?.question ?? ""),
      true,
    );
    assertEquals(/мощн/iu.test(clarification?.question ?? ""), true);
    assertEquals(
      /плит|бойлер|кот[её]л|насос|саун/iu.test(clarification?.question ?? ""),
      true,
    );
  }
});

Deno.test("distribution-board sizing can proceed only after all three input groups", () => {
  assertEquals(
    selectReadinessClarification(
      "Сколько автоматов нужно поставить в щит для дома?",
      "Ввод 380 В трёхфазный, выделено 25 кВт, есть плита, бойлер и насос",
    ),
    null,
  );
});

Deno.test("selection readiness evidence never treats assistant prompts as customer facts", () => {
  assertEquals(
    selectionReadinessEvidenceFromHistory([
      { role: "user", content: "Мне нужен кабель для насоса" },
      {
        role: "assistant",
        content:
          "Уточните мощность, длину, напряжение, число фаз и способ прокладки",
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
  assertEquals(
    /номинальн|шильдик|рабоч/iu.test(clarification?.question ?? ""),
    true,
  );
  assertEquals(/пуск/iu.test(clarification?.question ?? ""), true);
});

Deno.test("a measured load guidance question reaches visible reasoning before catalog readiness", () => {
  const message =
    "Какой автоматический выключатель мне нужен для квартиры с нагрузкой 7 кВт?";
  assertEquals(measuredLoadGuidanceCanProceed(message), true);
  assertEquals(selectReadinessClarification(message), null);
});

Deno.test("single-phase breaker installation questions reach measured guidance", () => {
  for (
    const message of [
      "Какой автомат поставить в однофазной квартире при нагрузке 7 кВт?",
      "Какой автомат лучше ставить в однофазной квартире при нагрузке 7 кВт?",
      "Какой автомат установить в однофазной квартире на 7 кВт?",
    ]
  ) {
    assertEquals(measuredLoadGuidanceCanProceed(message), true, message);
    assertEquals(selectReadinessClarification(message), null, message);
  }
});

Deno.test("a direct catalog order with the same load remains readiness-protected", () => {
  const message = "Подбери автомат для квартиры с нагрузкой 7 кВт";
  assertEquals(measuredLoadGuidanceCanProceed(message), false);
  assertEquals(
    selectReadinessClarification(message)?.profile,
    "apartment_breaker",
  );
});

Deno.test("catalog imperatives stay readiness-protected despite installation wording", () => {
  const message =
    "Подбери, какой автомат поставить в однофазной квартире при нагрузке 7 кВт";
  assertEquals(measuredLoadGuidanceCanProceed(message), false);
  assertEquals(
    selectReadinessClarification(message)?.profile,
    "apartment_breaker",
  );
});

Deno.test("Russian prepositions are not evidence of a breaker trip curve", () => {
  for (
    const message of [
      "Подбери автомат 25 А для однофазной квартиры в щит",
      "Подбери автомат 25 А для однофазной квартиры с нагрузкой 5 кВт",
    ]
  ) {
    assertEquals(
      selectReadinessClarification(message)?.profile,
      "apartment_breaker",
      message,
    );
  }
});

Deno.test("a question without a measured load still receives an essential clarification", () => {
  const message = "Какой кабель подойдет для прокладки в земле?";
  assertEquals(measuredLoadGuidanceCanProceed(message), false);
  assertEquals(
    selectReadinessClarification(message)?.profile,
    "underground_cable",
  );
});

Deno.test("bare power does not newly bypass non-breaker compatibility readiness", () => {
  const message = "Какой кабель нужен для насоса 7 кВт?";
  assertEquals(measuredLoadGuidanceCanProceed(message), false);
  assertEquals(selectReadinessClarification(message)?.profile, "pump_cable");
});

Deno.test("specified availability browse proceeds without optional preference questions", () => {
  const message =
    "Есть ли светодиодные лампы с теплым светом 3000К? на цоколь Е27";
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
    selectReadinessClarification(
      "Покажите светодиодные прожекторы мощностью от 100 Вт",
    ),
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
    selectReadinessClarification("Предложи варианты кабеля для насоса")
      ?.profile,
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
  assertEquals(
    selectReadinessClarification(
      "Подбери автомат C25 1P для квартиры",
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
  const original =
    "Нужен прожектор на улицу. Предложи варианты для освещения во дворе частного дома";
  const resolved = resolveSelectionReadinessRequest(
    "Площадь около 120 м², высота установки 4 м",
    {
      pending_clarification: {
        scope: { kind: "selection_readiness", token: original },
      },
    },
  );
  assertEquals(resolved, {
    message:
      `${original}\nУточнение клиента: Площадь около 120 м², высота установки 4 м`,
    scoped: true,
  });
});

Deno.test("a new-task boundary never concatenates the pending readiness request", () => {
  const current = "Найди самый дешёвый кабель ВВГ 3*1,5";
  assertEquals(
    resolveSelectionReadinessRequest(current, {
      pending_clarification: {
        scope: selectionReadinessScope("Мне нужен кабель для насоса"),
      },
    }, { newTaskBoundary: true }),
    { message: current, scoped: false },
  );
});

const issuedReadinessSlot = {
  status: "pending",
  slot_id: "readiness-slot-1",
  facet_key: "supply_phase",
  question: "Какое питание у насоса?",
  options: [{ value: "220 В, 1 фаза", label: "220 В, 1 фаза" }],
  scope: selectionReadinessScope("Мне нужен кабель для насоса"),
};
const completedReadinessLog = {
  session_id: "session-original",
  error: null,
  response_events: [
    {
      type: "slot_update",
      slots: { pending_clarification: issuedReadinessSlot },
    },
    { type: "diagnostic", phase: "complete" },
    { type: "done" },
  ],
};

Deno.test("readiness scope is trusted only when the last completed server response issued it", () => {
  assertEquals(
    resolveServerIssuedSelectionReadinessPending(
      { pending_clarification: issuedReadinessSlot },
      completedReadinessLog,
      "session-original",
    ),
    issuedReadinessSlot,
  );
  assertEquals(
    resolveServerIssuedSelectionReadinessPending(
      { pending_clarification: issuedReadinessSlot },
      {
        ...completedReadinessLog,
        response_events: [
          {
            type: "conversation_boundary",
            mode: "new_task",
            session_id: "session-rotated",
          },
          ...completedReadinessLog.response_events,
        ],
      },
      "session-rotated",
    ),
    issuedReadinessSlot,
  );
});

Deno.test("forged, stale and incomplete readiness scopes fail closed", () => {
  const client = { pending_clarification: issuedReadinessSlot };
  for (
    const forged of [
      { ...issuedReadinessSlot, slot_id: "forged-slot" },
      {
        ...issuedReadinessSlot,
        scope: selectionReadinessScope("Подберите прожектор для парковки"),
      },
      { ...issuedReadinessSlot, facet_key: "forged-facet" },
      { ...issuedReadinessSlot, status: "resolved" },
    ]
  ) {
    assertEquals(
      resolveServerIssuedSelectionReadinessPending(
        { pending_clarification: forged },
        completedReadinessLog,
        "session-original",
      ),
      null,
    );
  }
  assertEquals(
    resolveServerIssuedSelectionReadinessPending(
      client,
      completedReadinessLog,
      "stale-session",
    ),
    null,
  );
  for (
    const response_events of [
      completedReadinessLog.response_events.slice(0, 2),
      completedReadinessLog.response_events.filter((event) =>
        event.type !== "diagnostic"
      ),
      [
        ...completedReadinessLog.response_events,
        { type: "slot_update", slots: {} },
      ],
    ]
  ) {
    assertEquals(
      resolveServerIssuedSelectionReadinessPending(
        client,
        { ...completedReadinessLog, response_events },
        "session-original",
      ),
      null,
    );
  }
  assertEquals(
    resolveServerIssuedSelectionReadinessPending(
      client,
      { ...completedReadinessLog, error: "in_progress" },
      "session-original",
    ),
    null,
  );
});

Deno.test("catalog clarification preserves its server-proven category for a terse continuation", () => {
  const original = "Подберите аналог Schneider Electric Acti9 C16";
  const slots = {
    pending_clarification: {
      question: "Уточните количество полюсов",
      facet_key: "poles",
      options: ["1", "2", "3"],
      scope: selectionReadinessScope(original, {
        resolved_category: "Автоматические выключатели",
      }),
    },
  };
  assertEquals(
    resolveScopedCatalogSelectionContinuation(
      "Однополюсный, покажи варианты из каталога",
      slots,
    ),
    {
      message:
        `${original}\nУточнение клиента: Однополюсный, покажи варианты из каталога`,
      category: "Автоматические выключатели",
    },
  );
  assertEquals(
    resolveScopedCatalogSelectionContinuation("Однополюсный", {
      pending_clarification: {
        scope: selectionReadinessScope(original),
      },
    }),
    null,
  );
});

Deno.test("surveillance route length satisfies the distance requirement", () => {
  assertEquals(
    selectReadinessClarification(
      "Подберите кабель для камер видеонаблюдения\nУточнение клиента: Система аналоговая, улица, отдельное питание, длина трассы 30 м",
      "",
      { progressive: true },
    ),
    null,
  );
});

Deno.test("specific readiness profile wins over an overlapping generic profile", () => {
  assertEquals(
    selectReadinessClarification("Нужен уличный прожектор для парковки")
      ?.profile,
    "parking_floodlight",
  );
});

Deno.test("floodlight height chip advances to area instead of repeating height", () => {
  for (const request of [
    "Нужен прожектор на улицу для двора",
    "Нужен уличный прожектор для парковки",
  ]) {
    const first = selectReadinessClarification(request);
    assertEquals(first?.facet_key, "mounting_height");
    assertEquals(first?.options.length, 3);
    const next = selectReadinessClarification(
      `${request}\nУточнение клиента: До 4 м`,
      `${request}\nДо 4 м`,
      { progressive: true },
    );
    assertEquals(next?.facet_key, "illuminated_area");
    assertEquals(next?.options.length, 3);
    assertEquals(/площад/iu.test(next?.question ?? ""), true);
    assertEquals(/на какой высоте/iu.test(next?.question ?? ""), false);
    assertEquals(
      selectReadinessClarification(
        `${request}\nУточнение клиента: До 4 м\nУточнение клиента: До 50 м²`,
        `${request}\nДо 4 м\nДо 50 м²`,
        { progressive: true },
      ),
      null,
    );
  }
});

Deno.test("floodlight axes require supplied dimensions, not unknown labels", () => {
  const unknownArea = selectReadinessClarification(
    "Нужен прожектор на улицу, площадь не знаю, высота установки 4 м",
  );
  assertEquals(unknownArea?.facet_key, "illuminated_area");
  const unknownHeight = selectReadinessClarification(
    "Нужен прожектор на улицу, площадь 120 м², высоту установки не знаю",
  );
  assertEquals(unknownHeight?.facet_key, "mounting_height");
  const dimensionsOnly = selectReadinessClarification(
    "Нужен прожектор на улицу для двора размером 5×5 м",
  );
  assertEquals(dimensionsOnly?.facet_key, "mounting_height");
});

Deno.test("breaker pole chip advances to curve chips", () => {
  const request = "Подбери автомат 25А для квартиры";
  const next = selectReadinessClarification(
    `${request}\nУточнение клиента: 1P`,
    `${request}\n1P`,
    { progressive: true },
  );
  assertEquals(next?.facet_key, "trip_curve");
  assertEquals(next?.options.map((o) => o.label), ["B", "C", "D"]);
  assertEquals(
    selectReadinessClarification(
      `${request}\nУточнение клиента: 1P\nУточнение клиента: Характеристика C`,
      `${request}\n1P\nХарактеристика C`,
      { progressive: true },
    ),
    null,
  );
});

Deno.test("pump phase and length chips lead to exact power rather than stale phase", () => {
  const request = "Мне нужен кабель для насоса";
  const afterPhase = selectReadinessClarification(
    `${request}\nУточнение клиента: 220 В, 1 фаза`,
    `${request}\n220 В, 1 фаза`,
    { progressive: true },
  );
  assertEquals(afterPhase?.facet_key, "line_length");
  const afterLength = selectReadinessClarification(
    `${request}\nУточнение клиента: 220 В, 1 фаза\nУточнение клиента: До 25 м`,
    `${request}\n220 В, 1 фаза\nДо 25 м`,
    { progressive: true },
  );
  assertEquals(afterLength?.facet_key, "installation_method");
  const exactPower = selectReadinessClarification(
    `${request}\nУточнение клиента: 220 В, 1 фаза\nУточнение клиента: До 25 м\nУточнение клиента: Стационарно на улице`,
    `${request}\n220 В, 1 фаза\nДо 25 м\nСтационарно на улице`,
    { progressive: true },
  );
  assertEquals(exactPower?.facet_key, "selection_requirement_0");
  assertEquals(exactPower?.options, []);
  assertEquals(/мощност|ток/iu.test(exactPower?.question ?? ""), true);
});

Deno.test("unknown engineering facts never satisfy a safety-sensitive profile", () => {
  const request =
    "Мне нужен кабель для насоса, мощность не знаю, длина не знаю, напряжение не знаю, прокладка не знаю";
  assertEquals(selectReadinessClarification(request)?.profile, "pump_cable");
  assertEquals(
    selectReadinessClarification(
      "Подберите автомат для двигателя, мощность не знаю, напряжение не знаю, условия пуска не знаю",
    )?.profile,
    "motor_breaker",
  );
  assertEquals(
    selectReadinessClarification(
      "Есть ли светодиодные лампы с теплым светом 3000К? Цоколь не знаю, форму не знаю, мощность не знаю",
    )?.profile,
    "warm_led_lamp",
  );
});

Deno.test("LED socket chip advances to form instead of repeating socket", () => {
  const request = "Подбери светодиодную лампу с теплым светом 3000К";
  const next = selectReadinessClarification(
    `${request}\nУточнение клиента: E27`,
    `${request}\nE27`,
    { progressive: true },
  );
  assertEquals(next?.facet_key, "bulb_shape");
  assertEquals(next?.options.length, 3);
});

Deno.test("LED no-preference answer advances past shape but still requires wattage", () => {
  const request = "Подбери светодиодную лампу с теплым светом 3000К";
  const afterSocket = selectReadinessClarification(
    `${request}\nУточнение клиента: E27`,
    `${request}\nE27`,
    { progressive: true },
  );
  assertEquals(afterSocket?.facet_key, "bulb_shape");

  for (const answer of ["Форма не принципиальна", "Любая форма"]) {
    const afterShape = selectReadinessClarification(
      `${request}\nУточнение клиента: E27\nУточнение клиента: ${answer}`,
      `${request}\nE27\n${answer}`,
      { progressive: true },
    );
    assertEquals(afterShape?.facet_key, "selection_requirement_2");
    assertEquals(afterShape?.options, []);
    assertEquals(selectReadinessClarification(
      `${request}\nУточнение клиента: E27\nУточнение клиента: ${answer}\nУточнение клиента: 7 Вт`,
      `${request}\nE27\n${answer}\n7 Вт`,
      { progressive: true },
    ), null);
  }

  const unrelatedPreference = selectReadinessClarification(
    `${request}\nУточнение клиента: E27\nУточнение клиента: Цвет не принципиален`,
    `${request}\nE27\nЦвет не принципиален`,
    { progressive: true },
  );
  assertEquals(unrelatedPreference?.facet_key, "bulb_shape");
});

Deno.test("terse free-form lug and surveillance facts finish their own axis", () => {
  assertEquals(
    selectReadinessClarification(
      "Какие наконечники нужны для кабеля 35 мм²\nУточнение клиента: Медь\nУточнение клиента: Под болт М8",
      "Какие наконечники нужны для кабеля 35 мм²\nМедь\nПод болт М8",
      { progressive: true },
    ),
    null,
  );
  assertEquals(
    selectReadinessClarification(
      "Подберите кабель для видеонаблюдения\nУточнение клиента: Аналоговая\nУточнение клиента: На улице\nУточнение клиента: Отдельное питание\nУточнение клиента: 30 м",
      "Подберите кабель для видеонаблюдения\nАналоговая\nНа улице\nОтдельное питание\n30 м",
      { progressive: true },
    ),
    null,
  );
});

function progressiveReadiness(request: string, ...answers: string[]) {
  const current = [request, ...answers.map((answer) =>
    `Уточнение клиента: ${answer}`)].join("\n");
  return selectReadinessClarification(
    current,
    [request, ...answers].join("\n"),
    { progressive: answers.length > 0 },
  );
}

Deno.test("lug connection chips do not hide the required bolt-hole size", () => {
  const request = "Какие наконечники нужны для кабеля 35 мм²";
  const connection = progressiveReadiness(request, "Медь");
  assertEquals(connection?.facet_key, "connection_type");
  assertEquals(connection?.options.map((option) => option.value), [
    "Под болт", "В клемму",
  ]);
  const hole = progressiveReadiness(request, "Медь", "Под болт");
  assertEquals(hole?.facet_key, "hole_size");
  assertEquals(hole?.options, []);
  assertEquals(progressiveReadiness(request, "Медь", "Под болт", "М8"), null);
  assertEquals(progressiveReadiness(request, "Медь", "В клемму"), null);
});

Deno.test("surveillance cable needs separate location, power and line length facts", () => {
  const request = "Подберите кабель для видеонаблюдения";
  const location = progressiveReadiness(request, "Цифровая/IP");
  assertEquals(location?.facet_key, "installation_location");
  assertEquals(location?.options.map((option) => option.value), [
    "На улице", "В помещении",
  ]);
  const power = progressiveReadiness(request, "Цифровая/IP", "На улице");
  assertEquals(power?.facet_key, "power_mode");
  assertEquals(power?.options.map((option) => option.value), [
    "Питание PoE", "Отдельное питание",
  ]);
  const distance = progressiveReadiness(
    request, "Цифровая/IP", "На улице", "Питание PoE",
  );
  assertEquals(distance?.facet_key, "line_length");
  assertEquals(distance?.options, []);
  assertEquals(progressiveReadiness(
    request, "Цифровая/IP", "На улице", "Питание PoE", "30 м",
  ), null);
});

Deno.test("KG mounting-mode chip cannot substitute for intended equipment", () => {
  const request = "Чем заменить кабель КГ?";
  const crossSection = progressiveReadiness(request, "Подвижное подключение");
  assertEquals(crossSection?.facet_key, "core_and_section");
  assertEquals(crossSection?.options, []);
  const purpose = progressiveReadiness(
    request, "Подвижное подключение", "3×2,5",
  );
  assertEquals(purpose?.facet_key, "usage_purpose");
  assertEquals(purpose?.options, []);
  assertEquals(progressiveReadiness(
    request, "Подвижное подключение", "3×2,5", "Для сварочного аппарата",
  ), null);
});

Deno.test("underground cable needs phase chip, load, core count and PE separately", () => {
  const request = "Какой кабель подойдет для прокладки в земле?";
  const phase = progressiveReadiness(request, "В трубе/ПНД");
  assertEquals(phase?.facet_key, "supply_phase");
  assertEquals(phase?.options.map((option) => option.value), [
    "220 В, 1 фаза", "380 В, 3 фазы",
  ]);
  const load = progressiveReadiness(request, "В трубе/ПНД", "220 В, 1 фаза");
  assertEquals(load?.facet_key, "load_power");
  assertEquals(load?.options, []);
  const cores = progressiveReadiness(
    request, "В трубе/ПНД", "220 В, 1 фаза", "5 кВт",
  );
  assertEquals(cores?.facet_key, "core_count");
  assertEquals(progressiveReadiness(
    request, "В трубе/ПНД", "220 В, 1 фаза", "5 кВт", "С заземлением",
  )?.facet_key, "core_count");
  assertEquals(progressiveReadiness(
    request, "В трубе/ПНД", "220 В, 1 фаза", "5 кВт", "3 жилы",
  )?.facet_key, "grounding_presence");
  assertEquals(progressiveReadiness(
    request, "В трубе/ПНД", "220 В, 1 фаза", "5 кВт", "С заземлением", "3 жилы",
  ), null);
});

Deno.test("floodlight cable length never masquerades as mounting height", () => {
  for (const request of [
    "Нужен прожектор на улицу для двора 100 м², кабель до розетки 10 м",
    "Нужен прожектор для парковки 300 м², расстояние до щита 20 м",
  ]) {
    const next = progressiveReadiness(request);
    assertEquals(next?.facet_key, "mounting_height");
    assertEquals(next?.options.map((option) => option.value), [
      "До 4 м", "4–8 м", "Выше 8 м",
    ]);
    assertEquals(progressiveReadiness(request, "До 4 м"), null);
  }
});

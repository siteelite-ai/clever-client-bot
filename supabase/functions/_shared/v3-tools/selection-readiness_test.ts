import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { executeProposeClarification } from "./propose-clarification.ts";
import {
  measuredLoadGuidanceCanProceed,
  resolveScopedCatalogSelectionContinuation,
  resolveSelectionReadinessRequest,
  serverIssuedClarificationSlots,
  selectionReadinessEvidenceFromHistory,
  selectionReadinessScope,
  selectReadinessAssistance,
  selectReadinessClarification,
  specifiedAvailabilityBrowseIsActionable,
} from "./selection-readiness.ts";

Deno.test("clarification recovery uses only the last completed server-issued slot", () => {
  const issued = executeProposeClarification({
    question: "Одно изделие или несколько?",
    facet_key: "system_configuration",
    options: [
      { value: "Одно изделие", label: "Одно изделие" },
      { value: "Несколько изделий", label: "Несколько изделий" },
    ],
    scope: selectionReadinessScope("Парковка 500 м², высота 3 метра", {
      resolved_category: "Прожекторы",
    }),
  });
  assertEquals(issued.ok, true);
  if (!issued.ok) return;
  const event = issued.side_effects?.find((effect) =>
    effect.type === "slot_update"
  );
  assertEquals(event?.type, "slot_update");
  if (!event || event.type !== "slot_update") return;
  const pending = event.slots.pending_clarification as Record<string, unknown>;
  const forged = { pending_clarification: {
    ...pending,
    scope: selectionReadinessScope("Другая площадь 5 м²", {
      resolved_category: "Поддельная категория",
    }),
  } };
  const events = [event, { type: "done" }];
  assertEquals(
    serverIssuedClarificationSlots(forged, events),
    { pending_clarification: pending },
  );
  assertEquals(serverIssuedClarificationSlots({ pending_clarification: {
    ...pending, slot_id: "forged",
  } }, events), {});
  assertEquals(serverIssuedClarificationSlots(forged, [
    event, { type: "slot_update", slots: {} }, { type: "done" },
  ]), {});
  assertEquals(serverIssuedClarificationSlots(forged, [event]), {});
  // The DB lookup selects only the immediately preceding row. Even if that
  // row contains an older copied event, failure/pending status cannot revive it.
  assertEquals(serverIssuedClarificationSlots(
    forged, events, "in_progress",
  ), {});
  assertEquals(serverIssuedClarificationSlots(
    forged, events, "internal_error",
  ), {});
});

Deno.test("server slot recovery preserves ordinary catalog and assortment choices", () => {
  for (const scope of [
    selectionReadinessScope("Подберите аналог C16", {
      resolved_category: "Автоматические выключатели",
    }),
    { kind: "broad_assortment", token: "Кабель для дома" },
  ]) {
    const issued = executeProposeClarification({
      question: "Какой вариант нужен?",
      facet_key: "variant",
      options: [
        { value: "Первый", label: "Первый" },
        { value: "Второй", label: "Второй" },
      ],
      scope,
    });
    assertEquals(issued.ok, true);
    if (!issued.ok) continue;
    const update = issued.side_effects?.find((effect) =>
      effect.type === "slot_update"
    );
    assertEquals(update?.type, "slot_update");
    if (!update || update.type !== "slot_update") continue;
    const submitted = { pending_clarification: update.slots.pending_clarification };
    assertEquals(serverIssuedClarificationSlots(submitted, [
      update, { type: "done" },
    ]), submitted);
    // No replay row (or a failed lookup) cannot make a browser slot trusted.
    assertEquals(serverIssuedClarificationSlots(submitted, null), {});
  }
});

Deno.test("a derived prerequisite preserves task context and helps a novice without repeating", () => {
  const original = "Нужно изделие для оборудования мощностью 3 кВт";
  const checkpoint = { version: 1 as const, args: {
    reasoning: "Общая потребность системы составляет 3000 Вт.",
    measurement_scope: "system_total",
  }, choices: [] };
  const slots = {
    pending_clarification: {
      status: "pending",
      question: "Какая схема подключения указана на оборудовании?",
      facet_key: "selection_prerequisite",
      options: [],
      scope: selectionReadinessScope(original, {
        resolved_category: "Изделия",
        reasoning_checkpoint: checkpoint,
      }),
    },
  };
  const help = selectReadinessAssistance("Не знаю", slots);
  assertEquals(help?.freeform, true);
  assertEquals(help?.scope?.token, original);
  assertEquals(help?.scope?.resolved_category, "Изделия");
  assertEquals(help?.scope?.reasoning_checkpoint, checkpoint);
  assertEquals(help?.question.includes("Не нужно угадывать"), true);
  const continuation = resolveScopedCatalogSelectionContinuation(
    "220 В, 1 фаза",
    slots,
  );
  assertEquals(continuation?.message.includes(original), true);
  assertEquals(continuation?.message.includes("220 В, 1 фаза"), true);
});

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

Deno.test("an answered installation-method option advances instead of repeating it", () => {
  const original = "Какой кабель подойдет для прокладки в земле?";
  const answer = "прямо в землю если какой кабель применяется?";
  const clarification = selectReadinessClarification(
    `${original}\nУточнение клиента: ${answer}`,
    `${original}\n${answer}`,
    { progressive: true },
  );
  assertEquals(clarification?.profile, "underground_cable");
  assertEquals(clarification?.facet_key, "supply_phase");
  assertEquals(/бронирован/iu.test(clarification?.question ?? ""), true);
  assertEquals(
    /Как планируется прокладка\?/iu.test(clarification?.question ?? ""),
    false,
  );
});

Deno.test("remaining open-ended readiness gaps do not reuse solved quick replies", () => {
  for (
    const [original, answer] of [
      ["Какие наконечники нужны для кабеля 35 мм²", "Медь"],
      ["Есть ли у вас кабель для видеонаблюдения?", "Аналоговая"],
    ]
  ) {
    const clarification = selectReadinessClarification(
      `${original}\nУточнение клиента: ${answer}`,
      `${original}\n${answer}`,
      { progressive: true },
    );
    assertEquals(clarification?.facet_key, "readiness_remaining");
    assertEquals(clarification?.freeform, true);
    assertEquals(clarification?.options, []);
    const issued = executeProposeClarification(clarification!);
    assertEquals(issued.ok, true);
    if (issued.ok) {
      assertEquals(
        (issued.side_effects ?? []).some((effect) =>
          effect.type === "quick_replies"
        ),
        false,
      );
      assertEquals(
        (issued.side_effects ?? []).some((effect) =>
          effect.type === "slot_update"
        ),
        true,
      );
    }
  }
});

Deno.test("unknown answer to a free-form gap gets bounded guidance, not the old choices", () => {
  const original = "Какие наконечники нужны для кабеля 35 мм²";
  const assistance = selectReadinessAssistance("Не знаю", {
    pending_clarification: {
      status: "pending",
      facet_key: "readiness_remaining",
      options: [],
      scope: selectionReadinessScope(original),
    },
  });
  assertEquals(assistance?.freeform, true);
  assertEquals(assistance?.options, []);
  assertEquals(/не нужно угадывать/iu.test(assistance?.question ?? ""), true);
});

Deno.test("free-form clarification is explicit and does not weaken ordinary choice validation", () => {
  assertEquals(
    executeProposeClarification({
      question: "Укажите длину линии",
      facet_key: "line_length",
      options: [],
    }).ok,
    false,
  );
  assertEquals(
    executeProposeClarification({
      question: "Укажите длину линии",
      facet_key: "line_length",
      freeform: true,
      options: [{ value: "10 м" }, { value: "20 м" }],
    }).ok,
    false,
  );
});

Deno.test("a measured load guidance question reaches visible reasoning before catalog readiness", () => {
  const message =
    "Какой автоматический выключатель мне нужен для квартиры с нагрузкой 7 кВт?";
  assertEquals(measuredLoadGuidanceCanProceed(message), true);
  assertEquals(selectReadinessClarification(message), null);
});

Deno.test("a direct catalog order with the same load remains readiness-protected", () => {
  const message = "Подбери автомат для квартиры с нагрузкой 7 кВт";
  assertEquals(measuredLoadGuidanceCanProceed(message), false);
  assertEquals(
    selectReadinessClarification(message)?.profile,
    "apartment_breaker",
  );
});

Deno.test("a question without a measured load still receives an essential clarification", () => {
  const message = "Какой кабель подойдет для прокладки в земле?";
  assertEquals(measuredLoadGuidanceCanProceed(message), false);
  assertEquals(
    selectReadinessClarification(message)?.profile,
    "underground_cable",
  );
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
});

Deno.test("a novice reply receives guided choices instead of the same readiness question", () => {
  const original =
    "Мне нужен автоматический выключатель на 25 А для квартиры. Что можете предложить?";
  const originalQuestion =
    "Номинал тока понятен. До подбора уточните полюсность/число фаз и характеристику (кривую B, C или D). Какая полюсность нужна?";
  const assistance = selectReadinessAssistance(
    "Какие есть варианты, я не очень разбираюсь",
    {
      pending_clarification: {
        status: "pending",
        question: originalQuestion,
        facet_key: "pole_count",
        options: [
          { value: "1P", label: "1P" },
          { value: "2P", label: "2P" },
          { value: "3P", label: "3P" },
        ],
        scope: selectionReadinessScope(original),
      },
    },
  );
  assertEquals(assistance?.assistance_level, 1);
  assertEquals(assistance?.facet_key, "pole_count");
  assertEquals(assistance?.question === originalQuestion, false);
  assertEquals(/1P|однофаз/iu.test(assistance?.question ?? ""), true);
  assertEquals(
    assistance?.options.map((option) => option.label),
    [
      "1P — обычная однофазная линия",
      "2P — отключать фазу и ноль",
      "3P — трёхфазная линия",
    ],
  );
});

Deno.test("readiness help is generic across product profiles and remains scoped", () => {
  const original = "Мне нужен кабель для насоса";
  const assistance = selectReadinessAssistance("Не знаю, подскажите", {
    pending_clarification: {
      status: "pending",
      question: "Какое питание у насоса?",
      facet_key: "supply_phase",
      options: [
        { value: "220 В, 1 фаза", label: "220 В, 1 фаза" },
        { value: "380 В, 3 фазы", label: "380 В, 3 фазы" },
      ],
      scope: selectionReadinessScope(original),
    },
  });
  assertEquals(assistance?.facet_key, "supply_phase");
  assertEquals(/паспорт|щит/iu.test(assistance?.question ?? ""), true);
  assertEquals(assistance?.scope?.token, original);
  // The embedded widget currently ignores quick_replies; help must remain
  // actionable using only the visible assistant text.
  for (const option of assistance?.options ?? []) {
    assertEquals(
      assistance?.question.includes(option.label ?? option.value),
      true,
    );
  }
  assertEquals(/вариант ниже/iu.test(assistance?.question ?? ""), false);
});

Deno.test("readiness assistance does not hijack an ordinary variants request", () => {
  assertEquals(
    selectReadinessAssistance("Какие есть варианты?", {}),
    null,
  );
});

Deno.test("repeated catalog request explains the live clarification and preserves numeric choices", () => {
  const slots = {
    pending_clarification: {
      status: "pending",
      question:
        "Чтобы подобрать совместимый аналог, уточните количество полюсов.",
      facet_key: "kolichestvo_polyusov__polyuster_sany",
      options: [{ value: "1" }, { value: "2" }, { value: "3" }, { value: "4" }],
      scope: selectionReadinessScope(
        "Есть ли аналог автомату Schneider Electric Acti9 C16?",
        {
          resolved_category: "Автоматические выключатели",
        },
      ),
    },
  };
  const help = selectReadinessAssistance("подбери их в каталоге", slots);
  assertEquals(help?.options.map((option) => option.value), [
    "1",
    "2",
    "3",
    "4",
  ]);
  assertEquals(help?.options[0].label, "1P — обычная однофазная линия");
  assertEquals(help?.scope?.resolved_category, "Автоматические выключатели");
  assertEquals(/маркировк/iu.test(help?.question ?? ""), true);
  assertEquals(selectReadinessAssistance("подбери их, 1 полюс", slots), null);
});

Deno.test("a second novice reply advances the bounded help ladder", () => {
  const original = "Подбери автомат 25 А для квартиры";
  const assistance = selectReadinessAssistance("Все равно не понимаю", {
    pending_clarification: {
      status: "pending",
      question: "Какая полюсность нужна?",
      facet_key: "pole_count",
      options: ["1P", "2P", "3P"],
      scope: selectionReadinessScope(original, { assistance_level: 1 }),
    },
  });
  assertEquals(assistance?.assistance_level, 2);
  assertEquals(assistance?.facet_key, "readiness_remaining");
  assertEquals(assistance?.scope?.token, original);
  assertEquals(assistance?.options, []);
  assertEquals(/Не буду повторять/iu.test(assistance?.question ?? ""), true);
  const issued = executeProposeClarification(assistance!);
  assertEquals(issued.ok, true);
  if (issued.ok) {
    const update = issued.side_effects?.find((effect) =>
      effect.type === "slot_update"
    );
    if (update?.type === "slot_update") {
      const resumed = resolveSelectionReadinessRequest("1P", update.slots);
      assertEquals(resumed.scoped, true);
      assertEquals(resumed.message.includes(original), true);
      assertEquals(resumed.message.endsWith("1P"), true);
    } else {
      throw new Error("The paused selection scope was discarded");
    }
  }
});

Deno.test("apartment breaker clarification advances from poles to curve", () => {
  const clarification = selectReadinessClarification(
    "Подбери автомат 25 А для квартиры\nУточнение клиента: 1P",
    "Подбери автомат 25 А для квартиры\n1P",
    { progressive: true },
  );
  assertEquals(clarification?.profile, "apartment_breaker");
  assertEquals(clarification?.facet_key, "trip_curve");
  assertEquals(clarification?.options.map((option) => option.value), [
    "B",
    "C",
    "D",
  ]);
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
      "Подберите кабель для камер видеонаблюдения\nУточнение клиента: Система аналоговая, улица, длина трассы 30 м",
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

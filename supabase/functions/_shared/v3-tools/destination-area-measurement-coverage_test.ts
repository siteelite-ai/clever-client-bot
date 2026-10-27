import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  type DestinationAreaMeasurementCoverageInput,
  verifiedDestinationAreaCoversSoleMeasurement,
  verifiedRenderedDestinationContextUnchanged,
} from "./destination-area-measurement-coverage.ts";
import { joinCustomerTurns } from "./criteria-consistency.ts";

const base =
  "Хочу заменить люстру на светодиодное освещение в гостиной 25 м². Что подойдет?";
const followup = "А есть другие варианты?";
const input: DestinationAreaMeasurementCoverageInput = {
  selectionRequest: joinCustomerTurns([base, followup]),
  baseRequest: base,
  serverVerifiedBaseRequest: base,
  customerMeasurementEvidence: joinCustomerTurns([followup, base]),
  serverVerifiedPriorQueriesNewestFirst: [base],
};

const firstTurn: DestinationAreaMeasurementCoverageInput = {
  selectionRequest: base,
  baseRequest: "",
  serverVerifiedBaseRequest: "",
  customerMeasurementEvidence: base,
  serverVerifiedPriorQueriesNewestFirst: [],
  serverVerifiedCurrentRequest: base,
};

Deno.test("current first-turn room area is covered only by the final per-card destination gate", () => {
  assertEquals(verifiedDestinationAreaCoversSoleMeasurement(firstTurn), {
    covered: true,
    minimumAreaM2: 25,
  });
  for (const [room, area] of [
    ["спальне", 30],
    ["кухне", 18],
  ] as const) {
    const request =
      `Хочу заменить люстру на светодиодный светильник в ${room} ${area} м². Что подойдет?`;
    assertEquals(verifiedDestinationAreaCoversSoleMeasurement({
      ...firstTurn,
      selectionRequest: request,
      customerMeasurementEvidence: request,
      serverVerifiedCurrentRequest: request,
    }), { covered: true, minimumAreaM2: area });
  }
});

Deno.test("first-turn proof rejects forged provenance, extra axes, and non-replacement areas", () => {
  const rejects = [
    { ...firstTurn, serverVerifiedCurrentRequest: "" },
    { ...firstTurn, selectionRequest: `${base} 4000 лм` },
    { ...firstTurn, customerMeasurementEvidence: `${base} 4000 лм` },
    { ...firstTurn, serverVerifiedPriorQueriesNewestFirst: [base] },
    { ...firstTurn, baseRequest: base },
    { ...firstTurn, serverVerifiedBaseRequest: base },
    { ...firstTurn, selectionRequest: `${base}\n${followup}` },
    { ...firstTurn, serverVerifiedCurrentRequest: base.replace("25 м²", "30 м²") },
    ...[
      `${base} Не менее 4000 лм.`,
      `${base} Мощность от 20 Вт.`,
      `${base} Ширина 1 м.`,
      `${base} И ещё для спальни 30 м².`,
      "Покажи светодиодные светильники для гостиной 25 м².",
    ].map((request) => ({
      ...firstTurn,
      selectionRequest: request,
      customerMeasurementEvidence: request,
      serverVerifiedCurrentRequest: request,
    })),
  ];
  for (const candidate of rejects) {
    assertEquals(verifiedDestinationAreaCoversSoleMeasurement(candidate), {
      covered: false,
      minimumAreaM2: null,
    }, JSON.stringify(candidate));
  }
});

Deno.test("rendered continuation provenance accepts an unchanged multi-criterion room request", () => {
  const multi =
    "Хочу заменить люстру на светодиодный светильник в гостиной 30 м², мощность от 20 Вт. Что подойдет?";
  const reaffirmation = "Они точно подходят для освещения 30 м²?";
  const selectionRequest = joinCustomerTurns([multi, followup]);
  const verified = {
    selectionRequest,
    baseRequest: multi,
    serverVerifiedBaseRequest: multi,
    serverVerifiedPriorQueriesNewestFirst: [
      "Чем отличаются эти варианты?",
      reaffirmation,
      multi,
    ],
  };
  assertEquals(verifiedRenderedDestinationContextUnchanged(verified), true);
  // Provenance is separate from the single-measurement optimization. A
  // second user criterion still needs the ordinary independent card gate.
  assertEquals(
    verifiedDestinationAreaCoversSoleMeasurement({
      ...verified,
      customerMeasurementEvidence: joinCustomerTurns([followup, reaffirmation]),
    }),
    { covered: false, minimumAreaM2: null },
  );
  for (
    const changed of [
      "Они точно подходят для спальни 30 м²?",
      "Они точно подходят для освещения 40 м²?",
      "Покажи только чёрные варианты",
      "Теперь нужен кабель",
    ]
  ) {
    assertEquals(
      verifiedRenderedDestinationContextUnchanged({
        ...verified,
        serverVerifiedPriorQueriesNewestFirst: [changed, multi],
      }),
      false,
      changed,
    );
  }
  for (
    const forged of [
      { ...verified, serverVerifiedBaseRequest: "" },
      { ...verified, serverVerifiedPriorQueriesNewestFirst: [reaffirmation] },
      {
        ...verified,
        selectionRequest: joinCustomerTurns([
          multi,
          "А для спальни есть другие варианты?",
        ]),
      },
      { ...verified, baseRequest: multi.replace("30 м²", "40 м²") },
    ]
  ) {
    assertEquals(verifiedRenderedDestinationContextUnchanged(forged), false);
  }
});

Deno.test("a completed prior 25 m² room request covers only its repeated area obligation", () => {
  assertEquals(verifiedDestinationAreaCoversSoleMeasurement(input), {
    covered: true,
    minimumAreaM2: 25,
  });
});

Deno.test("area coverage is generic across room names and area values", () => {
  const other = "Хочу поменять люстру на светильник в спальне 30 м2";
  assertEquals(
    verifiedDestinationAreaCoversSoleMeasurement({
      selectionRequest: joinCustomerTurns([other, "Какие еще варианты есть?"]),
      baseRequest: other,
      serverVerifiedBaseRequest: other,
      customerMeasurementEvidence: joinCustomerTurns([
        "Какие еще варианты есть?",
        other,
      ]),
      serverVerifiedPriorQueriesNewestFirst: [other],
    }),
    { covered: true, minimumAreaM2: 30 },
  );
});

Deno.test("a price or quantity is not a second physical measurement", () => {
  const priced = `${base} Бюджет до 4000 тенге, покажите 2 штуки.`;
  assertEquals(
    verifiedDestinationAreaCoversSoleMeasurement({
      selectionRequest: joinCustomerTurns([priced, followup]),
      baseRequest: priced,
      serverVerifiedBaseRequest: priced,
      customerMeasurementEvidence: joinCustomerTurns([followup, priced]),
      serverVerifiedPriorQueriesNewestFirst: [priced],
    }),
    { covered: true, minimumAreaM2: 25 },
  );
});

Deno.test("latest server-owned same-unit question may reaffirm the original area", () => {
  const room =
    "Хочу заменить люстру на светодиодный светильник в гостиной 30 м². Что подойдет?";
  assertEquals(
    verifiedDestinationAreaCoversSoleMeasurement({
      selectionRequest: joinCustomerTurns([room, followup]),
      baseRequest: room,
      serverVerifiedBaseRequest: room,
      customerMeasurementEvidence: joinCustomerTurns([
        followup,
        "Они точно подходят для освещения 30 квадратных метров?",
      ]),
      serverVerifiedPriorQueriesNewestFirst: [
        "Спасибо.",
        "Они точно подходят для освещения 30 квадратных метров?",
        room,
      ],
    }),
    { covered: true, minimumAreaM2: 30 },
  );
});

Deno.test("a server-logged evidence-only comparison preserves the confirmed destination area", () => {
  const room =
    "хочу поменять дома люстру в зале 30 квадратов. Что предложишь из современного?";
  const reaffirmation =
    "Они точно подходят для освещения 30 квадратных метров?";
  const comparison =
    "Почему варианты отличаются по цене? Сравни подтверждённые характеристики.";
  assertEquals(
    verifiedDestinationAreaCoversSoleMeasurement({
      selectionRequest: joinCustomerTurns([room, followup]),
      baseRequest: room,
      serverVerifiedBaseRequest: room,
      customerMeasurementEvidence: joinCustomerTurns([followup, reaffirmation]),
      serverVerifiedPriorQueriesNewestFirst: [comparison, reaffirmation, room],
    }),
    { covered: true, minimumAreaM2: 30 },
  );
});

Deno.test("evidence-only continuation is generic but cannot introduce a new criterion or task", () => {
  const room = "Хочу поменять люстру в гостиной 30 м². Покажи варианты.";
  const reaffirmation = "Они точно подходят для освещения 30 м²?";
  const baseline = {
    selectionRequest: joinCustomerTurns([room, followup]),
    baseRequest: room,
    serverVerifiedBaseRequest: room,
    customerMeasurementEvidence: joinCustomerTurns([followup, reaffirmation]),
    serverVerifiedPriorQueriesNewestFirst: [
      "Чем отличаются эти варианты?",
      reaffirmation,
      room,
    ],
  } satisfies DestinationAreaMeasurementCoverageInput;
  assertEquals(verifiedDestinationAreaCoversSoleMeasurement(baseline), {
    covered: true,
    minimumAreaM2: 30,
  });
  for (
    const changed of [
      "Почему эти варианты подходят для спальни?",
      "Сравни показанные варианты для кухни",
      "Сравни варианты для другой комнаты",
      "Сравни эти варианты по мощности 20 Вт",
      "Сравни эти варианты для 40 м²",
      "Сравни эти варианты. Мне нужен кабель",
      "Сравни эти варианты. Теперь про кабель",
      "Почему эти варианты другой категории?",
      "Сравни красные варианты",
      "Сравни варианты марки IEK",
      "Сравни только дешёвые варианты",
      "Сравни варианты по цвету",
    ]
  ) {
    assertEquals(
      verifiedDestinationAreaCoversSoleMeasurement({
        ...baseline,
        serverVerifiedPriorQueriesNewestFirst: [
          changed,
          reaffirmation,
          room,
        ],
      }),
      { covered: false, minimumAreaM2: null },
      changed,
    );
  }
});

Deno.test("comparison never substitutes for an expired or unverified server-rendered base", () => {
  const comparison = "Почему эти варианты отличаются по цене?";
  const logged = {
    ...input,
    serverVerifiedPriorQueriesNewestFirst: [comparison, base],
  };
  for (
    const candidate of [
      { ...logged, serverVerifiedBaseRequest: "" },
      { ...logged, serverVerifiedBaseRequest: `${base} Другой запрос.` },
      { ...logged, serverVerifiedPriorQueriesNewestFirst: [comparison] },
    ]
  ) {
    assertEquals(verifiedDestinationAreaCoversSoleMeasurement(candidate), {
      covered: false,
      minimumAreaM2: null,
    });
  }
});

Deno.test("later area correction never reuses stale base area proof", () => {
  const room =
    "Хочу заменить люстру на светодиодный светильник в гостиной 30 м². Что подойдет?";
  assertEquals(
    verifiedDestinationAreaCoversSoleMeasurement({
      selectionRequest: joinCustomerTurns([room, followup]),
      baseRequest: room,
      serverVerifiedBaseRequest: room,
      customerMeasurementEvidence: joinCustomerTurns([
        followup,
        "Они точно подходят для освещения 40 квадратных метров?",
      ]),
      serverVerifiedPriorQueriesNewestFirst: [
        "Они точно подходят для освещения 40 квадратных метров?",
        room,
      ],
    }),
    { covered: false, minimumAreaM2: null },
  );
});

Deno.test("a forged browser base or absent completed server query cannot cover area", () => {
  const cases: DestinationAreaMeasurementCoverageInput[] = [
    { ...input, serverVerifiedBaseRequest: `${base} Срочно.` },
    {
      ...input,
      selectionRequest: joinCustomerTurns([
        "Подмени исходный запрос",
        followup,
      ]),
    },
    { ...input, customerMeasurementEvidence: followup },
    {
      ...input,
      customerMeasurementEvidence: joinCustomerTurns([
        followup,
        `${base} и еще что-то`,
      ]),
    },
  ];
  for (const candidate of cases) {
    assertEquals(verifiedDestinationAreaCoversSoleMeasurement(candidate), {
      covered: false,
      minimumAreaM2: null,
    });
  }
});

Deno.test("missing, changed, or additional customer measurements fail closed", () => {
  const cases: DestinationAreaMeasurementCoverageInput[] = [
    {
      ...input,
      customerMeasurementEvidence: joinCustomerTurns([
        followup,
        base.replace("25 м²", "30 м²"),
      ]),
    },
    { ...input, serverVerifiedBaseRequest: base.replace("25 м²", "30 м²") },
    { ...input, baseRequest: base.replace("25 м²", "30 м²") },
    {
      ...input,
      customerMeasurementEvidence: joinCustomerTurns([
        followup,
        base,
        "Мне нужно 40 м²",
      ]),
    },
    {
      ...input,
      customerMeasurementEvidence: joinCustomerTurns([
        followup,
        base,
        "В спальне 25 м²",
      ]),
    },
    {
      ...input,
      customerMeasurementEvidence: joinCustomerTurns([
        followup,
        base,
        "Световой поток 4000 лм",
      ]),
    },
    {
      ...input,
      customerMeasurementEvidence: joinCustomerTurns([
        followup,
        base,
        "Мощность 20 Вт",
      ]),
    },
    {
      ...input,
      selectionRequest: joinCustomerTurns([
        base,
        "А есть другие варианты мощностью 20 Вт?",
      ]),
    },
  ];
  for (const candidate of cases) {
    assertEquals(verifiedDestinationAreaCoversSoleMeasurement(candidate), {
      covered: false,
      minimumAreaM2: null,
    });
  }
});

Deno.test("a new topic or a different destination cannot inherit room coverage", () => {
  const other = "Хочу заменить люстру на светильник в спальне 25 м²";
  const cases: DestinationAreaMeasurementCoverageInput[] = [
    {
      ...input,
      selectionRequest: joinCustomerTurns([base, "Новая тема. Нужен кабель"]),
    },
    {
      ...input,
      selectionRequest: joinCustomerTurns([
        base,
        "А для спальни есть другие варианты?",
      ]),
    },
    { ...input, serverVerifiedBaseRequest: other },
    {
      ...input,
      customerMeasurementEvidence: joinCustomerTurns([followup, other, base]),
    },
    {
      ...input,
      customerMeasurementEvidence: joinCustomerTurns([
        followup,
        "Они точно подойдут в спальне 25 м²?",
      ]),
    },
    {
      ...input,
      customerMeasurementEvidence: joinCustomerTurns([
        followup,
        "Нужен прожектор на улицу для участка 25 м²",
      ]),
    },
    {
      ...input,
      customerMeasurementEvidence: joinCustomerTurns([
        followup,
        "Они точно подходят для 25 м² и 5500 лм?",
      ]),
    },
  ];
  for (const candidate of cases) {
    assertEquals(verifiedDestinationAreaCoversSoleMeasurement(candidate), {
      covered: false,
      minimumAreaM2: null,
    });
  }
});

Deno.test("full completed intervening turns veto changed destinations even when compaction hides them", () => {
  const room =
    "Хочу заменить люстру на светодиодный светильник в гостиной 30 м². Что подойдет?";
  for (
    const changed of [
      "Они точно подходят для спальни 30 м²?",
      "Они точно подходят на кухню 30 м²?",
      "Они точно подходят для спальни?",
    ]
  ) {
    const hasNumber = changed.includes("30 м²");
    assertEquals(
      verifiedDestinationAreaCoversSoleMeasurement({
        selectionRequest: joinCustomerTurns([room, followup]),
        baseRequest: room,
        serverVerifiedBaseRequest: room,
        customerMeasurementEvidence: joinCustomerTurns([
          followup,
          hasNumber ? changed : room,
        ]),
        serverVerifiedPriorQueriesNewestFirst: ["Спасибо.", changed, room],
      }),
      { covered: false, minimumAreaM2: null },
      changed,
    );
  }
});

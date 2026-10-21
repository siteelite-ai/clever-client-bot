import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  type DestinationAreaMeasurementCoverageInput,
  verifiedDestinationAreaCoversSoleMeasurement,
} from "./destination-area-measurement-coverage.ts";

const base =
  "Хочу заменить люстру на светодиодное освещение в гостиной 25 м². Что подойдет?";
const followup = "А есть другие варианты?";
const input: DestinationAreaMeasurementCoverageInput = {
  selectionRequest: `${base}\n${followup}`,
  baseRequest: base,
  serverVerifiedBaseRequest: base,
  customerMeasurementEvidence: `${followup}\n${base}`,
  serverVerifiedPriorQueriesNewestFirst: [base],
};

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
      selectionRequest: `${other}\nКакие еще варианты есть?`,
      baseRequest: other,
      serverVerifiedBaseRequest: other,
      customerMeasurementEvidence: `Какие еще варианты есть?\n${other}`,
      serverVerifiedPriorQueriesNewestFirst: [other],
    }),
    { covered: true, minimumAreaM2: 30 },
  );
});

Deno.test("a price or quantity is not a second physical measurement", () => {
  const priced = `${base} Бюджет до 4000 тенге, покажите 2 штуки.`;
  assertEquals(
    verifiedDestinationAreaCoversSoleMeasurement({
      selectionRequest: `${priced}\n${followup}`,
      baseRequest: priced,
      serverVerifiedBaseRequest: priced,
      customerMeasurementEvidence: `${followup}\n${priced}`,
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
      selectionRequest: `${room}\n${followup}`,
      baseRequest: room,
      serverVerifiedBaseRequest: room,
      customerMeasurementEvidence:
        `${followup}\nОни точно подходят для освещения 30 квадратных метров?`,
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
      selectionRequest: `${room}\n${followup}`,
      baseRequest: room,
      serverVerifiedBaseRequest: room,
      customerMeasurementEvidence: `${followup}\n${reaffirmation}`,
      serverVerifiedPriorQueriesNewestFirst: [comparison, reaffirmation, room],
    }),
    { covered: true, minimumAreaM2: 30 },
  );
});

Deno.test("evidence-only continuation is generic but cannot introduce a new criterion or task", () => {
  const room = "Хочу поменять люстру в гостиной 30 м². Покажи варианты.";
  const reaffirmation = "Они точно подходят для освещения 30 м²?";
  const baseline = {
    selectionRequest: `${room}\n${followup}`,
    baseRequest: room,
    serverVerifiedBaseRequest: room,
    customerMeasurementEvidence: `${followup}\n${reaffirmation}`,
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
      selectionRequest: `${room}\n${followup}`,
      baseRequest: room,
      serverVerifiedBaseRequest: room,
      customerMeasurementEvidence:
        `${followup}\nОни точно подходят для освещения 40 квадратных метров?`,
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
    { ...input, selectionRequest: `Подмени исходный запрос\n${followup}` },
    { ...input, customerMeasurementEvidence: followup },
    {
      ...input,
      customerMeasurementEvidence: `${followup}\n${base} и еще что-то`,
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
      customerMeasurementEvidence: `${followup}\n${
        base.replace("25 м²", "30 м²")
      }`,
    },
    { ...input, serverVerifiedBaseRequest: base.replace("25 м²", "30 м²") },
    { ...input, baseRequest: base.replace("25 м²", "30 м²") },
    {
      ...input,
      customerMeasurementEvidence: `${followup}\n${base}\nМне нужно 40 м²`,
    },
    {
      ...input,
      customerMeasurementEvidence: `${followup}\n${base}\nВ спальне 25 м²`,
    },
    {
      ...input,
      customerMeasurementEvidence:
        `${followup}\n${base}\nСветовой поток 4000 лм`,
    },
    {
      ...input,
      customerMeasurementEvidence: `${followup}\n${base}\nМощность 20 Вт`,
    },
    {
      ...input,
      selectionRequest: `${base}\nА есть другие варианты мощностью 20 Вт?`,
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
    { ...input, selectionRequest: `${base}\nНовая тема. Нужен кабель` },
    {
      ...input,
      selectionRequest: `${base}\nА для спальни есть другие варианты?`,
    },
    { ...input, serverVerifiedBaseRequest: other },
    { ...input, customerMeasurementEvidence: `${followup}\n${other}\n${base}` },
    {
      ...input,
      customerMeasurementEvidence:
        `${followup}\nОни точно подойдут в спальне 25 м²?`,
    },
    {
      ...input,
      customerMeasurementEvidence:
        `${followup}\nНужен прожектор на улицу для участка 25 м²`,
    },
    {
      ...input,
      customerMeasurementEvidence:
        `${followup}\nОни точно подходят для 25 м² и 5500 лм?`,
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
        selectionRequest: `${room}\n${followup}`,
        baseRequest: room,
        serverVerifiedBaseRequest: room,
        customerMeasurementEvidence: `${followup}\n${
          hasNumber ? changed : room
        }`,
        serverVerifiedPriorQueriesNewestFirst: ["Спасибо.", changed, room],
      }),
      { covered: false, minimumAreaM2: null },
      changed,
    );
  }
});

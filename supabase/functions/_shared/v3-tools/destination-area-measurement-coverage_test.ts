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
    }),
    { covered: true, minimumAreaM2: 25 },
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
  ];
  for (const candidate of cases) {
    assertEquals(verifiedDestinationAreaCoversSoleMeasurement(candidate), {
      covered: false,
      minimumAreaM2: null,
    });
  }
});

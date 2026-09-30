import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  buildElectricalProtectionTripFollowupAnswer,
  ELECTRICAL_PROTECTION_TRIP_ANSWER,
  isElectricalProtectionTripDiagnostic,
  resolveElectricalProtectionTripDiagnostic,
} from "./electrical-trip-safety.ts";

Deno.test("protection-trip safety route recognizes an appliance activation incident", () => {
  assertEquals(isElectricalProtectionTripDiagnostic("У меня выбивает автомат при включении бойлера. В чем причина?"), true);
  assertEquals(isElectricalProtectionTripDiagnostic("После запуска насоса срабатывает УЗО"), true);
  assertEquals(isElectricalProtectionTripDiagnostic("Подбери автомат для бойлера"), false);
  assertEquals(isElectricalProtectionTripDiagnostic("Почему не включается светильник?"), false);
});

Deno.test("protection-trip answer covers diagnosis and a fail-safe boundary", () => {
  for (const pattern of [/мощност|ток/iu, /номинал|характеристик/iu, /коротк|контакт|провод/iu, /утеч|УЗО/iu, /не\s+увеличивайте/iu, /электрик/iu]) {
    assert(pattern.test(ELECTRICAL_PROTECTION_TRIP_ANSWER));
  }
});

Deno.test("a factual reply stays inside the prior protection-trip diagnostic", () => {
  const original = "У меня выбивает автомат при включении бойлера. В чем может быть причина?";
  assertEquals(resolveElectricalProtectionTripDiagnostic(
    "5 кВт, нет дифавтомата",
    [
      { role: "user", content: original },
      { role: "assistant", content: ELECTRICAL_PROTECTION_TRIP_ANSWER },
    ],
  ), {
    original,
    current: "5 кВт, нет дифавтомата",
    followup: true,
  });
});

Deno.test("a new product selection is never captured as a trip-diagnostic follow-up", () => {
  assertEquals(resolveElectricalProtectionTripDiagnostic(
    "Подбери автомат на 25 А",
    [{ role: "user", content: "После запуска насоса срабатывает УЗО" }],
  ), null);
});

Deno.test("trip follow-up answer uses supplied power without prescribing a breaker", () => {
  const answer = buildElectricalProtectionTripFollowupAnswer("5 кВт нет дифавтомата");
  for (const pattern of [/21[,.]7\s*А/iu, /кабел/iu, /сечен/iu, /УЗО/iu, /диф/iu, /электрик/iu]) {
    assert(pattern.test(answer));
  }
  assert(!/установите\s+автомат\s+25\s*А/iu.test(answer));
});

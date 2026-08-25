import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { ELECTRICAL_PROTECTION_TRIP_ANSWER, isElectricalProtectionTripDiagnostic } from "./electrical-trip-safety.ts";

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
